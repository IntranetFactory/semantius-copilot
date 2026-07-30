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
  adminCollections,
  listCollectionRecords,
  readCollectionRecord,
} from '../core/src/admin.js';
import {
  isValidSessionId,
  mintSessionId,
  sessionIdSegment,
  sessionIdTail,
  sessionTenantPrefix,
  SESSION_ID_MAX,
} from '../core/src/config.js';
import { startRun } from './lib/report.mjs';
import {
  egressSecretForHost,
  ensureEgressPolicy,
  injectAndForward,
  putContainerPointer,
  resolveEgressPolicy,
} from '../core/src/egress.js';

// Results go to a structured run record (scripts/lib/report.mjs); stdout is
// just the live view. Read the outcome with `pnpm report unit`.
const run = startRun('unit');
function check(name, ok, detail = '') {
  run.check({ name, ok, detail });
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

  // --- collections descriptor --------------------------------------------
  const cols = adminCollections('STORE');
  check('adminCollections exposes kv/sessions', cols.map((c) => c.id).join(',') === 'kv,sessions');
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

  // --- generic record detail ---------------------------------------------
  const kvDetail = await readCollectionRecord('kv', 'agent:9f8a', deps);
  check('readCollectionRecord(kv) returns parsed value', kvDetail?.kind === 'kv' && kvDetail?.json?.agentName === 'trip-planner');
  const sessDetail = await readCollectionRecord('sessions', '9f8a', deps);
  check('readCollectionRecord(sessions) returns the session', sessDetail?.kind === 'session' && sessDetail?.session?.backend === 'b');
  check('readCollectionRecord(kv) missing -> null', (await readCollectionRecord('kv', 'nope', deps)) === null);
  check('readCollectionRecord(runs) is gone in v2', (await readCollectionRecord('runs', 'run-1', deps)) === null);
  check('readCollectionRecord(unknown) -> null', (await readCollectionRecord('zzz', 'x', deps)) === null);

  // --- egress_secrets: host-glob lookup, mint-if-absent, fail-closed -------
  // The record field is a MAP (host glob -> credential the sandbox never
  // holds), so these cover the three rules that make it safe: match by the same
  // globber as the whitelist, never rotate a warm credential, and deny when a
  // host has no entry (that last one is plan §13 C5 — an expired chat session
  // whose policy self-heals must not get egress back).
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
  await ensureEgressPolicy(skv2, 'cid-m', 'sess-m', { ...desired, mintSecrets: () => ({ 'postman-echo.com': 'minted-1' }) });
  const firstMint = (await readSession(skv2, 'sess-m'))?.egress_secrets?.['postman-echo.com'];
  await ensureEgressPolicy(skv2, 'cid-m', 'sess-m', { ...desired, mintSecrets: () => ({ 'postman-echo.com': 'minted-2' }) });
  const secondMint = (await readSession(skv2, 'sess-m'))?.egress_secrets?.['postman-echo.com'];
  check('ensureEgressPolicy mints a missing credential', firstMint === 'minted-1');
  check('ensureEgressPolicy never rotates a warm credential', secondMint === 'minted-1');
  await ensureEgressPolicy(skv2, 'cid-m', 'sess-m', { ...desired, mintSecrets: () => ({ '*.partner.example': 'minted-3' }) });
  const grown = (await readSession(skv2, 'sess-m'))?.egress_secrets;
  check(
    'ensureEgressPolicy adds a new host without touching the existing one',
    grown?.['*.partner.example'] === 'minted-3' && grown?.['postman-echo.com'] === 'minted-1',
  );
  await ensureEgressPolicy(skv2, 'cid-n', 'sess-n', desired);
  check(
    'ensureEgressPolicy without mintSecrets heals the whitelist but no credential (C5)',
    (await readSession(skv2, 'sess-n'))?.egress_secrets === undefined &&
      (await readSession(skv2, 'sess-n'))?.whitelist?.[0] === 'postman-echo.com',
  );

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
  check('sessionTenantPrefix matches what mintSessionId emits', mintSessionId('tests', 'user3', uuidStub).startsWith(sessionTenantPrefix('tests', 'user3')));
  check('minted id passes the session-id shape gate', isValidSessionId(mintSessionId('tests', 'user3', uuidStub)));
  check(
    'minted id fits the sandbox SDK 63-char ceiling for worst-case identities',
    mintSessionId('a'.repeat(63), 'b'.repeat(200), uuidStub).length <= SESSION_ID_MAX,
    `${mintSessionId('a'.repeat(63), 'b'.repeat(200), uuidStub).length} chars`,
  );
  check(
    'long identities stay distinct after truncation (hash disambiguator)',
    sessionTenantPrefix('acme-corporation-europe', 'x') !== sessionTenantPrefix('acme-corporation-asia', 'x'),
    `${sessionTenantPrefix('acme-corporation-europe', 'x')} vs ${sessionTenantPrefix('acme-corporation-asia', 'x')}`,
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
  check('sessionIdSegment lowercases and slugs', /^[a-z0-9][a-z0-9-]*$/.test(sessionIdSegment('User.Three', 12)));
})();

process.exit(run.finish());
