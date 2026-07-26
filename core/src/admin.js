/**
 * Read-only admin/data-browser seam (host-agnostic).
 *
 * The two backends persist all their app-owned durable state in a single KV
 * namespace each (A: SECRETS, B: STORE). These helpers enumerate and read that
 * namespace so a frontend can navigate and inspect every stored entry. They are
 * pure logic over the minimal KV shape ({ list, get }); the backends wire them
 * to Hono routes behind the existing API-key guard.
 *
 * READ ONLY by design: the data browser never mutates state. Values can be
 * large (skill bundles), so listing returns keys only — values are fetched
 * one entry at a time.
 *
 * @typedef {Object} KvLike
 * @property {(options?: { cursor?: string, prefix?: string }) => Promise<{ keys: Array<{ name: string, expiration?: number, metadata?: unknown }>, list_complete: boolean, cursor?: string }>} list
 * @property {(key: string) => Promise<string | null>} get
 */

/** The stable prefixes this app writes, with human labels for the browser. */
export const KV_GROUPS = {
  session: 'Session index (one record per agent session/conversation id)',
  agentdef: 'Named agent definition (deployed via pnpm deploy:agent; no TTL)',
  agent: 'Agent bundle (one immutable per-session snapshot of a named definition)',
  bearer: 'Per-container egress bearer (containerId -> token)',
  tag: 'Per-container tenant tag (containerId -> tenant)',
  whitelist: 'Per-container egress whitelist (containerId -> allowed hosts)',
};

export const SESSION_KEY_PREFIX = 'session:';
export const SESSION_TTL_SECONDS = 24 * 60 * 60;

/**
 * Named agent definitions (`agentdef:<name>`) are the deployable artifacts
 * behind `pnpm deploy:agent <name>`: no TTL, overwritten on every deploy.
 * Deliberately a DIFFERENT prefix from the per-session `agent:<id>` snapshots —
 * agent names and session ids draw from overlapping alphabets, so sharing the
 * prefix would let a session id shadow (or delete) a deployed definition.
 */
export const AGENT_DEF_KEY_PREFIX = 'agentdef:';

/** Group a key by the segment before its first ':' (e.g. `agent:abc` -> `agent`). */
export function kvGroupOf(name) {
  const i = name.indexOf(':');
  return i === -1 ? '(ungrouped)' : name.slice(0, i);
}

/**
 * Enumerate every key in the namespace (following list pagination), sorted by
 * name. Returns keys with their group, TTL expiration, and any list metadata —
 * never the values.
 *
 * @param {KvLike} kv
 * @returns {Promise<Array<{ name: string, group: string, expiration: number | null, metadata: unknown }>>}
 */
export async function listKvEntries(kv) {
  const out = [];
  let cursor;
  // Bounded loop guard: KV list is cursor-paginated; stop when complete.
  for (let page = 0; page < 1000; page++) {
    const res = await kv.list(cursor ? { cursor } : undefined);
    for (const k of res.keys) {
      out.push({
        name: k.name,
        group: kvGroupOf(k.name),
        expiration: k.expiration ?? null,
        metadata: k.metadata ?? null,
      });
    }
    if (res.list_complete || !res.cursor) break;
    cursor = res.cursor;
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/**
 * Read one value, parsing JSON when possible so the browser can render a tree.
 *
 * @param {KvLike} kv
 * @param {string} key
 * @returns {Promise<{ key: string, value: string, size: number, json: unknown } | null>} null when the key is absent
 */
export async function readKvEntry(kv, key) {
  const value = await kv.get(key);
  if (value === null || value === undefined) return null;
  let json = null;
  try {
    json = JSON.parse(value);
  } catch {
    json = null;
  }
  return { key, value, size: value.length, json };
}

// ---------------------------------------------------------------------------
// Session index — the enumeration seam for agent conversations.
//
// Durable Object instances (the per-conversation FlueHothAgent DOs holding the
// SQLite conversation stream) cannot be listed by the platform, and Flue has
// no cross-conversation index. So to let the browser enumerate sessions
// without knowing ids upfront, each backend records one `session:<id>` KV
// entry when it provisions a session. This is the only durable record that
// maps a browsable id back to a conversation.
// ---------------------------------------------------------------------------

/**
 * Record (or refresh) a session in the index. Best-effort and non-fatal: a
 * failure here must never break session provisioning, so callers swallow errors.
 *
 * @param {{ put(k: string, v: string, o?: object): Promise<void> }} kv
 * @param {string} id session/conversation id
 * @param {Record<string, unknown>} [meta] extra fields (backend, containerId, tenantTag, …)
 */
export async function putSessionIndex(kv, id, meta = {}) {
  const record = { id, ...meta };
  await kv.put(SESSION_KEY_PREFIX + id, JSON.stringify(record), { expirationTtl: SESSION_TTL_SECONDS });
}

/**
 * List every indexed session, newest first by `createdAt`. Reads each value
 * (small JSON), so it costs one KV get per session — fine at POC cardinality.
 *
 * `createdAt` is an ISO-8601 UTC string, which sorts lexicographically in
 * chronological order — no Date parsing needed. Records written before the
 * index carried a timestamp (or with a malformed one) sort last, then by id, so
 * they stay reachable instead of being interleaved unpredictably.
 *
 * @param {KvLike} kv
 * @returns {Promise<Array<{ id: string, [k: string]: unknown }>>}
 */
export async function listSessions(kv) {
  const keys = [];
  let cursor;
  for (let page = 0; page < 1000; page++) {
    const res = await kv.list({ prefix: SESSION_KEY_PREFIX, ...(cursor ? { cursor } : {}) });
    for (const k of res.keys) keys.push(k.name);
    if (res.list_complete || !res.cursor) break;
    cursor = res.cursor;
  }
  const out = [];
  for (const name of keys) {
    const raw = await kv.get(name);
    if (raw === null || raw === undefined) continue;
    try {
      out.push(JSON.parse(raw));
    } catch {
      out.push({ id: name.slice(SESSION_KEY_PREFIX.length), raw });
    }
  }
  out.sort((a, b) => {
    const ta = typeof a.createdAt === 'string' ? a.createdAt : '';
    const tb = typeof b.createdAt === 'string' ? b.createdAt : '';
    if (ta && tb && ta !== tb) return tb.localeCompare(ta); // newest first
    if (ta && !tb) return -1;
    if (!ta && tb) return 1;
    return String(a.id).localeCompare(String(b.id));
  });
  return out;
}

/**
 * Remove a session from the index (called on session teardown). Best-effort.
 *
 * @param {{ delete(k: string): Promise<void> }} kv
 * @param {string} id
 */
export async function removeSessionIndex(kv, id) {
  await kv.delete(SESSION_KEY_PREFIX + id);
}

/**
 * Read one session-index record.
 *
 * @param {KvLike} kv
 * @param {string} id
 * @returns {Promise<Record<string, unknown> | null>}
 */
export async function readSession(kv, id) {
  const raw = await kv.get(SESSION_KEY_PREFIX + id);
  if (raw === null || raw === undefined) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return { id, raw };
  }
}

// ---------------------------------------------------------------------------
// Generic collection model — powers the frontend's entities -> records ->
// record tree. Every backing store (KV, the session index) is presented as a
// "collection" of "records" so the browser is generic. Cloudflare specifics
// are injected via `deps` so this file stays host-agnostic. (Flue v2 removed
// the beta workflow-run registry, so the former `runs` collection is gone —
// chat conversations were never in it; they live under Agent sessions.)
//
// @typedef {Object} AdminDeps
// @property {KvLike} kv
// ---------------------------------------------------------------------------

/** The collections a backend exposes, given its KV namespace name. */
export function adminCollections(kvName) {
  return [
    { id: 'kv', label: `KV · ${kvName}`, kind: 'kv', description: 'Raw key/value entries (agent bundles, bearers, tags, session index).' },
    { id: 'sessions', label: 'Agent sessions', kind: 'sessions', description: 'One record per conversation id (from the session index).' },
  ];
}

/**
 * List the records of one collection.
 * @returns {Promise<{ records: Array<{ id: string, label: string, group?: string, meta?: unknown }>, note?: string }>}
 */
export async function listCollectionRecords(collectionId, deps) {
  if (collectionId === 'kv') {
    const keys = await listKvEntries(deps.kv);
    return {
      records: keys.map((k) => ({ id: k.name, label: k.name, group: k.group, meta: { expiration: k.expiration } })),
    };
  }
  if (collectionId === 'sessions') {
    const sessions = await listSessions(deps.kv);
    return {
      records: sessions.map((s) => ({
        id: String(s.id),
        label: String(s.id),
        // Rendered as a secondary column in the list; the frontend localises it.
        sublabel: typeof s.createdAt === 'string' ? s.createdAt : undefined,
        group: s.backend ? `backend ${s.backend}` : undefined,
        meta: s,
      })),
      note: sessions.length === 0 ? 'No sessions indexed yet — start one in the Chat tab.' : undefined,
    };
  }
  return null; // unknown collection
}

/**
 * Read one record's detail.
 * @returns {Promise<{ kind: string, id: string, [k: string]: unknown } | null>}
 */
export async function readCollectionRecord(collectionId, recordId, deps) {
  if (collectionId === 'kv') {
    const entry = await readKvEntry(deps.kv, recordId);
    return entry ? { kind: 'kv', ...entry } : null;
  }
  if (collectionId === 'sessions') {
    const session = await readSession(deps.kv, recordId);
    return session ? { kind: 'session', id: recordId, session } : null;
  }
  return null;
}
