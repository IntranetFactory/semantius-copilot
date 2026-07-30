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
 * (Check ids C2-C5 keep their plan §13 numbering; C1 — "backend A is
 * OOTB/static" — retired with backend A itself.)
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sessionTenantPrefix } from '../core/src/index.js';
import { mintSemantiusToken } from './lib/semantius.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const B_URL = process.env.B_URL ?? 'https://hoth-poc-backend-b.ma532.workers.dev';
const API_TOKEN = process.env.API_TOKEN;
if (!API_TOKEN) {
  console.error('API_TOKEN env var is required (the backend is behind the API-key guard).');
  process.exit(2);
}
const AUTH = { authorization: `Bearer ${API_TOKEN}` };
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
    typeof bId === 'string' && bId.length > 0 && bId.length <= 63,
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
    'minted id is sandbox-safe (lowercase DNS label, no leading/trailing hyphen)',
    /^[a-z0-9][a-z0-9-]{6,61}[a-z0-9]$/.test(String(bId)),
    String(bId),
  );

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

  // --- C4: the skill runs deterministically in the sandbox ----------------
  const bRun = await post(B_URL, `/sessions/${bId}/skill-check`, FIXED);
  const bOut = normalizeTimes(bRun.json.stdout);
  check('C4', 'opening-times.js runs (exit 0)', bRun.json.exitCode === 0);
  check('C4', 'opening-times.js stdout is the expected JSON payload', bOut !== null, bOut ? `${bOut.length} chars` : 'unparseable');

  // --- Per-process TLS trust: curl (system CA path, via the baked
  //     CURL_CA_BUNDLE/SSL_CERT_FILE) reaches the whitelisted echo host over
  //     HTTPS through the interceptor — a whitelisted host works from EVERY
  //     tool, not just node ------------------------------------------------
  const bCurl = await post(B_URL, `/sessions/${bId}/skill-check`, { op: 'curl-check' });
  check('curl-tls', 'curl reaches whitelisted host over HTTPS (200)', (bCurl.json.stdout ?? '').trim() === '200', `got ${(bCurl.json.stdout ?? '').trim() || bCurl.json.stderr}`);

  // --- C4 egress trace: the echo upstream saw this session's downstream
  //     credential, the container sent none --------------------------------
  const bEcho = await post(B_URL, `/sessions/${bId}/skill-check`, { ...FIXED, debugEcho: true });
  const bHdr = echoHeaders(bEcho.json.stdout);
  // Zero-knowledge injection: the sandbox sent no credential and holds none
  // (not even a placeholder), yet the upstream saw this session's entry from
  // the record's egress_secrets map.
  check(
    'C4',
    'egress: upstream received the injected downstream credential',
    bHdr?.authorization?.startsWith('Bearer hoth-tourism-key-') === true,
    bHdr?.authorization ?? 'none',
  );
  // The tenant on the wire is the org of the verified token — never a value the
  // client picked (the ingest body carries nothing tenant-shaped any more).
  check('C2', "egress carries the session's Semantius org", bHdr?.['x-semantius-org'] === tokenOrg, bHdr?.['x-semantius-org'] ?? 'none');

  // --- C2: two concurrent sessions get DIFFERENT credentials, SAME tenant --
  // Per-session separation is the egress_secrets entry (keyed by the
  // container→session mapping, so tenant A's key can never surface in tenant
  // B's container); the org is identity, so two sessions of one user must agree
  // on it (a differing org would mean a session invented its tenant instead of
  // taking it from the token).
  const b2Id = (await createSession(B_URL, { agentName: bundle.agentName })).id;
  const [b1e, b2e] = await Promise.all([
    post(B_URL, `/sessions/${bId}/skill-check`, { ...FIXED, debugEcho: true }),
    post(B_URL, `/sessions/${b2Id}/skill-check`, { ...FIXED, debugEcho: true }),
  ]);
  const h1 = echoHeaders(b1e.json.stdout), h2 = echoHeaders(b2e.json.stdout);
  check('C2', 'concurrent sessions carry different downstream credentials', !!h1?.authorization && !!h2?.authorization && h1.authorization !== h2.authorization);
  check(
    'C2',
    "concurrent sessions of one user carry that user's org",
    h1?.['x-semantius-org'] === tokenOrg && h2?.['x-semantius-org'] === tokenOrg,
    `${h1?.['x-semantius-org'] ?? 'none'} / ${h2?.['x-semantius-org'] ?? 'none'}`,
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
  // Ingest pre-warms the container (skill files land on its disk), DELETE then
  // removes the egress policy (pointer + record) + bundle. The warm container
  // still holds the files, so the skill RUNS — but its egress must be
  // rejected (no policy).
  const orphanId = (await createSession(B_URL, { agentName: bundle.agentName })).id;
  await del(B_URL, orphanId); // removes egress policy + bundle snapshot
  const orphanRun = await post(B_URL, `/sessions/${orphanId}/skill-check`, { ...FIXED, debugEcho: true });
  const orphanOut = orphanRun.json.stdout ?? '';
  check('C5', 'egress fails closed without an egress policy (403 from proxy)', /403|egress denied/.test(orphanOut) || orphanRun.json.exitCode !== 0, snippet(orphanOut));

  // --- session_context / session record: written at ingest, removed on DELETE
  // THE session record (session:<id>) carries meta + egress_secrets/whitelist +
  // session_context in ONE document; the container:<containerId> pointer is
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
    'session record carries the client context, egress_secrets, and whitelist in one document',
    ctxRecord.status === 200 &&
      ctxStored.probe === ctxProbe &&
      typeof ctxRecord.json?.json?.egress_secrets?.['postman-echo.com'] === 'string' &&
      Array.isArray(ctxRecord.json?.json?.whitelist),
    JSON.stringify(ctxRecord.json?.json ?? ctxRecord.json).slice(0, 140),
  );
  check(
    'context',
    'egress_secrets is a host-glob map, not a bare credential field',
    ctxRecord.json?.json?.bearer === undefined && typeof ctxRecord.json?.json?.egress_secrets === 'object',
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
function normalizeTimes(stdout) {
  try {
    const start = stdout.indexOf('[');
    return JSON.stringify(JSON.parse(stdout.slice(start)));
  } catch { return null; }
}
function echoHeaders(stdout) {
  try {
    const start = stdout.indexOf('{');
    return JSON.parse(stdout.slice(start)).upstream_received_headers ?? null;
  } catch { return null; }
}
function snippet(s) { return String(s).replace(/\s+/g, ' ').slice(0, 100); }

main().catch((err) => { console.error(err); process.exit(1); });
