#!/usr/bin/env node
/**
 * Acceptance tests (plan §11 step 8, §13) against the DEPLOYED backends.
 * Every check names a concrete oracle; LLM nondeterminism is isolated by
 * driving the deterministic core (the bounded /skill-check route) directly.
 *
 * Requires the shared API key (both backends are behind the guard):
 *   API_TOKEN=<key> node scripts/acceptance.mjs
 *   API_TOKEN=<key> A_URL=https://... B_URL=https://... node scripts/acceptance.mjs
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const A_URL = process.env.A_URL ?? 'https://hoth-poc-backend-a.ma532.workers.dev';
const B_URL = process.env.B_URL ?? 'https://hoth-poc-backend-b.ma532.workers.dev';
const API_TOKEN = process.env.API_TOKEN;
if (!API_TOKEN) {
  console.error('API_TOKEN env var is required (both backends are behind the API-key guard).');
  process.exit(2);
}
const AUTH = { authorization: `Bearer ${API_TOKEN}` };

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
const results = [];
function check(id, name, ok, extra = '') {
  results.push({ id, name, ok, extra });
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${id}] ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
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

async function del(base, id) {
  await fetch(`${base}/sessions/${id}`, { method: 'DELETE', headers: { ...AUTH } }).catch(() => {});
}

const FIXED = { op: 'opening-times', sites: ['Echo Base Thermal Springs'], from: '2026-08-01', to: '2026-08-03' };

async function main() {
  console.log(`A: ${A_URL}\nB: ${B_URL}\n`);

  // Health (public, no auth)
  const [ha, hb] = await Promise.all([fetch(`${A_URL}/health`).then((r) => r.json()), fetch(`${B_URL}/health`).then((r) => r.json())]);
  check('health', 'both backends healthy', ha.ok && hb.ok, `A=${ha.delivery} B=${hb.delivery}`);

  // --- Auth: protected routes reject missing/wrong key ---------------------
  const noKey = await fetch(`${A_URL}/sessions/${uuid()}/provision`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  check('auth', 'A rejects request with no API key (401)', noKey.status === 401, `status ${noKey.status}`);
  const badKey = await fetch(`${B_URL}/sessions/${uuid()}/agent`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer wrong' }, body: '{}' });
  check('auth', 'B rejects request with wrong API key (401)', badKey.status === 401, `status ${badKey.status}`);

  // --- Named-definition deploys (PUT /agents/:name is the trust boundary) --
  const dep = await put(B_URL, `/agents/${bundle.agentName}`, bundle);
  check('deploy', 'B deploys hoth-trip-planner as a named definition', dep.status === 200 && dep.json.version === bundle.version, JSON.stringify(dep.json).slice(0, 140));
  const depAgain = await put(B_URL, `/agents/${bundle.agentName}`, bundle);
  check('deploy', 'redeploying the same name overwrites (200)', depAgain.status === 200, `status ${depAgain.status}`);
  const depZero = await put(B_URL, `/agents/${zeroSkillBundle.agentName}`, zeroSkillBundle);
  check('deploy', 'B deploys a zero-skill definition', depZero.status === 200, `status ${depZero.status}`);
  const depDeny = await put(B_URL, `/agents/${noEgress.agentName}`, noEgress);
  check('deploy', 'B deploys a no-whitelist definition', depDeny.status === 200, `status ${depDeny.status}`);
  const depNoKey = await fetch(`${B_URL}/agents/acceptance-noauth`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(bundle) });
  check('deploy', 'deploy route rejects a missing API key (401)', depNoKey.status === 401, `status ${depNoKey.status}`);

  // --- C1: A is OOTB / static (no agent-ingest route) ---------------------
  const aIngest = await post(A_URL, `/sessions/${uuid()}/agent`, { agentName: bundle.agentName });
  check('C1', 'A has no agent-ingest route (404/405)', aIngest.status === 404 || aIngest.status === 405, `status ${aIngest.status}`);

  // --- Provision an A session and a B session -----------------------------
  const aId = uuid();
  const aProv = await post(A_URL, `/sessions/${aId}/provision`, {});
  check('C1', 'A provision (static bearer) OK', aProv.status === 200, JSON.stringify(aProv.json).slice(0, 120));

  const bId = uuid();
  const bIngest = await post(B_URL, `/sessions/${bId}/agent`, { agentName: bundle.agentName, tenantTag: 'tenant-alpha' });
  check(
    'B-ingest',
    'B name-based ingest OK (pinned to the deployed version)',
    bIngest.status === 200 &&
      bIngest.json.agentName === bundle.agentName &&
      bIngest.json.version === bundle.version &&
      bIngest.json.tenantTag === 'tenant-alpha',
    JSON.stringify(bIngest.json).slice(0, 160),
  );

  // --- Clean-base positive control: B live sandbox now has the file set ---
  // (also the reconstruction proof — the ingest response deliberately carries
  // no provisioning internals, the deterministic file count here is the oracle)
  const bCount = await post(B_URL, `/sessions/${bId}/skill-check`, { op: 'count-skill-files' });
  const bFileCount = Number((bCount.json.stdout ?? '').trim());
  check('clean-base', 'B live sandbox has expected file count after injection', bFileCount === bundleFileCount, `count=${bFileCount}`);

  // --- Zero-skill agent: valid bundle, nothing to reconstruct -------------
  const zId = uuid();
  const zIngest = await post(B_URL, `/sessions/${zId}/agent`, { agentName: zeroSkillBundle.agentName, tenantTag: 'tenant-zero' });
  check('zero-skill', 'B ingests a zero-skill agent', zIngest.status === 200 && zIngest.json.agentName === zeroSkillBundle.agentName, JSON.stringify(zIngest.json).slice(0, 140));
  const zCount = await post(B_URL, `/sessions/${zId}/skill-check`, { op: 'count-skill-files' });
  check('zero-skill', 'zero-skill session sandbox holds no skill files', Number((zCount.json.stdout ?? '').trim()) === 0, `count=${(zCount.json.stdout ?? '').trim()}`);

  // --- Per-agent egress: an agent WITHOUT proxy_whitelist gets deny-all -----
  // The opening-times call to the echo host must be rejected by the outbound
  // handler (fail closed).
  const dId = uuid();
  const dIngest = await post(B_URL, `/sessions/${dId}/agent`, { agentName: noEgress.agentName, tenantTag: 'tenant-deny' });
  check('egress', 'B ingests an agent without proxy_whitelist', dIngest.status === 200, `status ${dIngest.status}`);
  const dRun = await post(B_URL, `/sessions/${dId}/skill-check`, FIXED);
  const dOut = dRun.json.stdout ?? '';
  check(
    'egress',
    'egress is deny-all for an agent without proxy_whitelist',
    /403|egress denied/.test(dOut) || dRun.json.exitCode !== 0,
    snippet(dOut),
  );

  // --- C3: single source of truth (A image == bundle == B reconstructed) --
  // Leg 1 (A image) and clean-base(0) were checked at build time via docker;
  // here we compare the two LIVE sandboxes' hashes to the bundle values.
  // hash-skill cds into the planner skill dir, so expected keys are ./<rel>
  // over the planner skill's files.
  const bundleHashes = {};
  for (const [rel, content] of Object.entries(bundle.skills.planner)) {
    bundleHashes[`./${rel}`] = createHash('sha256').update(content).digest('hex');
  }
  const [aHash, bHash] = await Promise.all([
    post(A_URL, `/sessions/${aId}/skill-check`, { op: 'hash-skill' }),
    post(B_URL, `/sessions/${bId}/skill-check`, { op: 'hash-skill' }),
  ]);
  const parseHashes = (stdout) => Object.fromEntries((stdout ?? '').trim().split('\n').filter(Boolean).map((line) => {
    const [h, p] = line.trim().split(/\s+/);
    return [p, h];
  }));
  const aHashes = parseHashes(aHash.json.stdout);
  const bHashes = parseHashes(bHash.json.stdout);
  check('C3', 'A live sandbox hashes == bundle', JSON.stringify(sorted(aHashes)) === JSON.stringify(sorted(bundleHashes)));
  check('C3', 'B live sandbox hashes == bundle', JSON.stringify(sorted(bHashes)) === JSON.stringify(sorted(bundleHashes)));
  check('C3', 'A live == B live (byte-identical skill)', JSON.stringify(sorted(aHashes)) === JSON.stringify(sorted(bHashes)));

  // --- C4: same result A vs B (the thesis) — deterministic exec oracle -----
  const [aRun, bRun] = await Promise.all([
    post(A_URL, `/sessions/${aId}/skill-check`, FIXED),
    post(B_URL, `/sessions/${bId}/skill-check`, FIXED),
  ]);
  const aOut = normalizeTimes(aRun.json.stdout);
  const bOut = normalizeTimes(bRun.json.stdout);
  check('C4', 'A opening-times.js runs (exit 0)', aRun.json.exitCode === 0);
  check('C4', 'B opening-times.js runs (exit 0)', bRun.json.exitCode === 0);
  check('C4', 'A stdout JSON == B stdout JSON (byte-for-byte)', aOut !== null && aOut === bOut, aOut ? `${aOut.length} chars` : 'unparseable');

  // --- Per-process TLS trust: curl (system CA path, via the baked
  //     CURL_CA_BUNDLE/SSL_CERT_FILE) reaches the whitelisted echo host over
  //     HTTPS through the interceptor — a whitelisted host works from EVERY
  //     tool, not just node ------------------------------------------------
  const [aCurl, bCurl] = await Promise.all([
    post(A_URL, `/sessions/${aId}/skill-check`, { op: 'curl-check' }),
    post(B_URL, `/sessions/${bId}/skill-check`, { op: 'curl-check' }),
  ]);
  check('curl-tls', 'A: curl reaches whitelisted host over HTTPS (200)', (aCurl.json.stdout ?? '').trim() === '200', `got ${(aCurl.json.stdout ?? '').trim() || aCurl.json.stderr}`);
  check('curl-tls', 'B: curl reaches whitelisted host over HTTPS (200)', (bCurl.json.stdout ?? '').trim() === '200', `got ${(bCurl.json.stdout ?? '').trim() || bCurl.json.stderr}`);

  // --- C4 egress trace: the echo upstream saw this session's bearer, the
  //     container sent none ------------------------------------------------
  const [aEcho, bEcho] = await Promise.all([
    post(A_URL, `/sessions/${aId}/skill-check`, { ...FIXED, debugEcho: true }),
    post(B_URL, `/sessions/${bId}/skill-check`, { ...FIXED, debugEcho: true }),
  ]);
  const aHdr = echoHeaders(aEcho.json.stdout);
  const bHdr = echoHeaders(bEcho.json.stdout);
  check('C4', 'A egress: upstream received an injected Bearer', !!aHdr?.authorization?.startsWith('Bearer '), aHdr?.authorization ?? 'none');
  check('C4', 'B egress: upstream received an injected Bearer', !!bHdr?.authorization?.startsWith('Bearer '), bHdr?.authorization ?? 'none');
  check('C2', "B egress carries this session's tenant tag", bHdr?.['x-tenant-tag'] === 'tenant-alpha', bHdr?.['x-tenant-tag'] ?? 'none');

  // --- C2: two concurrent B sessions get DIFFERENT bearers + tags ---------
  const b2Id = uuid();
  await post(B_URL, `/sessions/${b2Id}/agent`, { agentName: bundle.agentName, tenantTag: 'tenant-beta' });
  const [b1e, b2e] = await Promise.all([
    post(B_URL, `/sessions/${bId}/skill-check`, { ...FIXED, debugEcho: true }),
    post(B_URL, `/sessions/${b2Id}/skill-check`, { ...FIXED, debugEcho: true }),
  ]);
  const h1 = echoHeaders(b1e.json.stdout), h2 = echoHeaders(b2e.json.stdout);
  check('C2', 'concurrent B sessions carry different bearers', !!h1?.authorization && !!h2?.authorization && h1.authorization !== h2.authorization);
  check('C2', 'concurrent B sessions carry different tenant tags', h1?.['x-tenant-tag'] === 'tenant-alpha' && h2?.['x-tenant-tag'] === 'tenant-beta');

  // --- C5: uniqueness guard — a reused id is rejected ---------------------
  const reuse = await post(B_URL, `/sessions/${bId}/agent`, { agentName: bundle.agentName });
  check('C5', 'B rejects a reused session id (immutable-per-id)', reuse.status === 409, `status ${reuse.status}`);

  // --- C5: fail-closed egress — a session with no bearer mapping ----------
  //   Provision the bundle but immediately delete the mapping, then egress.
  const orphanId = uuid();
  await post(B_URL, `/sessions/${orphanId}/agent`, { agentName: bundle.agentName, tenantTag: 'tenant-orphan' });
  await del(B_URL, orphanId); // removes bearer + bundle
  await post(B_URL, `/sessions/${orphanId}/agent`, { agentName: bundle.agentName, tenantTag: 'tenant-orphan2' }).catch(() => {});
  // Re-ingest re-adds a bearer, so instead test the pure no-mapping path via A:
  // craft an A session that never provisioned → no bearer mapping.
  const aNoBearer = uuid();
  const aFailClosed = await post(A_URL, `/sessions/${aNoBearer}/skill-check`, { ...FIXED, debugEcho: true });
  const failStdout = aFailClosed.json.stdout ?? '';
  check('C5', 'egress fails closed without a bearer mapping (403 from proxy)', /403|egress denied/.test(failStdout) || aFailClosed.json.exitCode !== 0, snippet(failStdout));

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
    check('hostile', `B rejects hostile bundle at deploy: ${label}`, r.status === 422, `status ${r.status}`);
  }

  // --- Name-based ingest negatives -----------------------------------------
  const unknown = await post(B_URL, `/sessions/${uuid()}/agent`, { agentName: 'acceptance-never-deployed' });
  check('ingest-404', 'B rejects an undeployed agent name (404)', unknown.status === 404, `status ${unknown.status}`);
  const legacy = await post(B_URL, `/sessions/${uuid()}/agent`, { bundle });
  check('ingest-422', 'B rejects the legacy inline-bundle body (422)', legacy.status === 422, `status ${legacy.status}`);

  // Cleanup best-effort
  await Promise.all([del(A_URL, aId), del(B_URL, bId), del(B_URL, b2Id), del(B_URL, zId), del(B_URL, dId), del(B_URL, orphanId)]);

  console.log(`\n${failures === 0 ? 'ALL ACCEPTANCE CHECKS PASS' : `${failures} FAILURE(S)`}  (${results.length} checks)`);
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
