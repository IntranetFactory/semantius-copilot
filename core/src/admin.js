/**
 * Read-only admin/data-browser seam (host-agnostic).
 *
 * The backend persists all its app-owned durable state in a single KV
 * namespace (STORE). These helpers enumerate and read that namespace so a
 * frontend can navigate and inspect every stored entry. They are pure logic
 * over the minimal KV shape ({ list, get }); the backend wires them to Hono
 * routes behind the existing API-key guard.
 *
 * READ ONLY by design: the data browser never mutates state. Values can be
 * large (skill bundles), so listing returns keys only — values are fetched
 * one entry at a time. The one exception is the SESSION records: they are small
 * JSON and the browser reads all of them to date and order the key list
 * (sessionDateIndex), the same cost `listSessions` already accepts.
 *
 * @typedef {Object} KvLike
 * @property {(options?: { cursor?: string, prefix?: string }) => Promise<{ keys: Array<{ name: string, expiration?: number, metadata?: unknown }>, list_complete: boolean, cursor?: string }>} list
 * @property {(key: string) => Promise<string | null>} get
 */

/** The stable prefixes this app writes, with human labels for the browser. */
export const KV_GROUPS = {
  session: 'THE session record: meta, egress fields (bearer/whitelist), session_context, payload, session_data, session_state',
  agentdef: 'Named agent definition (deployed via pnpm deploy:agent; no TTL)',
  agent: 'Agent bundle (one immutable per-session snapshot of a named definition)',
  container: 'Container pointer (containerId -> session id; the only containerId-keyed entry)',
  authjwt:
    'Exchanged Semantius JWT for one better-auth session cookie, keyed by the cookie\'s SHA-256 (never the cookie itself). 1 h TTL; see verifySemantiusCookie',
};

export const SESSION_KEY_PREFIX = 'session:';
export const SESSION_TTL_SECONDS = 24 * 60 * 60;

/**
 * The two other session-scoped prefixes, spelled out here rather than imported:
 * `egress.js` already imports THIS module, so importing its CONTAINER_KEY_PREFIX
 * back would make the core module graph circular. Both are documented above in
 * KV_GROUPS; they exist here only so the browser can date those keys.
 */
const AGENT_SNAPSHOT_KEY_PREFIX = 'agent:';
const CONTAINER_POINTER_KEY_PREFIX = 'container:';

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
// THE session record (`session:<id>`) — one mutable document per session.
//
// Durable Object instances (the per-conversation agent DOs holding the SQLite
// conversation stream) cannot be listed by the platform, so this record is
// what makes a session enumerable — and since the single-record refactor it
// also carries everything else session-scoped that is not the (large,
// immutable) bundle snapshot: the egress fields (egress_secrets, whitelist) the
// outbound proxy reads via the container pointer, and the four data channels
// (session_context, payload, session_data, session_state) — plus containerId
// (derivable via idFromName, stored for visibility).
// ---------------------------------------------------------------------------

/**
 * Record (or refresh) a session in the index. Best-effort and non-fatal: a
 * failure here must never break session provisioning, so callers swallow errors.
 *
 * @param {{ put(k: string, v: string, o?: object): Promise<void> }} kv
 * @param {string} id session/conversation id
 * @param {Record<string, unknown>} [meta] extra fields (backend, containerId, agentName, …)
 */
export async function putSessionIndex(kv, id, meta = {}) {
  const record = { id, ...meta };
  await kv.put(SESSION_KEY_PREFIX + id, JSON.stringify(record), { expirationTtl: SESSION_TTL_SECONDS });
}

/**
 * List indexed sessions, newest first by `createdAt`. Reads each value
 * (small JSON), so it costs one KV get per session — fine at POC cardinality.
 *
 * `idPrefix` narrows the listing to `session:<idPrefix>` — pass a
 * sessionTenantPrefix (core/src/config.js) to list ONE user's sessions off the
 * tenant-prefixed key space. Left-anchored KV prefix listing, so the narrowing
 * happens at list time, never as a post-filter over every record. Empty by
 * default: the admin collections below keep their all-sessions behavior.
 *
 * `createdAt` is an ISO-8601 UTC string, which sorts lexicographically in
 * chronological order — no Date parsing needed. Records written before the
 * index carried a timestamp (or with a malformed one) sort last, then by id, so
 * they stay reachable instead of being interleaved unpredictably.
 *
 * @param {KvLike} kv
 * @param {string} [idPrefix] session-id prefix, WITHOUT the `session:` group prefix
 * @returns {Promise<Array<{ id: string, [k: string]: unknown }>>}
 */
export async function listSessions(kv, idPrefix = '') {
  const keys = [];
  let cursor;
  for (let page = 0; page < 1000; page++) {
    const res = await kv.list({ prefix: SESSION_KEY_PREFIX + idPrefix, ...(cursor ? { cursor } : {}) });
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

/**
 * Merge a patch into THE session record (`session:<id>`), creating it when
 * absent. The record is the single mutable per-session document: browse meta
 * (agentName, version, createdAt), the egress fields (egress_secrets,
 * whitelist), and the four data channels (session_context, payload,
 * session_data, session_state). All writers go through this read-merge-write
 * so nobody drops another writer's fields; last-write-wins per merge (KV has
 * no CAS — the rare heal/mirror interleave self-heals on the next write).
 * Refreshes the 24 h TTL, so a session expires 24 h after its last activity.
 *
 * @param {{ get(k: string): Promise<string | null>, put(k: string, v: string, o?: object): Promise<void> }} kv
 * @param {string} id session/conversation id
 * @param {Record<string, unknown>} patch fields to set/overwrite
 * @returns {Promise<Record<string, unknown>>} the merged record as written
 */
export async function mergeSessionRecord(kv, id, patch) {
  const existing = (await readSession(kv, id)) ?? {};
  const merged = { id, ...existing, ...patch };
  await putSessionIndex(kv, id, merged);
  return merged;
}

/**
 * Merge ONLY if the record still exists — never create, never re-arm the TTL of
 * something that is gone.
 *
 * For writers that run AFTER a session may have been torn down, where
 * mergeSessionRecord's create-when-absent would resurrect it. The live case is
 * the sandbox's post-stop cost snapshot: `DELETE /sessions/:id` removes the
 * record but does NOT stop the container, which keeps running until its
 * inactivity timeout, so that write routinely lands on a deliberately deleted
 * session. Same for a record whose 24 h TTL simply lapsed.
 *
 * @param {{ get(k: string): Promise<string | null>, put(k: string, v: string, o?: object): Promise<void> }} kv
 * @param {string} id
 * @param {Record<string, unknown>} patch
 * @returns {Promise<Record<string, unknown> | null>} the merged record, or null if there was none
 */
export async function mergeExistingSessionRecord(kv, id, patch) {
  const existing = await readSession(kv, id);
  if (!existing) return null;
  const merged = { id, ...existing, ...patch };
  await putSessionIndex(kv, id, merged);
  return merged;
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

/**
 * KV key -> the `createdAt` of the session it belongs to, so the raw KV browser
 * can show a date and sort newest-first like the sessions collection does.
 *
 * Three of the four prefixes are session-scoped and all three resolve from the
 * session records we already read: `session:<id>` and `agent:<id>` share the
 * session id, and `container:<containerId>` is covered because THE session
 * record stores its own `containerId` (idFromName is one-way, so the reverse
 * map has to come from the record, not from the key). `agentdef:<name>` is a
 * deployed definition, not session-scoped, and gets no date.
 *
 * @param {Array<{ id: unknown, createdAt?: unknown, containerId?: unknown }>} sessions
 * @returns {Map<string, string>}
 */
function sessionDateIndex(sessions) {
  const dateOf = new Map();
  for (const s of sessions) {
    if (typeof s.createdAt !== 'string' || !s.createdAt) continue;
    dateOf.set(SESSION_KEY_PREFIX + s.id, s.createdAt);
    dateOf.set(AGENT_SNAPSHOT_KEY_PREFIX + s.id, s.createdAt);
    if (typeof s.containerId === 'string' && s.containerId) {
      dateOf.set(CONTAINER_POINTER_KEY_PREFIX + s.containerId, s.createdAt);
    }
  }
  return dateOf;
}

/** The collections a backend exposes, given its KV namespace name. */
export function adminCollections(kvName) {
  return [
    { id: 'kv', label: `KV · ${kvName}`, kind: 'kv', description: 'Raw key/value entries (agent bundles, egress policies, session index).' },
    { id: 'sessions', label: 'Agent sessions', kind: 'sessions', description: 'One record per conversation id (from the session index).' },
  ];
}

/**
 * List the records of one collection.
 * @returns {Promise<{ records: Array<{ id: string, label: string, sublabel?: string, group?: string, meta?: unknown }>, note?: string }>}
 */
export async function listCollectionRecords(collectionId, deps) {
  if (collectionId === 'kv') {
    const [keys, sessions] = await Promise.all([listKvEntries(deps.kv), listSessions(deps.kv)]);
    const dateOf = sessionDateIndex(sessions);
    const records = keys.map((k) => {
      const createdAt = dateOf.get(k.name);
      return {
        id: k.name,
        label: k.name,
        // Same contract as the sessions collection: an ISO string the frontend
        // localises. Absent for keys that aren't session-scoped.
        ...(createdAt ? { sublabel: createdAt } : {}),
        group: k.group,
        meta: { expiration: k.expiration },
      };
    });
    // The frontend groups by prefix but does NOT reorder within a group, so the
    // ordering is entirely ours: newest session first, undated keys last (then
    // by name) so `agentdef:` — the one non-session-scoped prefix — stays stable.
    records.sort((a, b) => {
      if (a.sublabel && b.sublabel && a.sublabel !== b.sublabel) return b.sublabel.localeCompare(a.sublabel);
      if (a.sublabel && !b.sublabel) return -1;
      if (!a.sublabel && b.sublabel) return 1;
      return a.id.localeCompare(b.id);
    });
    return { records };
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
      note: sessions.length === 0 ? 'No sessions indexed yet — start one on the chat page (/).' : undefined,
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
