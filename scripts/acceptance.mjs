#!/usr/bin/env node
/**
 * Acceptance tests (plan §11 step 8, §13) against the DEPLOYED backend.
 * Every check names a concrete oracle; LLM nondeterminism is isolated by
 * driving the deterministic core (the bounded /skill-check route) directly.
 *
 * Needs BOTH credentials, because the backend has two auth surfaces: the
 * shared deployment key for admin/CLI routes, and a real Semantius user token
 * for creating and using sessions (minted from .env — see lib/semantius.mjs).
 *   API_TOKEN=<key> node scripts/acceptance.mjs
 *   API_TOKEN=<key> B_URL=https://... node scripts/acceptance.mjs
 *
 * OPTIONAL: SEMANTIUS_SESSION_COOKIE=<value> adds the [cookie] block — the chat
 * gate's second credential (a better-auth session cookie). Skipped with a NOTE
 * when unset, because only a signed-in browser can produce one.
 *
 * (Check ids C2-C5 keep their plan §13 numbering; C1 — "backend A is
 * OOTB/static" — retired with backend A itself.)
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sandboxNameForSession, sessionTenantPrefix, SESSION_ID_MAX } from '../core/src/index.js';
import { mintSemantiusToken } from './lib/semantius.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const B_URL = process.env.B_URL ?? 'https://semantius-copilot-backend-b.ma532.workers.dev';
const API_TOKEN = process.env.API_TOKEN;
if (!API_TOKEN) {
  console.error('API_TOKEN env var is required (the backend is behind the API-key guard).');
  process.exit(2);
}
const AUTH = { authorization: `Bearer ${API_TOKEN}` };
// A live better-auth session cookie VALUE (`<token>.<signature>`), for the
// optional [cookie] block. Nothing here can mint one — it comes from a browser
// that signed in to the Semantius app.
const SESSION_COOKIE = process.env.SEMANTIUS_SESSION_COOKIE;
// Filled in by main() before any check runs: the USER surface (session creation
// and chat) authenticates with a real Semantius token, never with AUTH.
let USER_AUTH = {};

const bundle = JSON.parse(readFileSync(join(here, '..', 'dist-bundle', 'hoth-trip-planner.agent.json'), 'utf-8'));
// Synthetic definitions (deployed under their own names each run, stable keys
// so there is no unbounded KV growth) — independent of what the real agents/
// folders currently contain.
// Zero-skill agent: skills: {} is valid.
const zeroSkillBundle = { ...bundle, agentName: 'acceptance-zero-skill', skills: {}, version: `${bundle.version.slice(0, 12)}zero` };
// No proxy_whitelist: same skills as the trip agent, must get deny-all egress.
const { proxyWhitelist: _dropped, ...noEgressBase } = bundle;
const noEgress = { ...noEgressBase, agentName: 'acceptance-no-egress', version: `${bundle.version.slice(0, 12)}noeg` };
const bundleFileCount = Object.values(bundle.skills).reduce((n, files) => n + Object.keys(files).length, 0);

let failures = 0;
let total = 0;
function check(id, name, ok, extra = '') {
  total += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${id}] ${name}${extra ? ` — ${extra}` : ''}`);
}

function uuid() { return crypto.randomUUID(); }

async function post(base, path, body) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...AUTH },
    body: JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, json };
}

async function put(base, path, body) {
  const res = await fetch(`${base}${path}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...AUTH },
    body: JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, json };
}

async function get(base, path) {
  const res = await fetch(`${base}${path}`, { headers: { ...AUTH } });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, json };
}

async function del(base, id) {
  await fetch(`${base}/sessions/${id}`, { method: 'DELETE', headers: { ...AUTH } }).catch(() => {});
}

/** POST on the USER surface — `Authorization: Bearer <org>:<jwt>`. */
async function upost(base, path, body, auth = USER_AUTH) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...auth },
    body: JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, json };
}

/**
 * Create a session on the USER surface. The route takes NO id — the backend
 * mints `<org>-<sub>-<32 hex>` from the identity it verified — so every caller
 * here reads the id back off the response.
 */
async function createSession(base, body, auth = USER_AUTH) {
  const res = await upost(base, '/sessions/agent', body, auth);
  return { ...res, id: res.json?.sessionId };
}

/** GET on the USER surface. */
async function uget(base, path, auth = USER_AUTH) {
  const res = await fetch(`${base}${path}`, { headers: { ...auth } });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, json };
}

const FIXED = { op: 'opening-times', sites: ['Echo Base Thermal Springs'], from: '2026-08-01', to: '2026-08-03' };

/** One built bundle from dist-bundle/, or null when it wasn't built. */
function readBundle(fileName) {
  try {
    return JSON.parse(readFileSync(join(here, '..', 'dist-bundle', fileName), 'utf-8'));
  } catch {
    return null;
  }
}

/** `<org>:<jwt>` -> [org, jwt] (split on the first colon only). */
function splitToken(token) {
  const i = token.indexOf(':');
  return [token.slice(0, i), token.slice(i + 1)];
}

/**
 * A live Semantius user token. REQUIRED: sessions are created on the user
 * surface now, so without one there is nothing to test — the suite stops
 * rather than reporting a wall of misleading 401s.
 */
let semantiusToken = null;

async function main() {
  console.log(`B: ${B_URL}\n`);
  semantiusToken = await mintSemantiusToken().catch((err) => {
    console.error(`a Semantius user token is required: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  });
  USER_AUTH = { authorization: `Bearer ${semantiusToken}` };
  const [tokenOrg] = splitToken(semantiusToken);

  // Health (public, no auth)
  const hb = await fetch(`${B_URL}/health`).then((r) => r.json());
  check('health', 'backend healthy', hb.ok === true, `delivery=${hb.delivery}`);

  // --- Auth: two surfaces, and neither credential works on the other -------
  const noKey = await fetch(`${B_URL}/sessions/agent`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  check('auth', 'session create rejects a request with no bearer (401)', noKey.status === 401, `status ${noKey.status}`);
  const badKey = await fetch(`${B_URL}/sessions/agent`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer wrong' }, body: '{}' });
  check('auth', 'session create rejects a junk bearer (401)', badKey.status === 401, `status ${badKey.status}`);
  // The split itself: the deployment key must NOT open the user surface, and a
  // user token must NOT open the admin surface. Either direction failing would
  // mean the two are still one gate.
  const adminKeyOnChat = await createSession(B_URL, { agentName: bundle.agentName }, AUTH);
  check('auth', 'the admin API key cannot create a session (401)', adminKeyOnChat.status === 401, `status ${adminKeyOnChat.status}`);
  const userTokenOnAdmin = await uget(B_URL, '/admin/collections');
  check('auth', 'a user token cannot browse data (401)', userTokenOnAdmin.status === 401, `status ${userTokenOnAdmin.status}`);
  const userTokenOnDeploy = await fetch(`${B_URL}/agents/acceptance-noauth`, { method: 'PUT', headers: { 'content-type': 'application/json', ...USER_AUTH }, body: JSON.stringify(bundle) });
  check('auth', 'a user token cannot deploy an agent (401)', userTokenOnDeploy.status === 401, `status ${userTokenOnDeploy.status}`);

  // --- Container costs (GET /admin/costs) ----------------------------------
  // Spend is operator data, so it sits behind the same admin gate. The response
  // is asserted for SHAPE, not for numbers: analytics lags minutes behind live
  // traffic, so a fresh account-day can legitimately be empty — but a missing
  // token must say so rather than render as $0.
  const costsNoKey = await uget(B_URL, '/admin/costs');
  check('costs', 'a user token cannot read costs (401)', costsNoKey.status === 401, `status ${costsNoKey.status}`);
  // The snapshot-task window is operator-only too: it can force a Cloudflare
  // query and a KV write, so it must never sit on the user surface.
  const snapNoKey = await uget(B_URL, '/admin/sessions/tests-user3-0000/sandbox');
  check('costs', 'a user token cannot inspect the sandbox snapshot task (401)', snapNoKey.status === 401, `status ${snapNoKey.status}`);
  const costs = await get(B_URL, '/admin/costs');
  check('costs', 'costs route answers the admin key (200)', costs.status === 200, `status ${costs.status} ${JSON.stringify(costs.json).slice(0, 200)}`);
  check(
    'costs',
    'costs are reported for the UTC day, priced in USD',
    costs.json?.currency === 'USD' && typeof costs.json?.start === 'string' && costs.json.start.endsWith('T00:00:00Z'),
    `${costs.json?.start} .. ${costs.json?.end}`,
  );
  check(
    'costs',
    'costs are either configured with rows+totals, or say why not',
    costs.json?.configured === true
      ? Array.isArray(costs.json.rows) && typeof costs.json.totals?.cost?.total === 'number'
      : typeof costs.json?.reason === 'string' && costs.json.reason.length > 0,
    costs.json?.configured ? `${costs.json.rows?.length} sessions, $${costs.json.totals?.cost?.total}` : costs.json?.reason,
  );
  // LLM spend rides in from THE session record (session_state.cost_total), so a
  // row only carries it while that record is alive. Assert the join, not a
  // count: every row that HAS an llmCost must have an agentName too, because
  // both come from the same read — one without the other means the enrichment
  // pass is broken.
  if (costs.json?.configured === true) {
    const withLlm = (costs.json.rows ?? []).filter((r) => typeof r.llmCost === 'number');
    check(
      'costs',
      'LLM cost is joined from the same session record as the agent name',
      withLlm.every((r) => typeof r.agentName === 'string'),
      `${withLlm.length}/${costs.json.rows?.length} rows carry llmCost`,
    );
    const llmSum = Math.round(withLlm.reduce((n, r) => n + r.llmCost, 0) * 1e8) / 1e8;
    check(
      'costs',
      'the LLM total is its own figure, summed from the rows and never folded into the container total',
      typeof costs.json.llmTotal === 'number' && Math.abs(costs.json.llmTotal - llmSum) < 1e-8,
      `llm $${costs.json.llmTotal} (rows sum $${llmSum}) vs container $${costs.json.totals?.cost?.total}`,
    );
  }

  // --- Named-definition deploys (PUT /agents/:name is the trust boundary) --
  const dep = await put(B_URL, `/agents/${bundle.agentName}`, bundle);
  check('deploy', 'deploys hoth-trip-planner as a named definition', dep.status === 200 && dep.json.version === bundle.version, JSON.stringify(dep.json).slice(0, 140));
  const depAgain = await put(B_URL, `/agents/${bundle.agentName}`, bundle);
  check('deploy', 'redeploying the same name overwrites (200)', depAgain.status === 200, `status ${depAgain.status}`);
  const depZero = await put(B_URL, `/agents/${zeroSkillBundle.agentName}`, zeroSkillBundle);
  check('deploy', 'deploys a zero-skill definition', depZero.status === 200, `status ${depZero.status}`);
  const depDeny = await put(B_URL, `/agents/${noEgress.agentName}`, noEgress);
  check('deploy', 'deploys a no-whitelist definition', depDeny.status === 200, `status ${depDeny.status}`);
  const depNoKey = await fetch(`${B_URL}/agents/acceptance-noauth`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(bundle) });
  check('deploy', 'deploy route rejects a missing API key (401)', depNoKey.status === 401, `status ${depNoKey.status}`);

  // --- Name-based session ingest -------------------------------------------
  const bIngest = await createSession(B_URL, { agentName: bundle.agentName });
  const bId = bIngest.id;
  check(
    'ingest',
    'name-based ingest OK (pinned to the deployed version)',
    bIngest.status === 200 &&
      bIngest.json.agentName === bundle.agentName &&
      bIngest.json.version === bundle.version &&
      bIngest.json.user?.org === tokenOrg,
    JSON.stringify(bIngest.json).slice(0, 160),
  );

  // --- Session ids are SERVER-MINTED and tenant-prefixed -------------------
  // The route takes no id at all, so the tenant in the key space is a fact
  // about the verified token rather than a claim the client typed. The shape
  // also has to stay inside the sandbox SDK's 63-char sanitizeSandboxId limit
  // and its DNS-label rules — a violation surfaces as a broken container, not
  // as a validation error, so it is asserted here.
  const bSub = bIngest.json.user?.sub;
  check(
    'session-id',
    'ingest mints the session id (route takes none)',
    typeof bId === 'string' && bId.length > 0 && bId.length <= SESSION_ID_MAX,
    `${bId} (${String(bId).length} chars)`,
  );
  check(
    'session-id',
    'minted id carries the tenant prefix <org>-<sub>-',
    typeof bId === 'string' && bId.startsWith(`${sessionTenantPrefix(tokenOrg, bSub)}`),
    `${bId} vs prefix ${sessionTenantPrefix(tokenOrg, bSub)}`,
  );
  check(
    'session-id',
    'the SANDBOX name derived from the id (org + tail, user dropped) is a legal DNS label',
    /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(sandboxNameForSession(String(bId))),
    sandboxNameForSession(String(bId)),
  );

  // --- GET /sessions: the caller's own session index -----------------------
  // The tenant-prefix listing in action: the session just created must appear,
  // entries must be the whitelisted meta ONLY (the record also carries
  // session_context.semantius_jwt — and, once the secret-retrieval layer
  // lands, egress_secrets — neither may ever reach a browser), and the route
  // is a user surface (401 without a credential).
  const mine = await uget(B_URL, '/sessions');
  check('sessions', 'GET /sessions answers a user token (200)', mine.status === 200, `status ${mine.status}`);
  check(
    'sessions',
    'lists the session just created',
    Array.isArray(mine.json?.sessions) && mine.json.sessions.some((s) => s.id === bId),
    `${mine.json?.sessions?.length ?? 0} entries`,
  );
  check(
    'sessions',
    'entries carry whitelisted fields only (no session_context / egress_secrets)',
    (mine.json?.sessions ?? []).every((s) => s.session_context === undefined && s.egress_secrets === undefined),
  );
  check(
    'sessions',
    'the answer names the identity it was scoped to',
    typeof mine.json?.user?.sub === 'string' && mine.json.user.sub.length > 0,
    JSON.stringify(mine.json?.user ?? null).slice(0, 120),
  );
  const sessionsNoAuth = await fetch(`${B_URL}/sessions`);
  check('sessions', 'GET /sessions rejects a request with no bearer (401)', sessionsNoAuth.status === 401, `status ${sessionsNoAuth.status}`);

  // --- Clean-base positive control: the live sandbox now has the file set --
  // (also the reconstruction proof — the ingest response deliberately carries
  // no provisioning internals, the deterministic file count here is the oracle)
  const bCount = await post(B_URL, `/sessions/${bId}/skill-check`, { op: 'count-skill-files' });
  const bFileCount = Number((bCount.json.stdout ?? '').trim());
  check('clean-base', 'live sandbox has expected file count after injection', bFileCount === bundleFileCount, `count=${bFileCount}`);

  // --- Zero-skill agent: valid bundle, nothing to reconstruct -------------
  const zIngest = await createSession(B_URL, { agentName: zeroSkillBundle.agentName });
  const zId = zIngest.id;
  check('zero-skill', 'ingests a zero-skill agent', zIngest.status === 200 && zIngest.json.agentName === zeroSkillBundle.agentName, JSON.stringify(zIngest.json).slice(0, 140));
  const zCount = await post(B_URL, `/sessions/${zId}/skill-check`, { op: 'count-skill-files' });
  check('zero-skill', 'zero-skill session sandbox holds no skill files', Number((zCount.json.stdout ?? '').trim()) === 0, `count=${(zCount.json.stdout ?? '').trim()}`);

  // --- Per-agent egress: an agent WITHOUT proxy_whitelist gets deny-all -----
  // The opening-times call to the echo host must be rejected by the outbound
  // handler (fail closed).
  const dIngest = await createSession(B_URL, { agentName: noEgress.agentName });
  const dId = dIngest.id;
  check('egress', 'ingests an agent without proxy_whitelist', dIngest.status === 200, `status ${dIngest.status}`);
  const dRun = await post(B_URL, `/sessions/${dId}/skill-check`, FIXED);
  const dOut = dRun.json.stdout ?? '';
  check(
    'egress',
    'egress is deny-all for an agent without proxy_whitelist',
    /403|egress denied/.test(dOut) || dRun.json.exitCode !== 0,
    snippet(dOut),
  );

  // --- C3: single source of truth — reconstructed files == bundle bytes ----
  // hash-skill cds into the planner skill dir, so expected keys are ./<rel>
  // over the planner skill's files.
  const bundleHashes = {};
  for (const [rel, content] of Object.entries(bundle.skills.planner)) {
    bundleHashes[`./${rel}`] = createHash('sha256').update(content).digest('hex');
  }
  const bHash = await post(B_URL, `/sessions/${bId}/skill-check`, { op: 'hash-skill' });
  const parseHashes = (stdout) => Object.fromEntries((stdout ?? '').trim().split('\n').filter(Boolean).map((line) => {
    const [h, p] = line.trim().split(/\s+/);
    return [p, h];
  }));
  const bHashes = parseHashes(bHash.json.stdout);
  check('C3', 'live sandbox hashes == bundle (byte-identical skill)', JSON.stringify(sorted(bHashes)) === JSON.stringify(sorted(bundleHashes)));

  // --- C4: fail-closed pending secret retrieval ---------------------------
  // The server no longer mints downstream credentials (they were placeholder
  // values generated in Worker code — removed; a secret-retrieval layer will
  // populate `egress_secrets` from stored secret REFERENCES, see the TODO in
  // backend-b/src/app.ts). With no map entry the echo host is
  // credential-REQUIRED but credential-less, so the skill's API call must be
  // rejected at egress (403 from injectAndForward), never forwarded
  // unauthenticated. When retrieval exists, C4 reverts to asserting the
  // injected credential reaches the upstream while the container sends none.
  const bRun = await post(B_URL, `/sessions/${bId}/skill-check`, FIXED);
  check(
    'C4',
    'opening-times.js egress fails closed without a retrieved credential (HTTP 403, non-zero exit)',
    bRun.json.exitCode !== 0 && /403/.test(bRun.json.stdout ?? ''),
    snippet(bRun.json.stdout ?? ''),
  );

  // --- Per-process TLS trust: curl (system CA path, via the baked
  //     CURL_CA_BUNDLE/SSL_CERT_FILE) completes the HTTPS handshake with the
  //     interceptor for the whitelisted echo host. The proxy then answers 403
  //     (credential-required host, no retrieved credential) — receiving that
  //     status at all proves the TLS interception path from curl; a broken CA
  //     trust would surface as curl exit error / 000, not an HTTP status.
  const bCurl = await post(B_URL, `/sessions/${bId}/skill-check`, { op: 'curl-check' });
  check('curl-tls', 'curl completes HTTPS via interceptor CA (proxy answers 403)', (bCurl.json.stdout ?? '').trim() === '403', `got ${(bCurl.json.stdout ?? '').trim() || bCurl.json.stderr}`);

  // --- C2: concurrent sessions of one user, both fail-closed ---------------
  // (The former different-credentials-per-session and x-semantius-org checks
  // asserted properties of injected credentials; they return with the
  // retrieval layer. b2Id is still needed by the C5 id checks below.)
  const b2Id = (await createSession(B_URL, { agentName: bundle.agentName })).id;
  const [b1e, b2e] = await Promise.all([
    post(B_URL, `/sessions/${bId}/skill-check`, { ...FIXED, debugEcho: true }),
    post(B_URL, `/sessions/${b2Id}/skill-check`, { ...FIXED, debugEcho: true }),
  ]);
  check(
    'C2',
    'both concurrent sessions fail closed at egress (no credential to differ by yet)',
    b1e.json.exitCode !== 0 && /403/.test(b1e.json.stdout ?? '') && b2e.json.exitCode !== 0 && /403/.test(b2e.json.stdout ?? ''),
    `${snippet(b1e.json.stdout ?? '')} / ${snippet(b2e.json.stdout ?? '')}`,
  );

  // --- C5: immutable-per-id, now BY CONSTRUCTION ---------------------------
  // The old check posted a session id twice and expected 409. That path is gone
  // with client-supplied ids: the route mints one per create, so the property to
  // prove is that two creates by the SAME user never collide — a repeated id
  // would silently rebind one session's container and egress secrets to another.
  check(
    'C5',
    'repeated creates by one user mint distinct session ids',
    typeof bId === 'string' && typeof b2Id === 'string' && bId !== b2Id,
    `${bId} / ${b2Id}`,
  );
  check(
    'C5',
    'both ids share the tenant prefix, differ only in the random tail',
    String(b2Id).startsWith(sessionTenantPrefix(tokenOrg, bSub)) &&
      String(bId).slice(sessionTenantPrefix(tokenOrg, bSub).length) !==
        String(b2Id).slice(sessionTenantPrefix(tokenOrg, bSub).length),
    sessionTenantPrefix(tokenOrg, bSub),
  );

  // --- C5: fail-closed egress — a session whose egress policy is gone -----
  // Creation is storage-only now (no pre-warm), so land the skill files on
  // the container's disk explicitly via the skill-check route (the same
  // absent→write provisioning a real turn runs lazily); DELETE then removes
  // the egress policy (pointer + record) + bundle. The warm container still
  // holds the files, so the skill RUNS — but its egress must be rejected (no
  // policy). Without the warm-up this check would pass vacuously: no files,
  // non-zero exit, nothing about egress proven.
  const orphanId = (await createSession(B_URL, { agentName: bundle.agentName })).id;
  await post(B_URL, `/sessions/${orphanId}/skill-check`, { op: 'count-skill-files' });
  await del(B_URL, orphanId); // removes egress policy + bundle snapshot
  const orphanRun = await post(B_URL, `/sessions/${orphanId}/skill-check`, { ...FIXED, debugEcho: true });
  const orphanOut = orphanRun.json.stdout ?? '';
  check('C5', 'egress fails closed without an egress policy (403 from proxy)', /403|egress denied/.test(orphanOut) || orphanRun.json.exitCode !== 0, snippet(orphanOut));

  // --- session_context / session record: written at ingest, removed on DELETE
  // THE session record (session:<id>) carries meta + whitelist +
  // session_context in ONE document (plus egress_secrets once the
  // secret-retrieval layer populates it); the container:<containerId> pointer is
  // the only containerId-keyed entry. containerId is stored nowhere (it is
  // derivable in the Worker), so the pointer is located by scanning the
  // container group for the value === session id. Admin API shape: parsed
  // value under .json, raw string under .value.
  // No credential travels in the body any more: the bearer IS the user's token.
  // Whatever opaque context the client sends is kept, but the identity and the
  // JWT come only from the verified bearer.
  const ctxProbe = `client-supplied-${uuid().slice(0, 8)}`;
  const ctxIngest = await createSession(B_URL, {
    agentName: bundle.agentName,
    sessionContext: {
      probe: ctxProbe,
      // Reserved identity keys a caller must never be able to set.
      semantius_org: 'attacker-org',
      semantius_user: 'attacker-sub',
    },
  });
  const ctxId = ctxIngest.id;
  check('context', 'ingest accepts sessionContext (200)', ctxIngest.status === 200, `status ${ctxIngest.status}`);
  const ctxRecord = await get(B_URL, `/admin/collections/kv/record?id=session:${ctxId}`);
  const ctxStored = ctxRecord.json?.json?.session_context ?? {};
  check(
    'context',
    'session record carries the client context and whitelist in one document',
    ctxRecord.status === 200 &&
      ctxStored.probe === ctxProbe &&
      Array.isArray(ctxRecord.json?.json?.whitelist),
    JSON.stringify(ctxRecord.json?.json ?? ctxRecord.json).slice(0, 140),
  );
  // No server-generated credential of any shape on a fresh record: the old
  // single `bearer` field is gone, and `egress_secrets` stays absent until
  // the secret-retrieval layer (TODO in app.ts's ingest route) populates it.
  check(
    'context',
    'no server-generated downstream credential on the record (bearer gone, egress_secrets absent)',
    ctxRecord.json?.json?.bearer === undefined && ctxRecord.json?.json?.egress_secrets === undefined,
    JSON.stringify(ctxRecord.json?.json?.egress_secrets ?? null).slice(0, 120),
  );
  {
    // The org prefix is a transport convention, not part of the credential:
    // the record must hold the BARE jwt (what egress injects) beside the org.
    const [ctxOrg, ctxBareJwt] = splitToken(semantiusToken);
    check(
      'identity',
      'ingest splits <org>:<jwt> — record stores the bare JWT + its org',
      ctxStored.semantius_jwt === ctxBareJwt && ctxStored.semantius_org === ctxOrg,
      JSON.stringify({ semantius_org: ctxStored.semantius_org, prefixed: String(ctxStored.semantius_jwt).startsWith(`${ctxOrg}:`) }),
    );
    check(
      'identity',
      'session_context.user is the owner resolved from the org userinfo endpoint',
      typeof ctxIngest.json?.user?.sub === 'string' &&
        ctxIngest.json.user.org === ctxOrg &&
        ctxStored.user?.sub === ctxIngest.json.user.sub,
      JSON.stringify(ctxStored.user ?? null).slice(0, 140),
    );
    check(
      'identity',
      'session_context carries semantius_org + semantius_user (the token\'s org and sub), body values ignored',
      ctxStored.semantius_org === ctxOrg && ctxStored.semantius_user === ctxIngest.json?.user?.sub,
      JSON.stringify({ semantius_org: ctxStored.semantius_org, semantius_user: ctxStored.semantius_user }),
    );
    check(
      'identity',
      'the record holds NO invented tenant field beside it',
      ctxRecord.json?.json?.tenantTag === undefined,
      String(ctxRecord.json?.json?.tenantTag),
    );
    const okChat = await uget(B_URL, `/agents/main/${ctxId}?view=history`);
    check('identity', 'the owner may open their own session', okChat.status !== 401 && okChat.status !== 403, `status ${okChat.status}`);
  }
  const ctxContainerId = ctxRecord.json?.json?.containerId;
  check('context', 'session record stores containerId', typeof ctxContainerId === 'string' && ctxContainerId.length === 64, String(ctxContainerId).slice(0, 24));
  const ctxPointerKey = `container:${ctxContainerId}`;
  const ctxPointer = await get(B_URL, `/admin/collections/kv/record?id=${ctxPointerKey}`);
  check(
    'context',
    'container pointer maps back to the session id',
    ctxPointer.status === 200 && ctxPointer.json?.value === ctxId,
    String(ctxPointer.json?.value ?? ctxPointer.status).slice(0, 60),
  );
  const ctxBadShape = await createSession(B_URL, { agentName: bundle.agentName, sessionContext: 'not-an-object' });
  check('context', 'rejects a non-object sessionContext (422)', ctxBadShape.status === 422, `status ${ctxBadShape.status}`);
  const ctxTooBig = await createSession(B_URL, { agentName: bundle.agentName, sessionContext: { blob: 'x'.repeat(9000) } });
  check('context', 'rejects an oversize sessionContext (422)', ctxTooBig.status === 422, `status ${ctxTooBig.status}`);
  await del(B_URL, ctxId);
  const ctxGoneRecord = await get(B_URL, `/admin/collections/kv/record?id=session:${ctxId}`);
  check('context', 'session record removed by DELETE /sessions/:id (404)', ctxGoneRecord.status === 404, `status ${ctxGoneRecord.status}`);
  const ctxGonePointer = await get(B_URL, `/admin/collections/kv/record?id=${ctxPointerKey}`);
  check('context', 'container pointer removed by DELETE /sessions/:id (404)', ctxGonePointer.status === 404, `status ${ctxGonePointer.status}`);

  // --- Identity gate: the token is the bearer, on every request ------------
  // Both routes of the user surface verify it live against
  // <org>.semantius.cloud, so an invented token opens nothing.
  const badTokens = [
    ['no <org>: prefix', 'eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ4In0.c2ln'],
    ['org present, JWT the issuer rejects', `${tokenOrg}:eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ4In0.c2ln`],
    ['unknown org', 'acceptance-no-such-org:eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ4In0.c2ln'],
    ['not a token at all', `${tokenOrg}:hello`],
  ];
  for (const [label, token] of badTokens) {
    const auth = { authorization: `Bearer ${token}` };
    const created = await createSession(B_URL, { agentName: bundle.agentName }, auth);
    check('identity', `session create rejects an invalid token — ${label} (401)`, created.status === 401, `status ${created.status}`);
    const chatted = await uget(B_URL, `/agents/main/${ctxId}?view=history`, auth);
    check('identity', `chat rejects an invalid token — ${label} (401)`, chatted.status === 401, `status ${chatted.status}`);
  }
  // A valid token is not a skeleton key: it opens sessions this user owns, and
  // nothing else. (bId belongs to the same user here — one account is all the
  // suite has — so the cross-user 403 is exercised by the unknown-id case.)
  const noBearer = await fetch(`${B_URL}/agents/main/${bId}?view=history`);
  check('identity', 'chat rejects a request with no bearer at all (401)', noBearer.status === 401, `status ${noBearer.status}`);
  const adminOnChat = await uget(B_URL, `/agents/main/${bId}?view=history`, AUTH);
  check('identity', 'chat rejects the admin API key (401)', adminOnChat.status === 401, `status ${adminOnChat.status}`);
  const ghostRead = await uget(B_URL, `/agents/main/${uuid()}?view=history`);
  check('identity', 'chat rejects an unknown conversation id (401)', ghostRead.status === 401, `status ${ghostRead.status}`);

  // --- The chat gate's second credential: a better-auth session cookie -----
  // Bearer FIRST, cookie only when there is no bearer. The cookie is validated
  // upstream by GET /session and exchanged for a JWT by POST /session/token, so
  // a cookie session is indistinguishable downstream from a bearer one: same
  // verdict shape, same tenant-prefixed id, same ownership gate. Requires a
  // live cookie, which nothing here can mint.
  if (SESSION_COOKIE) {
    const cookieHeader = { 'x-better-auth-cookie': SESSION_COOKIE };
    const realCookieHeader = { cookie: `__Secure-better-auth.session_token=${SESSION_COOKIE}` };

    const cookieIngest = await createSession(B_URL, { agentName: bundle.agentName }, cookieHeader);
    check('cookie', 'session create accepts the x-better-auth-cookie header (200)', cookieIngest.status === 200, `status ${cookieIngest.status} ${JSON.stringify(cookieIngest.json?.error ?? '')}`);
    const cookieUser = cookieIngest.json?.user;
    check(
      'cookie',
      'the verified user comes back with org + sub, like the bearer path',
      typeof cookieUser?.org === 'string' && typeof cookieUser?.sub === 'string',
      JSON.stringify(cookieUser),
    );
    check(
      'cookie',
      'the minted id carries the COOKIE session\'s tenant, not the token\'s',
      typeof cookieIngest.id === 'string' && cookieIngest.id.startsWith(sessionTenantPrefix(cookieUser?.org ?? '', cookieUser?.sub ?? '')),
      cookieIngest.id,
    );

    const cookieChat = await uget(B_URL, `/agents/main/${cookieIngest.id}?view=history`, cookieHeader);
    check('cookie', 'the same cookie opens the conversation it created (200)', cookieChat.status === 200, `status ${cookieChat.status}`);

    // The documented server-to-server form must work too, and must resolve to
    // the SAME user — otherwise the two transports are two identities.
    const realCookieIngest = await createSession(B_URL, { agentName: bundle.agentName }, realCookieHeader);
    check('cookie', 'session create accepts a real Cookie header (200)', realCookieIngest.status === 200, `status ${realCookieIngest.status}`);
    check(
      'cookie',
      'both cookie transports resolve to one identity',
      realCookieIngest.json?.user?.sub === cookieUser?.sub && realCookieIngest.json?.user?.org === cookieUser?.org,
    );

    // A cookie is a credential, not a bypass.
    const junkCookie = await createSession(B_URL, { agentName: bundle.agentName }, { 'x-better-auth-cookie': 'not.a-real-session' });
    check('cookie', 'an invalid cookie is rejected (401)', junkCookie.status === 401, `status ${junkCookie.status}`);

    // Priority: a VALID cookie beside an INVALID bearer must still 401 — if the
    // cookie were consulted first (or as a fallback after the bearer failed),
    // this would succeed and the documented precedence would be a lie.
    const both = await createSession(B_URL, { agentName: bundle.agentName }, { ...cookieHeader, authorization: 'Bearer nope:nope' });
    check('cookie', 'the bearer wins when both are sent (invalid bearer + valid cookie -> 401)', both.status === 401, `status ${both.status}`);

    // The cookie's own conversation is not open to a stranger's credential.
    const bearerOnCookieSession = await uget(B_URL, `/agents/main/${cookieIngest.id}?view=history`);
    check(
      'cookie',
      'the ownership gate still applies to a cookie-created session',
      bearerOnCookieSession.status === 200 || bearerOnCookieSession.status === 403,
      `status ${bearerOnCookieSession.status} (200 only if the token and the cookie are the same user)`,
    );

    await del(B_URL, cookieIngest.id);
    await del(B_URL, realCookieIngest.id);
  } else {
    console.log('NOTE  [cookie] skipped — set SEMANTIUS_SESSION_COOKIE=<value> to exercise better-auth cookie auth');
  }

  // --- Sandbox credentials: the CLI acts AS the session user ---------------
  // The container gets no API key at all: SEMANTIUS_ORG comes from the token's
  // `<org>` half (per session — the image bakes none), and SEMANTIUS_JWT holds
  // only the sentinel, swapped for the user's JWT at egress. Needs the
  // semantius-admin definition, whose proxy_whitelist covers *.semantius.ai.
  const semantiusBundle = readBundle('semantius-admin.agent.json');
  if (semantiusBundle) {
    const credOrg = tokenOrg;
    await put(B_URL, `/agents/${semantiusBundle.agentName}`, semantiusBundle);
    const credIngest = await createSession(B_URL, { agentName: semantiusBundle.agentName });
    const credId = credIngest.id;
    check('credentials', 'ingests a semantius session with a verified user', credIngest.status === 200, `status ${credIngest.status}`);
    const envOut = (await post(B_URL, `/sessions/${credId}/skill-check`, { op: 'semantius-env' })).json?.stdout ?? '';
    check(
      'credentials',
      'container holds the JWT sentinel + the token\'s org, and NO api key',
      envOut.includes('SEMANTIUS_JWT=__sak__') &&
        envOut.includes(`SEMANTIUS_ORG=${credOrg}`) &&
        !envOut.includes('SEMANTIUS_API_KEY='),
      // Report only the container-env half — the op also prints the vars the
      // CLI's own help documents, which legitimately still names the API key.
      envOut.split('--- cli honors ---')[0].split('\n').filter((l) => l.startsWith('SEMANTIUS_')).join(' ').slice(0, 120),
    );
    const whoami = (await post(B_URL, `/sessions/${credId}/skill-check`, { op: 'semantius-whoami' })).json?.stdout ?? '';
    const expectedEmail = credIngest.json?.user?.email;
    check(
      'credentials',
      'semantius CLI authenticates as the session user (sentinel swapped for their JWT)',
      typeof expectedEmail === 'string' &&
        whoami.includes(expectedEmail) &&
        new RegExp(`^org\\s+${credOrg}$`, 'm').test(whoami),
      whoami.replace(/\s+/g, ' ').slice(0, 160),
    );
    await del(B_URL, credId);
  } else if (!semantiusBundle) {
    console.log('NOTE  [credentials] skipped — dist-bundle/semantius-admin.agent.json missing (run pnpm bundle)');
  }

  // --- Hostile bundles rejected at the deploy trust boundary (plan §13) ---
  // Validation moved with the bundle bytes: ingest only takes a name, so the
  // deploy route is where a hostile definition must be stopped. The key
  // agentdef:hostile-probe is never written — every PUT below must 422.
  const hostiles = [
    ['path traversal', { ...bundle, skills: { ...bundle.skills, planner: { ...bundle.skills.planner, '../evil.md': 'x' } } }],
    ['absolute path', { ...bundle, skills: { ...bundle.skills, planner: { ...bundle.skills.planner, '/etc/passwd': 'x' } } }],
    ['missing per-skill SKILL.md', { ...bundle, skills: { planner: { 'references/only.md': 'x' } } }],
    ['missing instructions', { ...bundle, instructions: '' }],
  ];
  for (const [label, bad] of hostiles) {
    const r = await put(B_URL, '/agents/hostile-probe', bad);
    check('hostile', `rejects hostile bundle at deploy: ${label}`, r.status === 422, `status ${r.status}`);
  }

  // --- Name-based ingest negatives -----------------------------------------
  const unknown = await createSession(B_URL, { agentName: 'acceptance-never-deployed' });
  check('ingest-404', 'rejects an undeployed agent name (404)', unknown.status === 404, `status ${unknown.status}`);
  const legacy = await createSession(B_URL, { bundle });
  check('ingest-422', 'rejects the legacy inline-bundle body (422)', legacy.status === 422, `status ${legacy.status}`);

  // Cleanup best-effort
  await Promise.all([del(B_URL, bId), del(B_URL, b2Id), del(B_URL, zId), del(B_URL, dId)]);

  console.log(`
${failures === 0 ? 'ALL ACCEPTANCE CHECKS PASS' : `${failures} FAILED`}  (${total} checks)`);
  process.exit(failures === 0 ? 0 : 1);
}

function sorted(obj) { return Object.fromEntries(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b))); }
function snippet(s) { return String(s).replace(/\s+/g, ' ').slice(0, 100); }

main().catch((err) => { console.error(err); process.exit(1); });
