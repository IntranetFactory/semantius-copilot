#!/usr/bin/env node
/**
 * Host-agnostic core unit tests — the admin collection model and the egress
 * policy over an in-memory KV. Zero Cloudflare/Flue present, so this runs
 * anywhere `node` does (`pnpm test`).
 *
 * Covers: KV listing (cursor pagination + grouping + sort), value reads
 * (JSON vs opaque vs missing), the session index round-trip, the generic
 * collection resolvers (kv / sessions), the `egress_secrets` rules
 * (host-glob lookup, mint-if-absent, fail-closed when a host has no entry),
 * and the tenant-prefixed session-id minting the whole key space keys off.
 * The beta `runs` collection is gone — Flue v2 removed the workflow-run
 * registry.
 */
import {
  listKvEntries,
  readKvEntry,
  kvGroupOf,
  putSessionIndex,
  listSessions,
  readSession,
  removeSessionIndex,
  mergeSessionRecord,
  mergeExistingSessionRecord,
  adminCollections,
  listCollectionRecords,
  readCollectionRecord,
} from '../core/src/admin.js';
import {
  isValidSessionId,
  mintSessionId,
  sandboxNameForSession,
  sessionIdSegment,
  sessionIdTail,
  sessionTenantPrefix,
  SESSION_ID_MAX,
} from '../core/src/config.js';
import {
  CONTAINER_RATES,
  R2_RATES,
  backupOpsUsd,
  backupStorageMonthlyUsd,
  containerCostQuery,
  foldContainerCostResponse,
  priceContainerUsage,
  utcDayWindow,
} from '../core/src/cost.js';
import {
  BACKUP_PREFIX,
  backupKeys,
  deleteBackup,
  listBackups,
  sweepOrphanedBackups,
} from '../core/src/backup.js';
import {
  brokerEgress,
  egressSecretForHost,
  ensureEgressPolicy,
  injectAndForward,
  isAllowedEgressUrl,
  ORG_ALLOWLIST_MAX_ENTRIES,
  putContainerPointer,
  resolveEgressPolicy,
  sanitizeAllowlist,
} from '../core/src/egress.js';
import {
  extractSessionCookie,
  fetchCopilotSettings,
  verifySemantiusCookie,
  SESSION_JWT_KEY_PREFIX,
} from '../core/src/identity.js';

let failures = 0;
let total = 0;
function check(name, ok, extra = '') {
  total += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
}

/**
 * In-memory KV that mimics the Workers KV surface the browser uses: cursor
 * pagination (page size 2, to force multi-page), prefix filtering, TTL-bearing
 * put, get, delete.
 */
function fakeKv(initial = {}) {
  const map = new Map(Object.entries(initial));
  const PAGE = 2;
  return {
    _map: map,
    async list(options = {}) {
      const { prefix = '', cursor } = options;
      const all = [...map.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0;
      const slice = all.slice(start, start + PAGE);
      const next = start + PAGE;
      const complete = next >= all.length;
      return {
        keys: slice.map((name) => ({ name, expiration: map.get(name)?.expiration ?? null })),
        list_complete: complete,
        cursor: complete ? undefined : String(next),
      };
    },
    async get(key) {
      const v = map.get(key);
      return v === undefined ? null : v.value ?? v;
    },
    async put(key, value, opts = {}) {
      map.set(key, { value, expiration: opts.expirationTtl ? 1800000000 : null });
    },
    async delete(key) {
      map.delete(key);
    },
  };
}

const bundleJson = JSON.stringify({ agentName: 'trip-planner', version: 'v1', baseImage: 'node', instructions: 'hi', skills: { planner: { 'SKILL.md': '# hi' } } });

await (async function run() {
  // --- kvGroupOf ---------------------------------------------------------
  check('kvGroupOf splits on first colon', kvGroupOf('container:abc') === 'container');
  check('kvGroupOf handles no colon', kvGroupOf('flat') === '(ungrouped)');

  // --- listKvEntries: pagination + grouping + sort -----------------------
  const kv = fakeKv({
    'agentdef:trip': JSON.stringify({ agentName: 'trip' }),
    'container:c1': 'sess-1111',
    'agent:9f8a': bundleJson,
    'container:c2': 'sess-2222',
    'session:9f8a': JSON.stringify({
      id: '9f8a',
      backend: 'b',
      egress_secrets: { 'postman-echo.com': 'hoth-tourism-key-1' },
      whitelist: ['postman-echo.com'],
    }),
  });
  const keys = await listKvEntries(kv);
  check('listKvEntries collects all pages', keys.length === 5, `got ${keys.length}`);
  check('listKvEntries sorts by name', keys[0].name === 'agent:9f8a' && keys.at(-1).name === 'session:9f8a');
  check('listKvEntries assigns groups', keys.find((k) => k.name === 'container:c1')?.group === 'container');

  // --- readKvEntry: json / opaque / missing ------------------------------
  const bundleEntry = await readKvEntry(kv, 'agent:9f8a');
  check('readKvEntry parses JSON', bundleEntry?.json?.agentName === 'trip-planner');
  check('readKvEntry reports size', bundleEntry?.size === bundleJson.length);
  const pointerEntry = await readKvEntry(kv, 'container:c1');
  check('readKvEntry leaves opaque strings unparsed', pointerEntry?.json === null && pointerEntry?.value === 'sess-1111');
  check('readKvEntry returns null when absent', (await readKvEntry(kv, 'nope')) === null);

  // --- session index round-trip ------------------------------------------
  const skv = fakeKv();
  await putSessionIndex(skv, 'aaaa-1111', { backend: 'b', agentName: 'trip-planner', createdAt: '2026-07-19T10:00:00.000Z' });
  await putSessionIndex(skv, 'bbbb-2222', { backend: 'a', createdAt: '2026-07-19T12:00:00.000Z' });
  const sessions = await listSessions(skv);
  check('listSessions enumerates indexed sessions', sessions.length === 2, `got ${sessions.length}`);
  check('listSessions preserves metadata', sessions.find((s) => s.id === 'aaaa-1111')?.agentName === 'trip-planner');

  // --- ordering: newest first, undated last ------------------------------
  const okv = fakeKv();
  await putSessionIndex(okv, 'old', { createdAt: '2026-07-01T00:00:00.000Z' });
  await putSessionIndex(okv, 'newest', { createdAt: '2026-07-19T23:00:00.000Z' });
  await putSessionIndex(okv, 'middle', { createdAt: '2026-07-10T00:00:00.000Z' });
  await putSessionIndex(okv, 'undated', {});
  const ordered = await listSessions(okv);
  check(
    'listSessions sorts newest first',
    ordered.map((s) => s.id).join(',') === 'newest,middle,old,undated',
    ordered.map((s) => s.id).join(','),
  );
  check('listSessions puts undated records last', ordered.at(-1)?.id === 'undated');
  check('readSession returns one record', (await readSession(skv, 'bbbb-2222'))?.backend === 'a');
  check('putSessionIndex writes under session: prefix', skv._map.has('session:aaaa-1111'));
  await removeSessionIndex(skv, 'aaaa-1111');
  check('removeSessionIndex deletes the record', (await readSession(skv, 'aaaa-1111')) === null);
  check('removeSessionIndex leaves others', (await listSessions(skv)).length === 1);

  // --- mergeSessionRecord: patches merge into THE session record -----------
  const mkv = fakeKv();
  await mergeSessionRecord(mkv, 'merge-1', {
    backend: 'b',
    createdAt: '2026-07-20T00:00:00.000Z',
    egress_secrets: { 'x.example': 'key-1' },
    whitelist: ['x.example'],
    session_context: { semantius_org: 'tests', semantius_user: 'user3' },
  });
  await mergeSessionRecord(mkv, 'merge-1', { session_state: { total_tokens: 42, llm_calls_count: 1 } });
  const merged = await readSession(mkv, 'merge-1');
  check(
    'mergeSessionRecord preserves existing fields',
    merged?.session_context?.semantius_org === 'tests' &&
      merged?.session_context?.semantius_user === 'user3' &&
      merged?.egress_secrets?.['x.example'] === 'key-1' &&
      merged?.createdAt === '2026-07-20T00:00:00.000Z',
  );
  check('mergeSessionRecord writes the patch', merged?.session_state?.total_tokens === 42 && merged?.whitelist?.[0] === 'x.example');
  await mergeSessionRecord(mkv, 'merge-1', { session_state: { total_tokens: 99, llm_calls_count: 2 } });
  check('mergeSessionRecord replaces patched fields', (await readSession(mkv, 'merge-1'))?.session_state?.llm_calls_count === 2);
  const mergedNew = await mergeSessionRecord(mkv, 'merge-new', { session_state: { total_tokens: 7 } });
  check('mergeSessionRecord creates a record when none exists', mergedNew?.id === 'merge-new' && mergedNew?.session_state?.total_tokens === 7);

  // The never-resurrect variant, for writers that land after teardown — the
  // sandbox's post-stop cost snapshot fires ~15 min after the container stops,
  // long after DELETE /sessions/:id may have removed the record (that DELETE
  // does not stop the container).
  const gone = await mergeExistingSessionRecord(mkv, 'never-existed', { session_sandbox: { cost_total: 1 } });
  check('mergeExistingSessionRecord does not create an absent record', gone === null);
  check('mergeExistingSessionRecord writes nothing for an absent record', !mkv._map.has('session:never-existed'));
  const healed = await mergeExistingSessionRecord(mkv, 'merge-1', { session_sandbox: { cost_total: 0.0004 } });
  check('mergeExistingSessionRecord merges into a live record', healed?.session_sandbox?.cost_total === 0.0004);
  check('mergeExistingSessionRecord preserves the rest of the record', healed?.session_state?.llm_calls_count === 2);
  await removeSessionIndex(mkv, 'merge-1');
  check(
    'a deleted session stays deleted after a late snapshot write',
    (await mergeExistingSessionRecord(mkv, 'merge-1', { session_sandbox: { cost_total: 9 } })) === null &&
      (await readSession(mkv, 'merge-1')) === null,
  );

  // --- collections descriptor --------------------------------------------
  const cols = adminCollections('STORE');
  check('adminCollections exposes kv/sessions/backups', cols.map((c) => c.id).join(',') === 'kv,sessions,backups');
  check('adminCollections labels kv with namespace', cols[0].label.includes('STORE'));

  // --- generic record listing --------------------------------------------
  const deps = { kv };

  const kvRecords = await listCollectionRecords('kv', deps);
  check('listCollectionRecords(kv) maps keys to records', kvRecords.records.length === 5);
  const sessRecords = await listCollectionRecords('sessions', deps);
  check('listCollectionRecords(sessions) reads the index', sessRecords.records.some((r) => r.id === '9f8a'));
  const datedRecords = await listCollectionRecords('sessions', { kv: okv });
  check('listCollectionRecords(sessions) exposes createdAt as sublabel', datedRecords.records[0]?.sublabel === '2026-07-19T23:00:00.000Z');
  check('listCollectionRecords(sessions) keeps newest-first order', datedRecords.records[0]?.id === 'newest');
  check('listCollectionRecords(sessions) omits sublabel when undated', datedRecords.records.at(-1)?.sublabel === undefined);
  check('listCollectionRecords(unknown) returns null', (await listCollectionRecords('nope', deps)) === null);
  check('listCollectionRecords(runs) is gone in v2', (await listCollectionRecords('runs', deps)) === null);

  // --- kv browser: dates + newest-first across ALL groups ------------------
  // Three of the four prefixes are session-scoped and all three resolve from
  // THE session record: session:/agent: share the id, container: joins on the
  // record's own containerId (idFromName is one-way, so the key can't be
  // reversed). agentdef: is a deployed definition, not session-scoped.
  const dkv = fakeKv({
    'agentdef:trip': JSON.stringify({ agentName: 'trip' }),
    'agent:old': bundleJson,
    'agent:new': bundleJson,
    'container:cOLD': 'old',
    'container:cNEW': 'new',
    'session:old': JSON.stringify({ id: 'old', createdAt: '2026-07-01T00:00:00.000Z', containerId: 'cOLD' }),
    'session:new': JSON.stringify({ id: 'new', createdAt: '2026-07-19T00:00:00.000Z', containerId: 'cNEW' }),
  });
  const dated = await listCollectionRecords('kv', { kv: dkv });
  const dateFor = (name) => dated.records.find((r) => r.id === name)?.sublabel;
  check('kv browser dates session: keys', dateFor('session:new') === '2026-07-19T00:00:00.000Z');
  check('kv browser dates agent: keys from the same session', dateFor('agent:new') === '2026-07-19T00:00:00.000Z');
  check(
    'kv browser dates container: keys via the record containerId',
    dateFor('container:cNEW') === '2026-07-19T00:00:00.000Z',
    String(dateFor('container:cNEW')),
  );
  check('kv browser leaves agentdef: undated', dateFor('agentdef:trip') === undefined);
  const order = dated.records.map((r) => r.id);
  check(
    'kv browser sorts newest session first, undated last',
    order.join(',') === 'agent:new,container:cNEW,session:new,agent:old,container:cOLD,session:old,agentdef:trip',
    order.join(','),
  );
  check('kv browser keeps groups on every record', dated.records.every((r) => typeof r.group === 'string'));
  check(
    'kv browser omits sublabel entirely when there is no date',
    !('sublabel' in dated.records.find((r) => r.id === 'agentdef:trip')),
  );

  // --- generic record detail ---------------------------------------------
  const kvDetail = await readCollectionRecord('kv', 'agent:9f8a', deps);
  check('readCollectionRecord(kv) returns parsed value', kvDetail?.kind === 'kv' && kvDetail?.json?.agentName === 'trip-planner');
  const sessDetail = await readCollectionRecord('sessions', '9f8a', deps);
  check('readCollectionRecord(sessions) returns the session', sessDetail?.kind === 'session' && sessDetail?.session?.backend === 'b');
  check('readCollectionRecord(kv) missing -> null', (await readCollectionRecord('kv', 'nope', deps)) === null);
  check('readCollectionRecord(runs) is gone in v2', (await readCollectionRecord('runs', 'run-1', deps)) === null);
  check('readCollectionRecord(unknown) -> null', (await readCollectionRecord('zzz', 'x', deps)) === null);

  // --- egress_secrets: host-glob lookup, fail-closed -----------------------
  // The record field is a MAP (host glob -> credential the sandbox never
  // holds). NOTHING in the server writes it today — it is reserved for the
  // future secret-retrieval layer (see the TODO in backend-b/src/app.ts) —
  // so these cover the read side: match by the same globber as the
  // whitelist, and deny when a host has no entry (plan §13 C5 — a session
  // whose policy self-heals must not gain egress credentials).
  check('egressSecretForHost matches an exact host', egressSecretForHost({ 'postman-echo.com': 'k1' }, 'postman-echo.com') === 'k1');
  check('egressSecretForHost matches a subdomain glob', egressSecretForHost({ '*.partner.example': 'k2' }, 'api.partner.example') === 'k2');
  check('egressSecretForHost does not match a glob against the bare apex', egressSecretForHost({ '*.partner.example': 'k2' }, 'partner.example') === undefined);
  check('egressSecretForHost ignores non-string values', egressSecretForHost({ 'h.example': 42 }, 'h.example') === undefined);
  check('egressSecretForHost tolerates a missing map', egressSecretForHost(undefined, 'h.example') === undefined);

  const ekv = fakeKv();
  await mergeSessionRecord(ekv, 'sess-e', {
    whitelist: ['postman-echo.com'],
    egress_secrets: { 'postman-echo.com': 'tourism-key-1' },
    session_context: { semantius_org: 'tests' },
  });
  await putContainerPointer(ekv, 'cid-e', 'sess-e');
  const pol = await resolveEgressPolicy(ekv, 'cid-e');
  check('resolveEgressPolicy returns the egress_secrets map', pol?.egressSecrets?.['postman-echo.com'] === 'tourism-key-1');
  check('resolveEgressPolicy derives semantiusOrg from session_context', pol?.semantiusOrg === 'tests');

  let forwarded = null;
  const injected = await injectAndForward(new Request('https://postman-echo.com/post', { method: 'POST' }), pol, async (req) => {
    forwarded = req;
    return new Response('ok');
  });
  check('injectAndForward adds the matching credential', forwarded?.headers.get('authorization') === 'Bearer tourism-key-1');
  check('injectAndForward stamps x-semantius-org', forwarded?.headers.get('x-semantius-org') === 'tests');
  check('injectAndForward forwards the request (200)', injected.status === 200);
  let leaked = false;
  const denied = await injectAndForward(new Request('https://other.example/x'), pol, async () => {
    leaked = true;
    return new Response('should never be sent');
  });
  check('injectAndForward denies a host with no entry (403, nothing forwarded)', denied.status === 403 && !leaked);

  const skv2 = fakeKv();
  const desired = { whitelist: ['postman-echo.com'] };
  await ensureEgressPolicy(skv2, 'cid-n', 'sess-n', desired);
  check(
    'ensureEgressPolicy heals the whitelist but never creates a credential (C5)',
    (await readSession(skv2, 'sess-n'))?.egress_secrets === undefined &&
      (await readSession(skv2, 'sess-n'))?.whitelist?.[0] === 'postman-echo.com',
  );
  // A retrieval-populated credential must survive the self-heal untouched.
  await mergeSessionRecord(skv2, 'sess-n', { egress_secrets: { 'postman-echo.com': 'vault-resolved-1' } });
  await ensureEgressPolicy(skv2, 'cid-n', 'sess-n', desired);
  check(
    'ensureEgressPolicy preserves an existing egress_secrets map verbatim',
    (await readSession(skv2, 'sess-n'))?.egress_secrets?.['postman-echo.com'] === 'vault-resolved-1',
  );

  // --- The allow-list matcher ---------------------------------------------
  // One grammar for the agent's proxy_whitelist and the org's copilot list:
  // hostnames or URLs, `*` anywhere. The old exact-host/`*.suffix` behavior has
  // to survive verbatim (those entries are deployed), so the look-alike cases
  // are asserted first.
  const allows = (url, ...list) => isAllowedEgressUrl(url, list);
  check('exact host matches', allows('https://abc.com/x', 'abc.com'));
  check('exact host does not match a different host', !allows('https://evil.com/x', 'abc.com'));
  check('*.suffix matches a subdomain', allows('https://tests.semantius.ai/q', '*.semantius.ai'));
  check('*.suffix does NOT match the bare apex', !allows('https://semantius.ai/q', '*.semantius.ai'));
  check('*.suffix does NOT match a look-alike', !allows('https://evil-semantius.ai/q', '*.semantius.ai'));
  check('*.suffix does NOT match a deeper impostor', !allows('https://tests.semantius.ai.evil.com/q', '*.semantius.ai'));
  check('a wildcard in the middle matches', allows('https://api.eu.acme.io/v1', 'api.*.acme.io'));
  check('a host pattern ignores the port', allows('https://abc.com:8443/x', 'abc.com'));
  check('a host pattern ignores the path', allows('https://abc.com/any/deep/path?q=1', 'abc.com'));
  check('host matching is case-insensitive', allows('https://ABC.com/x', 'abc.com'));
  check('a bare * matches everything', allows('https://anything.example/deep?q=1', '*'));
  check('an empty list denies', !isAllowedEgressUrl('https://abc.com/', []));
  check('a URL pattern matches its path', allows('https://xxx/abc.com/deep', 'https://xxx/abc.com/*'));
  check('a URL pattern does NOT match a different path', !allows('https://xxx/other', 'https://xxx/abc.com/*'));
  check('a URL pattern tolerates a query string', allows('https://api.acme.io/v1/x?q=1', 'https://api.acme.io/v1/*'));
  check('a URL pattern can pin a query string', allows('https://api.acme.io/s?q=cats', 'https://api.acme.io/s?q=*'));
  check('a scheme-less URL pattern matches https', allows('https://x.com/abc/1', 'x.com/abc/*'));
  check('a scheme-less URL pattern matches http', allows('http://x.com/abc/1', 'x.com/abc/*'));
  check('a scheme-ful URL pattern pins the scheme', !allows('http://x.com/abc/1', 'https://x.com/abc/*'));
  check('a URL pattern matches the site root', allows('https://acme.io/', 'https://acme.io'));
  // An origin-only URL pattern means the WHOLE origin. Without this, the most
  // natural entry anyone writes ("https://acme.io") allows the root document
  // and denies every actual request — see the grammar note in egress.js.
  check('an origin-only URL pattern covers every path under it', allows('https://acme.io/v1/x?q=1', 'https://acme.io'));
  check('a trailing slash does not change an origin-only pattern', allows('https://acme.io/v1/x', 'https://acme.io/'));
  check('a scheme-less origin-only pattern still pins nothing but the host', allows('http://acme.io/v1', 'http://acme.io'));
  check('an origin-only pattern does NOT reach a look-alike host', !allows('https://acme.io.evil.com/v1', 'https://acme.io'));
  check('an origin-only pattern does NOT reach a subdomain', !allows('https://api.acme.io/v1', 'https://acme.io'));
  check('a wildcard host in an origin-only pattern does reach subdomains', allows('https://registry.npmjs.org/csv-parse/-/csv-parse-5.6.0.tgz', 'https://*.npmjs.org'));
  check('an origin-only pattern still pins its scheme', !allows('http://acme.io/v1', 'https://acme.io'));
  check('a URL pattern ignores the default port', allows('https://acme.io:443/v1', 'https://acme.io/v1'));
  check('URL-pattern PATHS stay case-sensitive (an allow list must not over-match)', !allows('https://x.com/api', 'x.com/API'));
  check('a URL pattern does not leak across hosts', !allows('https://evil.com/abc/1', 'x.com/abc/*'));
  check('an unparseable URL matches nothing, not even *', !isAllowedEgressUrl('not a url', ['*']));
  check('regex metacharacters in a pattern are literal', !allows('https://axbxc.com/', 'a.b.c.com'));

  // sanitizeAllowlist guards the ONE list that comes from outside this repo.
  // Dropping (never throwing) keeps a malformed upstream row from turning into
  // a failed session — and can only ever narrow egress.
  check('sanitizeAllowlist keeps good entries, trims, dedupes', JSON.stringify(sanitizeAllowlist(['a.com', ' a.com ', 'b.com'])) === '["a.com","b.com"]');
  check('sanitizeAllowlist drops non-strings and blanks', JSON.stringify(sanitizeAllowlist([42, null, '', '  ', 'a.com'])) === '["a.com"]');
  check('sanitizeAllowlist drops entries with whitespace', JSON.stringify(sanitizeAllowlist(['a b.com'])) === '[]');
  check('sanitizeAllowlist drops over-long entries', JSON.stringify(sanitizeAllowlist([`${'a'.repeat(256)}.com`])) === '[]');
  check('sanitizeAllowlist caps the entry count', sanitizeAllowlist(Array.from({ length: 200 }, (_, i) => `h${i}.com`)).length === ORG_ALLOWLIST_MAX_ENTRIES);
  check('sanitizeAllowlist tolerates a non-array', JSON.stringify(sanitizeAllowlist('a.com')) === '[]');

  // --- Agent list + org list are unioned at READ time ----------------------
  // The whole point of keeping them in two fields: ensureEgressPolicy rewrites
  // the agent half from the bundle on every message and has no cookie to
  // re-read the org half with, so a pre-merged field would lose it on turn two.
  const unionKv = fakeKv();
  await mergeSessionRecord(unionKv, 'sess-m', { whitelist: ['agent.example'], org_whitelist: ['*.org.example'] });
  await putContainerPointer(unionKv, 'cid-m', 'sess-m');
  const unioned = await resolveEgressPolicy(unionKv, 'cid-m');
  check('resolveEgressPolicy unions the agent and org lists', JSON.stringify(unioned?.whitelist) === '["agent.example","*.org.example"]');
  await ensureEgressPolicy(unionKv, 'cid-m', 'sess-m', { whitelist: ['agent.example'] });
  const afterHeal = await resolveEgressPolicy(unionKv, 'cid-m');
  check(
    'the self-heal rewrites the agent half and leaves org_whitelist intact',
    JSON.stringify(afterHeal?.whitelist) === '["agent.example","*.org.example"]',
    JSON.stringify(afterHeal?.whitelist),
  );
  const fkv = fakeKv();
  await mergeSessionRecord(fkv, 'sess-f', { whitelist: [], org_whitelist: ['*'] });
  await putContainerPointer(fkv, 'cid-f', 'sess-f');
  const wideOpen = await resolveEgressPolicy(fkv, 'cid-f');
  check('an org with the firewall OFF reaches anything', isAllowedEgressUrl('https://anywhere.example/x', wideOpen?.whitelist ?? []));
  const nkv = fakeKv();
  await mergeSessionRecord(nkv, 'sess-x', { whitelist: [] });
  await putContainerPointer(nkv, 'cid-x', 'sess-x');
  check(
    'a record with no org_whitelist at all is still deny-all (bearer sessions)',
    (await resolveEgressPolicy(nkv, 'cid-x'))?.whitelist.length === 0,
  );

  // --- The credential scope does NOT widen with the allow list -------------
  // A firewall-off org makes everything reachable. The user's Semantius JWT
  // must still only travel to Semantius hosts, or `*` would turn the sandbox
  // into an exfiltration channel for a live credential.
  const sentinel = '__sak__';
  const brokerPolicy = { whitelist: ['*'], sentinel, secret: 'real-jwt', secretHosts: ['*.semantius.ai'] };
  let sent = null;
  const swapCapture = async (req) => { sent = req; return new Response('ok'); };
  await brokerEgress(new Request('https://tests.semantius.ai/mcp', { headers: { authorization: `Bearer ${sentinel}` } }), brokerPolicy, swapCapture);
  check('the sentinel is still swapped inside the credential scope', sent?.headers.get('authorization') === 'Bearer real-jwt');
  sent = null;
  const offScope = await brokerEgress(
    new Request('https://evil.example/collect', { headers: { authorization: `Bearer ${sentinel}` } }),
    brokerPolicy,
    swapCapture,
  );
  check('a sentinel aimed OUTSIDE the credential scope is 403, never forwarded', offScope.status === 403 && sent === null);
  sent = null;
  const plain = await brokerEgress(new Request('https://evil.example/ok'), brokerPolicy, swapCapture);
  check('the same reachable host is fine WITHOUT the sentinel (403 is about the credential)', plain.status === 200 && sent !== null);
  sent = null;
  const notReachable = await brokerEgress(new Request('https://nope.example/x'), { ...brokerPolicy, whitelist: ['abc.com'] }, swapCapture);
  check('a non-whitelisted host is still denied first', notReachable.status === 403 && sent === null);

  // --- Tenant-prefixed session ids ---------------------------------------
  // The id is what the tenant scoping of the whole key space rests on, and the
  // failure modes are silent: an over-long id breaks the container at the far
  // end of provisioning, and two identities collapsing onto one prefix makes a
  // prefix listing quietly wrong. Both are asserted here, offline.
  const uuidStub = () => '1ea1a17e-8e68-456a-b587-986db90a4fc9';
  check(
    'mintSessionId is <org>-<sub>-<32 hex>',
    mintSessionId('tests', 'user3', uuidStub) === 'tests-user3-1ea1a17e8e68456ab587986db90a4fc9',
    mintSessionId('tests', 'user3', uuidStub),
  );
  check(
    'a UUID-shaped sub rides the id VERBATIM (compacted, never truncated/hashed)',
    sessionTenantPrefix('tests', '019d7824-8034-755e-b95e-88f46bb2c8dc') ===
      'tests-019d78248034755eb95e88f46bb2c8dc-',
    sessionTenantPrefix('tests', '019d7824-8034-755e-b95e-88f46bb2c8dc'),
  );
  check('sessionTenantPrefix matches what mintSessionId emits', mintSessionId('tests', 'user3', uuidStub).startsWith(sessionTenantPrefix('tests', 'user3')));
  check('minted id passes the session-id shape gate', isValidSessionId(mintSessionId('tests', 'user3', uuidStub)));
  check(
    'minted id stays under SESSION_ID_MAX for worst-case identities',
    mintSessionId('a'.repeat(63), 'b'.repeat(200), uuidStub).length <= SESSION_ID_MAX,
    `${mintSessionId('a'.repeat(63), 'b'.repeat(200), uuidStub).length} chars`,
  );
  check(
    'the SANDBOX name (org + tail, user dropped) fits the 63-char DNS label even then',
    sandboxNameForSession(mintSessionId('a'.repeat(63), 'b'.repeat(200), uuidStub)).length <= 63,
    sandboxNameForSession(mintSessionId('a'.repeat(63), 'b'.repeat(200), uuidStub)),
  );
  check(
    'sandboxNameForSession drops the user segment, keeps org + tail',
    sandboxNameForSession('tests-019d78248034755eb95e88f46bb2c8dc-1ea1a17e8e68456ab587986db90a4fc9') ===
      'tests-1ea1a17e8e68456ab587986db90a4fc9',
    sandboxNameForSession('tests-019d78248034755eb95e88f46bb2c8dc-1ea1a17e8e68456ab587986db90a4fc9'),
  );
  check(
    'sandboxNameForSession passes hyphen-free channel ids through whole',
    sandboxNameForSession('github:v1:owner:adenin:repo:demo:issue:12') === 'github:v1:owner:adenin:repo:demo:issue:12',
  );
  check(
    'long org slugs ride verbatim once compacted',
    sessionTenantPrefix('acme-corporation-europe', 'x') === 'acmecorporationeurope-x-' &&
      sessionTenantPrefix('acme-corporation-europe', 'x') !== sessionTenantPrefix('acme-corporation-asia', 'x'),
    sessionTenantPrefix('acme-corporation-europe', 'x'),
  );
  check(
    'uuid-shaped subs stay distinct',
    sessionTenantPrefix('tests', '2f1c9a44-0001-4000-8000-000000000000') !==
      sessionTenantPrefix('tests', '2f1c9a44-0002-4000-8000-000000000000'),
  );
  check(
    'a sub of pure punctuation still yields a usable segment',
    isValidSessionId(mintSessionId('tests', '@@@', uuidStub)),
    mintSessionId('tests', '@@@', uuidStub),
  );
  check(
    'sessionIdTail is the random half, whatever the prefix contributed',
    sessionIdTail('tests-user3-1ea1a17e8e68456ab587986db90a4fc9') === '1ea1a17e8e68456ab587986db90a4fc9' &&
      sessionIdTail(mintSessionId('acme-corporation-europe', '@@@', uuidStub)) === '1ea1a17e8e68456ab587986db90a4fc9',
    sessionIdTail(mintSessionId('acme-corporation-europe', '@@@', uuidStub)),
  );
  check('sessionIdSegment leaves an already-short label alone', sessionIdSegment('user3', 12) === 'user3');
  check('sessionIdSegment compacts mixed-case/punctuated values', sessionIdSegment('User.Three', 12) === 'userthree');

  // --- listSessions(idPrefix) — the GET /sessions listing seam --------------
  // Three sessions across two tenants: fakeKv pages at 2, so the scoped
  // listing also exercises cursor pagination under a prefix.
  const uuidA = () => 'aaaaaaaa-0000-4000-8000-000000000001';
  const uuidB = () => 'bbbbbbbb-0000-4000-8000-000000000002';
  const lkv = fakeKv();
  await putSessionIndex(lkv, mintSessionId('tests', 'user3', uuidA), { agentName: 'trip', createdAt: '2026-08-01T00:00:00Z' });
  await putSessionIndex(lkv, mintSessionId('tests', 'user3', uuidB), { agentName: 'trip', createdAt: '2026-08-02T00:00:00Z' });
  await putSessionIndex(lkv, mintSessionId('tests', 'user4', uuidA), { agentName: 'trip', createdAt: '2026-08-03T00:00:00Z' });
  const scoped = await listSessions(lkv, sessionTenantPrefix('tests', 'user3'));
  check(
    "listSessions(prefix) lists only the tenant's sessions",
    scoped.length === 2 && scoped.every((s) => String(s.id).startsWith('tests-user3-')),
  );
  check('listSessions(prefix) stays newest-first', scoped[0]?.createdAt === '2026-08-02T00:00:00Z');
  check('listSessions without prefix still lists everything', (await listSessions(lkv)).length === 3);
})();

// --- Cloudflare container cost (core/src/cost.js) ---------------------------
// Pure math over the shape containersUsageAdaptiveGroups returns — no network.
// The units are the whole point of these checks: allocatedMemory/allocatedDisk
// are BYTE-seconds, priced per GiB-second and GB-second respectively, and
// getting that conversion wrong is a silent factor-of-a-billion error.
await (async () => {
  console.log('\n== container cost ==');

  const oneHourOf = {
    cpuTimeSec: 3600,
    allocatedMemory: 1024 ** 3 * 3600, // 1 GiB for an hour
    allocatedDisk: 1e9 * 3600, // 1 GB for an hour
    txBytes: 1e9, // 1 GB egress
  };
  const priced = priceContainerUsage(oneHourOf);
  check('cpuTimeSec passes through as vCPU-seconds', priced.cpuSeconds === 3600);
  check('allocatedMemory byte-seconds -> GiB-seconds', priced.memoryGiBSeconds === 3600, String(priced.memoryGiBSeconds));
  check('allocatedDisk byte-seconds -> GB-seconds', priced.diskGBSeconds === 3600, String(priced.diskGBSeconds));
  // Outputs are rounded to 1e-8 (sub-cent sessions), so compare with a tolerance
  // finer than that rather than demanding float equality with the raw product.
  const near = (a, b) => Math.abs(a - b) < 1e-9;
  check('cpu priced at the published rate', near(priced.cost.cpu, 3600 * CONTAINER_RATES.cpuSecond), String(priced.cost.cpu));
  check('memory priced at the published rate', near(priced.cost.memory, 3600 * CONTAINER_RATES.memoryGiBSecond), String(priced.cost.memory));
  check('egress priced per GB', near(priced.cost.egress, CONTAINER_RATES.egressGB), String(priced.cost.egress));
  check(
    'total is the sum of the four lines',
    Math.abs(priced.cost.total - (priced.cost.cpu + priced.cost.memory + priced.cost.disk + priced.cost.egress)) < 1e-9,
  );
  check('absent sums price as zero, not NaN', priceContainerUsage({}).cost.total === 0);
  check('null sums price as zero, not NaN', priceContainerUsage(null).cost.total === 0);

  const response = {
    data: {
      viewer: {
        accounts: [
          {
            containersUsageAdaptiveGroups: [
              { dimensions: { session: 'tests-user3-aaa' }, sum: { cpuTimeSec: 10, allocatedMemory: 0, allocatedDisk: 0, txBytes: 0 } },
              { dimensions: { session: 'tests-user3-bbb' }, sum: { cpuTimeSec: 100, allocatedMemory: 0, allocatedDisk: 0, txBytes: 0 } },
              { dimensions: { session: '' }, sum: { cpuTimeSec: 5, allocatedMemory: 0, allocatedDisk: 0, txBytes: 0 } },
            ],
          },
        ],
      },
    },
  };
  const folded = foldContainerCostResponse(response, 1000);
  check('one row per labelled session', folded.rows.length === 2);
  check('rows are sorted by cost, dearest first', folded.rows[0].sessionId === 'tests-user3-bbb');
  check('an unlabelled group is bucketed, not dropped', folded.unlabeled?.cpuSeconds === 5);
  check('totals include the unlabelled bucket', folded.totals.cpuSeconds === 115, String(folded.totals.cpuSeconds));
  check('truncation is reported, not hidden', foldContainerCostResponse(response, 3).truncated === true);
  check('an empty/erroring response folds to zeroes', foldContainerCostResponse({}, 1000).totals.cost.total === 0);

  const window = utcDayWindow(new Date('2026-07-30T13:45:12.000Z'));
  check('the day window starts at UTC midnight', window.start === '2026-07-30T00:00:00Z', window.start);
  check('the day window ends at "now", not end-of-day', window.end === '2026-07-30T13:45:12Z', window.end);
  check('the window is labelled with its UTC date', window.date === '2026-07-30');

  const query = containerCostQuery({ accountTag: 'acct', start: window.start, end: window.end });
  check('the query groups by the session LABEL (no containerName dimension exists)', query.query.includes('label(name: $label)'));
  check('the query defaults to the `session` label', query.variables.label === 'session');
})();

// --- workspace backups (core/src/backup.js + the backups collection) ---------
// Pure logic over an in-memory R2: listing/pagination, stray tolerance, the
// sweep's session-lifecycle rules, and the per-session cost estimators.
await (async () => {
  console.log('\n== workspace backups ==');

  /**
   * In-memory R2 mimicking the surface backup.js touches: paginated list
   * (page size 2, to force multi-page), get -> { text() }, delete. Values are
   * { body, uploaded? }.
   */
  function fakeR2(initial = {}) {
    const map = new Map(Object.entries(initial));
    const PAGE = 2;
    return {
      _map: map,
      async list(options = {}) {
        const { prefix = '', cursor } = options;
        const all = [...map.keys()].filter((k) => k.startsWith(prefix)).sort();
        const start = cursor ? Number(cursor) : 0;
        const slice = all.slice(start, start + PAGE);
        const next = start + PAGE;
        const truncated = next < all.length;
        return {
          objects: slice.map((key) => {
            const v = map.get(key);
            return { key, size: (v.body ?? '').length, ...(v.uploaded ? { uploaded: v.uploaded } : {}) };
          }),
          truncated,
          ...(truncated ? { cursor: String(next) } : {}),
        };
      },
      async get(key) {
        const v = map.get(key);
        return v === undefined ? null : { text: async () => v.body };
      },
      async delete(key) {
        map.delete(key);
      },
    };
  }

  const NOW = Date.parse('2026-08-05T00:00:00.000Z');
  const OLD = '2026-08-01T00:00:00.000Z'; // 4 days before NOW — far past the 1 h grace
  const YOUNG = '2026-08-04T23:50:00.000Z'; // 10 min before NOW — inside the grace
  const meta = (id, name, extra = {}) =>
    JSON.stringify({ id, dir: '/workspace', name, sizeBytes: 4096, ttl: 30 * 24 * 3600, createdAt: OLD, ...extra });
  const seed = (id, body, uploaded = OLD) => ({
    [`${BACKUP_PREFIX}${id}/data.sqsh`]: { body: 'SQSH', uploaded },
    ...(body === null ? {} : { [`${BACKUP_PREFIX}${id}/meta.json`]: { body, uploaded } }),
  });

  check(
    'backupKeys derives both object keys',
    backupKeys('b1').archive === 'backups/b1/data.sqsh' && backupKeys('b1').meta === 'backups/b1/meta.json',
  );

  // --- listBackups: pagination, tolerance, ordering ------------------------
  const lr2 = fakeR2({
    ...seed('b-old', meta('b-old', 'sess-1')),
    ...seed('b-new', meta('b-new', 'sess-2', { createdAt: '2026-08-03T00:00:00.000Z' })),
    ...seed('b-stray', null), // archive without meta.json
    ...seed('b-broken', 'not json at all'),
    'unrelated/key.txt': { body: 'ignore me' },
  });
  const listed = await listBackups(lr2);
  check('listBackups walks every page and skips non-backup keys', listed.length === 4, `got ${listed.length}`);
  check('listBackups is newest-first by createdAt', listed[0]?.id === 'b-new', listed.map((b) => b.id).join(','));
  check('listBackups surfaces meta fields', listed.find((b) => b.id === 'b-old')?.name === 'sess-1' && listed.find((b) => b.id === 'b-old')?.sizeBytes === 4096);
  check('a meta-less archive is flagged, not skipped', listed.find((b) => b.id === 'b-stray')?.metaMissing === true);
  check('an unparseable meta is flagged, not fatal', listed.find((b) => b.id === 'b-broken')?.malformed === true);
  check('strays fall back to the archive object size', listed.find((b) => b.id === 'b-stray')?.sizeBytes === 4);

  await deleteBackup(lr2, 'b-old');
  check(
    'deleteBackup removes both objects',
    !lr2._map.has('backups/b-old/data.sqsh') && !lr2._map.has('backups/b-old/meta.json'),
  );

  // --- the backups collection ---------------------------------------------
  const ckv = fakeKv({ 'session:sess-2': JSON.stringify({ id: 'sess-2', session_backup: { backup_id: 'b-new' } }) });
  const cdeps = { kv: ckv, r2: lr2 };
  const clist = await listCollectionRecords('backups', cdeps);
  check('listCollectionRecords(backups) labels rows with the session id', clist.records.find((r) => r.id === 'b-new')?.label === 'sess-2');
  check('listCollectionRecords(backups) exposes createdAt as sublabel', clist.records.find((r) => r.id === 'b-new')?.sublabel === '2026-08-03T00:00:00.000Z');
  check('listCollectionRecords(backups) groups strays', clist.records.find((r) => r.id === 'b-stray')?.group === 'strays');
  const unconfigured = await listCollectionRecords('backups', { kv: ckv });
  check('listCollectionRecords(backups) without the binding reports off, not error', unconfigured.records.length === 0 && typeof unconfigured.note === 'string');
  const cdetail = await readCollectionRecord('backups', 'b-new', cdeps);
  check('readCollectionRecord(backups) returns meta + session existence', cdetail?.kind === 'backup' && cdetail?.sessionId === 'sess-2' && cdetail?.sessionExists === true);
  check('readCollectionRecord(backups) prices the stored size', cdetail?.storageMonthlyUsd === backupStorageMonthlyUsd(4096));
  check('readCollectionRecord(backups) missing id -> null', (await readCollectionRecord('backups', 'nope', cdeps)) === null);
  check('readCollectionRecord(backups) without the binding -> null', (await readCollectionRecord('backups', 'b-new', { kv: ckv })) === null);

  // --- sweep: the session-lifecycle rules ----------------------------------
  const skv = fakeKv({
    'session:sess-live': JSON.stringify({ id: 'sess-live', session_backup: { backup_id: 'b-live' } }),
    'session:sess-ttl': JSON.stringify({ id: 'sess-ttl', session_backup: { backup_id: 'b-ttl' } }),
    'session:sess-bad': 'not json',
    'session:github:v1:owner:adenin:repo:demo:issue:12': JSON.stringify({
      id: 'github:v1:owner:adenin:repo:demo:issue:12',
      session_backup: { backup_id: 'b-chan' },
    }),
  });
  const sr2 = fakeR2({
    ...seed('b-live', meta('b-live', 'sess-live')), // kept: record exists, current id
    ...seed('b-super', meta('b-super', 'sess-live')), // deleted: record points at b-live (rule b)
    ...seed('b-gone', meta('b-gone', 'sess-gone')), // deleted: no record (rule a)
    ...seed('b-young', meta('b-young', 'sess-young', { createdAt: YOUNG })), // kept: inside grace
    ...seed('b-ttl', meta('b-ttl', 'sess-ttl', { ttl: 3600 })), // deleted: SDK ttl elapsed (rule c)
    ...seed('b-noname', meta('b-noname', null)), // deleted: nameless stray (rule c)
    ...seed('b-broken2', 'not json'), // deleted: malformed meta (rule c)
    ...seed('b-stray2', null), // deleted: archive without meta (rule c/d)
    ...seed('b-badrec', meta('b-badrec', 'sess-bad')), // kept: unreadable record — conservative
    ...seed('b-chan', meta('b-chan', 'github:v1:owner:adenin:repo:demo:issue:12')), // kept: channel id, no RE gate
  });
  const swept = await sweepOrphanedBackups(sr2, skv, { now: NOW });
  check('sweep scans every backup', swept.scanned === 10, `scanned ${swept.scanned}`);
  check('sweep deletes exactly the over-rules set', swept.deleted === 6, `deleted ${swept.deleted}`);
  check('sweep keeps the rest', swept.kept === 4, `kept ${swept.kept}`);
  check('sweep keeps the live current backup', sr2._map.has('backups/b-live/data.sqsh'));
  check('sweep keeps a young orphan (grace)', sr2._map.has('backups/b-young/data.sqsh'));
  check('sweep keeps backups of unreadable records (conservative)', sr2._map.has('backups/b-badrec/data.sqsh'));
  check('sweep keeps channel-session backups (no session-id RE gate)', sr2._map.has('backups/b-chan/data.sqsh'));
  check('sweep removes the superseded orphan', !sr2._map.has('backups/b-super/data.sqsh'));
  check('sweep removes session-gone backups', !sr2._map.has('backups/b-gone/data.sqsh') && !sr2._map.has('backups/b-gone/meta.json'));
  check('sweep removes ttl-elapsed backups even when current', !sr2._map.has('backups/b-ttl/data.sqsh'));
  check('sweep removes nameless/malformed/meta-less strays', !sr2._map.has('backups/b-noname/data.sqsh') && !sr2._map.has('backups/b-broken2/data.sqsh') && !sr2._map.has('backups/b-stray2/data.sqsh'));

  // --- cost estimators ------------------------------------------------------
  check('1 GB stores at $0.015/mo', backupStorageMonthlyUsd(1e9) === 0.015, String(backupStorageMonthlyUsd(1e9)));
  check('absent size prices as zero, not NaN', backupStorageMonthlyUsd(null) === 0 && backupStorageMonthlyUsd(undefined) === 0);
  const ops10 = backupOpsUsd(10);
  const near = (a, b) => Math.abs(a - b) < 1e-9;
  check(
    'ops estimate: 2 Class A + 2 Class B per backup at list price',
    near(ops10, 10 * 2 * (R2_RATES.classAPerMillion / 1e6) + 10 * 2 * (R2_RATES.classBPerMillion / 1e6)),
    String(ops10),
  );
  check('absent count prices as zero, not NaN', backupOpsUsd(null) === 0);
})();

// --- better-auth session cookie (core/src/identity.js) ---------------------
// The chat gate's second credential. Offline: the two upstream endpoints are a
// fake fetch, so what is asserted here is OUR contract — which header forms are
// accepted, what travels upstream, and that the exchange is cached by the
// cookie's HASH rather than repeated (and rewritten onto the session record) on
// every chat request.
await (async () => {
  console.log('\n== better-auth session cookie ==');

  const COOKIE = 'sess-token-abc.sig-def';
  const JWT = 'eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ1c2VyMyJ9.c2ln';
  const JWT2 = 'eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ1c2VyMyIsIm4iOjJ9.c2ln';

  // --- extractSessionCookie ---
  check(
    'the custom header is accepted (the only form a browser can send)',
    extractSessionCookie(new Headers({ 'x-better-auth-cookie': COOKIE })) === COOKIE,
  );
  check(
    'a real Cookie header is accepted — __Secure- name (HTTPS)',
    extractSessionCookie(new Headers({ cookie: `__Secure-better-auth.session_token=${COOKIE}` })) === COOKIE,
  );
  check(
    'a real Cookie header is accepted — bare name (plain HTTP)',
    extractSessionCookie(new Headers({ cookie: `better-auth.session_token=${COOKIE}` })) === COOKIE,
  );
  check(
    'unrelated cookies in the jar are skipped, not returned',
    extractSessionCookie(new Headers({ cookie: `theme=dark; better-auth.session_token=${COOKIE}; other=1` })) === COOKIE,
  );
  check(
    'the custom header wins over a Cookie header',
    extractSessionCookie(new Headers({ 'x-better-auth-cookie': COOKIE, cookie: 'better-auth.session_token=stale' })) ===
      COOKIE,
  );
  check('no better-auth cookie -> null', extractSessionCookie(new Headers({ cookie: 'theme=dark' })) === null);
  check('no cookie headers at all -> null', extractSessionCookie(new Headers()) === null);

  /** Fake /session + /session/token, recording every call. */
  function fakeUpstream({ org = 'tests', sessionStatus = 200, jwt = JWT, tokenBody } = {}) {
    const calls = [];
    const fetchImpl = async (url, init = {}) => {
      calls.push({ url, init });
      if (url.endsWith('/session')) {
        if (sessionStatus !== 200) return new Response('no session', { status: sessionStatus });
        return new Response(
          JSON.stringify({
            session: { id: 'sess1', expiresAt: '2026-08-02T00:00:00Z' },
            user: { org, sub: 'user3', name: 'Wei Chen', email: 'admin@test.com', extra: 'dropped' },
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify(tokenBody ?? { token: jwt }), { status: 200 });
    };
    return { calls, fetchImpl };
  }

  const options = (kv) => ({ baseUrl: 'https://api.semantius.cloud', exchangeKey: 'xk', kv });

  // --- happy path ---
  const kv = fakeKv();
  const up = fakeUpstream();
  const verdict = await verifySemantiusCookie(COOKIE, options(kv), up.fetchImpl);
  check('a valid cookie verifies', verdict.ok === true, verdict.error ?? '');
  check('the org comes from /session user.org', verdict.org === 'tests', String(verdict.org));
  check('the jwt is the exchanged one', verdict.jwt === JWT);
  check(
    'the verdict user is the projected claim set, same as the bearer path',
    verdict.user?.sub === 'user3' &&
      verdict.user?.org === 'tests' &&
      verdict.user?.name === 'Wei Chen' &&
      verdict.user?.email === 'admin@test.com' &&
      typeof verdict.user?.verifiedAt === 'string' &&
      verdict.user?.extra === undefined,
    JSON.stringify(verdict.user),
  );
  check('both endpoints are called, /session first', up.calls.length === 2 && up.calls[0].url.endsWith('/session') && up.calls[1].url.endsWith('/session/token'));
  check(
    'the cookie is forwarded to /session as a rebuilt Cookie header',
    up.calls[0].init.headers.cookie === `__Secure-better-auth.session_token=${COOKIE}`,
    up.calls[0].init.headers.cookie,
  );
  check(
    'the exchange sends the api key and the cookie VALUE in the body',
    up.calls[1].init.headers['x-jwt-exchange-api-key'] === 'xk' && JSON.parse(up.calls[1].init.body).sessionCookie === COOKIE,
  );

  const cacheKeys = [...kv._map.keys()].filter((k) => k.startsWith(SESSION_JWT_KEY_PREFIX));
  check('the exchange is cached under one authjwt: key', cacheKeys.length === 1, cacheKeys.join(','));
  check(
    'the cache key is the cookie HASH — the cookie itself is never stored',
    cacheKeys[0].length === SESSION_JWT_KEY_PREFIX.length + 64 &&
      !cacheKeys[0].includes(COOKIE) &&
      !JSON.stringify([...kv._map.values()]).includes(COOKIE),
    cacheKeys[0],
  );

  // --- cache hit: /session still runs (it is the authn), the exchange does not ---
  const warm = fakeUpstream({ jwt: JWT2 });
  const second = await verifySemantiusCookie(COOKIE, options(kv), warm.fetchImpl);
  check('a cached exchange is reused', second.ok === true && second.jwt === JWT, second.jwt);
  check(
    'a cache hit still validates the cookie but skips the exchange',
    warm.calls.length === 1 && warm.calls[0].url.endsWith('/session'),
    warm.calls.map((c) => c.url).join(','),
  );

  // --- switching active organization must not reuse the other tenant's token ---
  const switched = fakeUpstream({ org: 'other', jwt: JWT2 });
  const third = await verifySemantiusCookie(COOKIE, options(kv), switched.fetchImpl);
  check(
    'a cached token for a different org is discarded and re-exchanged',
    third.ok === true && third.org === 'other' && third.jwt === JWT2 && switched.calls.length === 2,
    `${third.org}/${switched.calls.length}`,
  );

  // --- rejections ---
  const bad = fakeUpstream({ sessionStatus: 401 });
  const rejected = await verifySemantiusCookie(COOKIE, options(fakeKv()), bad.fetchImpl);
  check('an invalid session is rejected with the issuer status', rejected.ok === false && rejected.status === 401);
  check('a rejected session never reaches the exchange', bad.calls.length === 1);

  const unused = fakeUpstream();
  const malformed = await verifySemantiusCookie('has spaces; and=semicolons', options(fakeKv()), unused.fetchImpl);
  check('a malformed cookie is rejected without any network call', malformed.ok === false && unused.calls.length === 0);

  const noKey = await verifySemantiusCookie(COOKIE, { kv: fakeKv() }, fakeUpstream().fetchImpl);
  check('no exchange key bound server-side -> rejected, never open', noKey.ok === false);

  const noOrg = fakeUpstream({ org: '' });
  const orgless = await verifySemantiusCookie(COOKIE, options(fakeKv()), noOrg.fetchImpl);
  check('a session with no active organization is rejected', orgless.ok === false && noOrg.calls.length === 1);

  const junk = fakeUpstream({ tokenBody: { token: 'not-a-jwt' } });
  const junkVerdict = await verifySemantiusCookie(COOKIE, options(fakeKv()), junk.fetchImpl);
  check('an exchange that returns a non-JWS is rejected', junkVerdict.ok === false);

  const aliased = fakeUpstream({ tokenBody: { access_token: JWT } });
  const aliasVerdict = await verifySemantiusCookie(COOKIE, options(fakeKv()), aliased.fetchImpl);
  check('the exchange response field may be token | access_token | jwt', aliasVerdict.ok === true && aliasVerdict.jwt === JWT);

  const kvless = await verifySemantiusCookie(COOKIE, { exchangeKey: 'xk' }, fakeUpstream().fetchImpl);
  check('no KV bound -> still verifies, just uncached', kvless.ok === true && kvless.jwt === JWT);

  // --- POST /session/copilot: the ORG's settings -------------------------
  // Read once at session creation, not on the auth path. The two booleans
  // decide whether a session may exist at all and how wide its egress is, so
  // every ambiguous answer has to land on the RESTRICTIVE reading.
  console.log('\n== org copilot settings ==');

  /** Fake /session/copilot, recording every call. */
  function fakeCopilot(body, status = 200) {
    const calls = [];
    const fetchImpl = async (url, init = {}) => {
      calls.push({ url, init });
      return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
    };
    return { calls, fetchImpl };
  }
  const copilotOptions = { baseUrl: 'https://api.semantius.cloud', exchangeKey: 'xk' };

  const cop = fakeCopilot({ copilotEnabled: true, copilotFirewallEnabled: true, copilotFirewallAllowlist: ['example.com', 'api.acme.io'] });
  const settings = await fetchCopilotSettings(COOKIE, copilotOptions, cop.fetchImpl);
  check('copilot settings are read', settings.ok === true, settings.error ?? '');
  check('the endpoint is POST /session/copilot', cop.calls[0].url === 'https://api.semantius.cloud/session/copilot' && cop.calls[0].init.method === 'POST');
  check('it sends the exchange api key', cop.calls[0].init.headers['x-jwt-exchange-api-key'] === 'xk');
  check('it sends the cookie VALUE in the body', JSON.parse(cop.calls[0].init.body).sessionCookie === COOKIE);
  check('the allow list comes back sanitized', JSON.stringify(settings.allowlist) === '["example.com","api.acme.io"]');
  check('enabled + firewallEnabled are surfaced', settings.enabled === true && settings.firewallEnabled === true);

  const off = await fetchCopilotSettings(COOKIE, copilotOptions, fakeCopilot({ copilotEnabled: true, copilotFirewallEnabled: false, copilotFirewallAllowlist: [] }).fetchImpl);
  check('a disabled firewall is reported as such (the caller turns it into *)', off.ok === true && off.firewallEnabled === false);

  const disabled = await fetchCopilotSettings(COOKIE, copilotOptions, fakeCopilot({ copilotEnabled: false, copilotFirewallEnabled: true, copilotFirewallAllowlist: [] }).fetchImpl);
  check('copilotEnabled:false comes back as not-enabled', disabled.ok === true && disabled.enabled === false);

  const empty = await fetchCopilotSettings(COOKIE, copilotOptions, fakeCopilot({}).fetchImpl);
  check('an EMPTY body is not enabled (restrictive default)', empty.ok === true && empty.enabled === false);
  check('an empty body is FIREWALLED (restrictive default)', empty.firewallEnabled === true && empty.allowlist.length === 0);

  const stringy = await fetchCopilotSettings(COOKIE, copilotOptions, fakeCopilot({ copilotEnabled: 'true', copilotFirewallEnabled: 'false' }).fetchImpl);
  check('stringy booleans are not truthy-coerced', stringy.enabled === false && stringy.firewallEnabled === true);

  const dirty = await fetchCopilotSettings(COOKIE, copilotOptions, fakeCopilot({ copilotEnabled: true, copilotFirewallAllowlist: ['ok.com', 42, 'bad host', 'ok.com'] }).fetchImpl);
  check('junk entries are dropped, not fatal', dirty.ok === true && JSON.stringify(dirty.allowlist) === '["ok.com"]');

  const forbidden = await fetchCopilotSettings(COOKIE, copilotOptions, fakeCopilot({ error: 'nope' }, 403).fetchImpl);
  check('a 403 is a verdict carrying the status', forbidden.ok === false && forbidden.status === 403);

  const notJson = await fetchCopilotSettings(COOKIE, copilotOptions, fakeCopilot('<html>oops</html>').fetchImpl);
  check('a non-JSON 200 is rejected, never read as enabled', notJson.ok === false);

  const unreachable = await fetchCopilotSettings(COOKIE, copilotOptions, async () => { throw new Error('boom'); });
  check('a network failure is a verdict, not a throw', unreachable.ok === false && unreachable.error.includes('unreachable'));

  const noCopilotKey = fakeCopilot({ copilotEnabled: true });
  const keyless = await fetchCopilotSettings(COOKIE, { baseUrl: 'https://api.semantius.cloud' }, noCopilotKey.fetchImpl);
  check('no exchange key bound -> rejected without a network call', keyless.ok === false && noCopilotKey.calls.length === 0);

  const badCookie = fakeCopilot({ copilotEnabled: true });
  const malformedCookie = await fetchCopilotSettings('has space; and semi', copilotOptions, badCookie.fetchImpl);
  check('a malformed cookie never reaches the network', malformedCookie.ok === false && badCookie.calls.length === 0);
})();

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}  (${total} checks)`);
process.exit(failures === 0 ? 0 : 1);
