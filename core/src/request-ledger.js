/**
 * The per-session request ledger: ONE KV object per session holding every
 * billed LLM request, keyed by OpenRouter's generation id (host-agnostic).
 *
 *   KV `requests:<sessionId>` = { "<gen-…>": { id, at, purpose, model, …tokens, cost, ms }, … }
 *
 * Every model call (agent turns, compaction turns, the sidebar-title side
 * call) is added the moment it completes, so the object is always current —
 * not only at the end of a response. The admin record read attaches it to the
 * session as `requests` plus `requests_total` (summarizeRequests); the Costs
 * tab and `pnpm llm-audit` read the same object.
 *
 * Why its own key and not a field of `session:<id>`: that record is
 * read-modify-written by several writers (chat gate, backups, container cost
 * snapshot, title), any of which can put back a stale copy. This key has one
 * writer: the session's agent Durable Object isolate (every model call and
 * the title call run there).
 *
 * Why the writer is more than "read, add, put" (each point is a way that
 * simple version loses entries):
 *  - KV rejects writes to the same key within ~1 s (429). Calls come faster
 *    (compaction's two parallel summaries, short tool loops, the title call).
 *    -> entries collect in memory and the whole object is put at most once per
 *       MIN_PUT_GAP_MS; a failed put is retried with backoff (then every 30 s,
 *       for ~30 min; the next call restarts it) and nothing leaves memory until a put
 *       containing it succeeded.
 *  - KV only USUALLY reads back a write made moments ago, and a deploy can
 *    briefly run two isolates for one session.
 *    -> before every put the stored object is re-read and merged by key, and
 *       this isolate keeps every entry it ever recorded, so a stale read can
 *       never drop one.
 *  - A call still running when the isolate dies leaves no completion event.
 *    -> a `pending` entry is written when each call STARTS and replaced when
 *       it completes; a pending entry that stays pending is an interrupted call
 *       (match it to OpenRouter's log by time and model).
 *  - A stream cut before its final usage chunk is billed but reports no cost.
 *    -> such entries carry `cost_unknown: true` (llm-audit fills in
 *       OpenRouter's figure).
 *
 * Retention: REQUESTS_TTL_SECONDS (35 days), refreshed by every put — longer
 * than the session record, and deliberately NOT deleted with the session:
 * a deleted session's calls were still billed.
 */

export const REQUESTS_KEY_PREFIX = 'requests:';
export const REQUESTS_TTL_SECONDS = 35 * 24 * 3600;
/** KV's same-key write limit is 1/s; stay clear of it. */
export const MIN_PUT_GAP_MS = 1100;
/** Retry delays after a failed put (429 or transient); the last one repeats until a put succeeds. */
const RETRY_DELAYS_MS = [1100, 2000, 4000, 8000, 16000, 30000];
/** Failed puts in a row before the loop stops (≈30 min at the 30 s cap); the next record() restarts it. */
const MAX_FAILURES = 66;
/** Re-puts after a read-back found entries missing, before giving up until the next record. */
const MAX_VERIFICATIONS = 5;
/** Forget an idle session's in-memory ledger after this long (its entries are in KV by then). */
const IDLE_EVICT_MS = 3600 * 1000;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const roundUsd = (n) => Math.round(n * 1e9) / 1e9;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** @param {string} sessionId */
export const requestsKey = (sessionId) => `${REQUESTS_KEY_PREFIX}${sessionId}`;

/** Parse a stored ledger; anything unusable reads as empty. */
export function parseLedger(raw) {
  if (typeof raw !== 'string' || raw === '') return {};
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!isObject(value)) return {};
  // Entries must be objects; a malformed one is dropped, never propagated.
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => isObject(entry)));
}

/**
 * Merge this isolate's entries into the stored object, by key.
 *  - keys in `removed` (pending placeholders this isolate has since replaced)
 *    are dropped even when the stored copy still has them;
 *  - a completed entry is never overwritten by a pending one (whichever side
 *    holds it);
 *  - otherwise the local entry wins (it is this isolate's newest knowledge).
 *
 * @param {Record<string, any>} stored
 * @param {Record<string, any>} local
 * @param {Iterable<string>} [removed]
 */
export function mergeLedgers(stored, local, removed = []) {
  const drop = new Set(removed);
  const merged = {};
  for (const [key, entry] of Object.entries(stored ?? {})) if (!drop.has(key)) merged[key] = entry;
  for (const [key, entry] of Object.entries(local ?? {})) {
    if (drop.has(key)) continue;
    const existing = merged[key];
    if (existing && !existing.pending && entry?.pending) continue;
    merged[key] = entry;
  }
  return merged;
}

/**
 * Totals over a ledger. Pending entries count as calls but add no cost (none
 * is known yet); `cost_unknown` entries are counted so the gap is visible.
 *
 * @param {Record<string, any>} requests
 */
export function summarizeRequests(requests) {
  const entries = Object.values(isObject(requests) ? requests : {});
  const totals = {
    cost_total: 0,
    requests_count: entries.length,
    pending_count: 0,
    cost_unknown_count: 0,
    error_count: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    total_tokens: 0,
    cost_by_purpose: /** @type {Record<string, number>} */ ({}),
    first_at: /** @type {string | undefined} */ (undefined),
    last_at: /** @type {string | undefined} */ (undefined),
  };
  for (const e of entries) {
    if (e?.pending) totals.pending_count += 1;
    if (e?.cost_unknown) totals.cost_unknown_count += 1;
    if (e?.error) totals.error_count += 1;
    totals.cost_total += num(e?.cost);
    totals.input_tokens += num(e?.input_tokens);
    totals.output_tokens += num(e?.output_tokens);
    totals.cache_read_tokens += num(e?.cache_read_tokens);
    totals.cache_write_tokens += num(e?.cache_write_tokens);
    totals.reasoning_tokens += num(e?.reasoning_tokens);
    totals.total_tokens += num(e?.total_tokens);
    const purpose = typeof e?.purpose === 'string' ? e.purpose : 'unknown';
    totals.cost_by_purpose[purpose] = roundUsd(num(totals.cost_by_purpose[purpose]) + num(e?.cost));
    if (typeof e?.at === 'string') {
      if (!totals.first_at || e.at < totals.first_at) totals.first_at = e.at;
      if (!totals.last_at || e.at > totals.last_at) totals.last_at = e.at;
    }
  }
  totals.cost_total = roundUsd(totals.cost_total);
  return totals;
}

/** The ledger's entries as an array, oldest first (audit / display order). */
export function ledgerEntries(requests) {
  return Object.entries(isObject(requests) ? requests : {})
    .map(([key, entry]) => ({ key, ...entry }))
    .sort((a, b) => String(a.at ?? '').localeCompare(String(b.at ?? '')) || a.key.localeCompare(b.key));
}

/**
 * The isolate-wide ledger writer. One instance per isolate; state is kept per
 * session. `record` returns the session's flush promise — hand it to the
 * platform (return it from an observe() callback, or waitUntil) so the put is
 * not cut off.
 *
 * @param {{ store: { get(k: string): Promise<string | null>, put(k: string, v: string, o?: object): Promise<void> },
 *           now?: () => number, sleep?: (ms: number) => Promise<void>, minGapMs?: number,
 *           retryDelaysMs?: number[], onError?: (sessionId: string, err: unknown, attempt: number) => void }} options
 */
export function createRequestLedger({
  store,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  minGapMs = MIN_PUT_GAP_MS,
  retryDelaysMs = RETRY_DELAYS_MS,
  onError = (sessionId, err, attempt) =>
    console.error(`[request-ledger] put ${requestsKey(sessionId)} failed (attempt ${attempt}):`, err),
}) {
  /** @type {Map<string, { entries: Record<string, any>, removed: Set<string>, dirty: boolean,
   *                       lastPutAt: number, touchedAt: number, flushing: Promise<void> | null }>} */
  const sessions = new Map();

  function stateFor(sessionId) {
    let state = sessions.get(sessionId);
    if (!state) {
      state = { entries: {}, removed: new Set(), dirty: false, lastPutAt: 0, touchedAt: now(), flushing: null };
      sessions.set(sessionId, state);
    }
    state.touchedAt = now();
    // Drop idle, fully-flushed sessions so a long-lived isolate stays bounded.
    for (const [id, s] of sessions) {
      if (id !== sessionId && !s.dirty && !s.flushing && now() - s.touchedAt > IDLE_EVICT_MS) sessions.delete(id);
    }
    return state;
  }

  /** True when every entry of `written` is in `stored` (a pending one may have completed there). */
  function containsAll(stored, written, removed) {
    for (const [key, entry] of Object.entries(written)) {
      const there = stored[key];
      if (!there) return false;
      if (there.pending && !entry.pending) return false;
    }
    for (const key of removed) if (key in stored) return false;
    return true;
  }

  async function flushLoop(sessionId, state) {
    const key = requestsKey(sessionId);
    let failures = 0;
    let verifications = 0;
    try {
      while (state.dirty) {
        const gap = state.lastPutAt + minGapMs - now();
        // Failed puts back off, then keep retrying at the last (capped) delay
        // for as long as the isolate lives: the session's final calls must
        // not wait for a next call that may never come.
        const backoff = failures > 0 ? retryDelaysMs[Math.min(failures, retryDelaysMs.length) - 1] : 0;
        const wait = Math.max(gap, backoff, 0);
        if (wait > 0) await sleep(wait);
        // Everything recorded up to here goes into this put; anything recorded
        // while it is in flight sets dirty again and gets the next one.
        state.dirty = false;
        let merged;
        try {
          const stored = parseLedger(await store.get(key));
          merged = mergeLedgers(stored, state.entries, state.removed);
          await store.put(key, JSON.stringify(merged), { expirationTtl: REQUESTS_TTL_SECONDS });
          state.lastPutAt = now();
          failures = 0;
          // Keep everything seen, not only our own entries: a later put then
          // restores anything another writer (deploy overlap) dropped. Merged
          // UNDER the current entries — calls recorded while this get/put was
          // in flight are only in state.entries and must stay there.
          state.entries = mergeLedgers(merged, state.entries, state.removed);
        } catch (err) {
          state.dirty = true;
          state.lastPutAt = now();
          failures += 1;
          onError(sessionId, err, failures);
          // A put that can never succeed (value too large, bad key) must not
          // spin for the isolate's life; entries stay, the next call retries.
          if (failures >= MAX_FAILURES) break;
          continue;
        }
        // Read back once the write limit allows another put: if another
        // writer overwrote the object without what WE just put, put again.
        // Bounded, so a read that stays stale cannot loop forever.
        if (!state.dirty && verifications < MAX_VERIFICATIONS) {
          await sleep(minGapMs);
          const check = parseLedger(await store.get(key).catch(() => null));
          if (!containsAll(check, merged, state.removed)) {
            verifications += 1;
            state.dirty = true;
          } else {
            verifications = 0;
          }
        }
      }
    } catch (err) {
      // Never leave a dead loop behind: keep the entries, let the next
      // record() start a fresh one.
      state.dirty = true;
      onError(sessionId, err, -1);
    } finally {
      state.flushing = null;
    }
  }

  function flush(sessionId, state) {
    state.dirty = true;
    if (!state.flushing) state.flushing = flushLoop(sessionId, state);
    return state.flushing;
  }

  return {
    /**
     * Add or replace one entry. `replaces` is the placeholder key this entry
     * supersedes (a pending entry stored under a different key).
     * @param {string} sessionId
     * @param {string} key
     * @param {Record<string, unknown>} entry
     * @param {string} [replaces]
     */
    record(sessionId, key, entry, replaces) {
      const state = stateFor(sessionId);
      if (replaces && replaces !== key) {
        delete state.entries[replaces];
        state.removed.add(replaces);
      }
      state.entries[key] = entry;
      state.removed.delete(key);
      return flush(sessionId, state);
    },
    /** The session's flush in progress, if any (tests, shutdown). */
    pending(sessionId) {
      return sessions.get(sessionId)?.flushing ?? Promise.resolve();
    },
  };
}
