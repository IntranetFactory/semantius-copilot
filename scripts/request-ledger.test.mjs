#!/usr/bin/env node
/**
 * Request ledger (core/src/request-ledger.js): ONE KV object per session with
 * every billed LLM call, written as calls happen.
 *
 * The writer runs against a fake KV that misbehaves the way Workers KV does:
 *  - a put to a key within RATE_MS of the previous put to it is rejected
 *    (KV's 1 write/s/key limit -> 429);
 *  - reads can be STALE (return an older stored value), as KV reads may be;
 *  - optional random put failures.
 * Timings are scaled down (gap 60 ms instead of 1100 ms) so the suite is fast.
 *
 * Covers: bursts faster than the write limit lose nothing; stale reads lose
 * nothing; pending placeholders are replaced, never resurrected by a stale
 * read; a completed entry is never overwritten by a pending one; two
 * isolates writing one session (deploy overlap) keep each other's entries;
 * failed puts are retried; recording the same generation id twice is one
 * entry; summarizeRequests sums correctly.
 *
 *   node scripts/request-ledger.test.mjs        (also part of `pnpm test`)
 */
import {
  createRequestLedger,
  mergeLedgers,
  parseLedger,
  requestsKey,
  summarizeRequests,
  ledgerEntries,
} from '../core/src/request-ledger.js';
import { pendingRequestEntry, requestEntryFromTurn } from '../core/src/llm-usage.js';

let failures = 0;
let total = 0;
function check(name, ok, extra = '') {
  total += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
}
const j = (v) => JSON.stringify(v);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const GAP_MS = 60;
const RATE_MS = 50;
const FAST = { minGapMs: GAP_MS, retryDelaysMs: [60, 80, 120, 200, 300, 400, 500, 600], onError: () => {} };

/** Fake Workers KV with the same-key write limit, stale reads, injected failures and latency. */
function fakeKv({ staleReads = false, failRate = 0, latencyMs = 0 } = {}) {
  const versions = new Map(); // key -> [value, ...] (every successful put)
  const lastPut = new Map();
  const stats = { puts: 0, rejected: 0, failed: 0 };
  return {
    stats,
    latest: (key) => versions.get(key)?.at(-1) ?? null,
    async get(key) {
      if (latencyMs) await sleep(latencyMs);
      const list = versions.get(key) ?? [];
      if (list.length === 0) return null;
      // Stale: any earlier version (or none at all) may come back.
      if (staleReads && Math.random() < 0.5) {
        const i = Math.floor(Math.random() * (list.length + 1)) - 1;
        return i < 0 ? null : list[i];
      }
      return list.at(-1);
    },
    async put(key, value) {
      if (latencyMs) await sleep(latencyMs);
      const now = Date.now();
      if (now - (lastPut.get(key) ?? -Infinity) < RATE_MS) {
        stats.rejected += 1;
        throw new Error('429 KV PUT failed: Too Many Requests');
      }
      if (Math.random() < failRate) {
        stats.failed += 1;
        throw new Error('503 transient');
      }
      lastPut.set(key, now);
      stats.puts += 1;
      versions.set(key, [...(versions.get(key) ?? []), value]);
    },
  };
}

const entry = (i, extra = {}) => ({ at: new Date(Date.UTC(2026, 9, 28, 12, 0, i)).toISOString(), purpose: 'agent', cost: 0.001 * i, input_tokens: i, output_tokens: 1, total_tokens: i + 1, ...extra });

// ---------------------------------------------------------------------------
// Pure helpers

{
  const merged = mergeLedgers({ a: { pending: true }, b: { cost: 1 }, p: { pending: true } }, { a: { cost: 2 }, b: { pending: true }, c: { cost: 3 } }, ['p']);
  check('merge: local final replaces stored pending', merged.a?.cost === 2, j(merged));
  check('merge: stored final is never replaced by a local pending', merged.b?.cost === 1);
  check('merge: removed placeholder dropped even if the stored copy has it', !('p' in merged));
  check('merge: local-only entry added', merged.c?.cost === 3);
  check('parseLedger: junk -> {}', j(parseLedger('nope')) === '{}' && j(parseLedger('[1]')) === '{}' && j(parseLedger(null)) === '{}');
  const s = summarizeRequests({
    g1: { at: '2026-10-28T12:00:02Z', purpose: 'agent', cost: 0.1, input_tokens: 10, output_tokens: 2, cache_read_tokens: 5, total_tokens: 17, reasoning_tokens: 1 },
    g2: { at: '2026-10-28T12:00:01Z', purpose: 'title', cost: 0.2, input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    p1: { at: '2026-10-28T12:00:03Z', purpose: 'agent', pending: true },
    g3: { at: '2026-10-28T12:00:04Z', purpose: 'compaction', cost: 0, cost_unknown: true, id: 'gen-x' },
  });
  check(
    'summarize: cost, counts, tokens, by purpose, window',
    s.cost_total === 0.3 && s.requests_count === 4 && s.pending_count === 1 && s.cost_unknown_count === 1 &&
      s.input_tokens === 11 && s.cache_read_tokens === 5 && s.reasoning_tokens === 1 &&
      s.cost_by_purpose.agent === 0.1 && s.cost_by_purpose.title === 0.2 &&
      s.first_at === '2026-10-28T12:00:01Z' && s.last_at === '2026-10-28T12:00:04Z',
    j(s),
  );
  check('ledgerEntries: oldest first, key kept', ledgerEntries({ b: { at: '2' }, a: { at: '1' } }).map((e) => e.key).join() === 'a,b');
}

// Entry builders
{
  const AT = new Date('2026-10-28T12:00:00Z');
  const pending = pendingRequestEntry({ purpose: 'compaction', turnId: 'turn_1', request: { requestedModel: 'm' } }, AT);
  check('pending entry: purpose, model, turn id, pending', pending.pending === true && pending.purpose === 'compaction' && pending.model === 'm' && pending.turn_id === 'turn_1', j(pending));
  const cut = requestEntryFromTurn({ turnId: 'turn_2', purpose: 'agent', isError: true, response: { responseId: 'gen-cut', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } } } }, AT);
  check('turn entry: gen id but no usage chunk -> cost_unknown', cut.cost_unknown === true && cut.id === 'gen-cut', j(cut));
  const preStream = requestEntryFromTurn({ turnId: 'turn_3', isError: true, response: { usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } } } }, AT);
  check('turn entry: no gen id (failed before OpenRouter) -> not cost_unknown', !preStream.cost_unknown && !preStream.id);
  const billed = requestEntryFromTurn({ turnId: 'turn_4', response: { responseId: 'gen-ok', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0.01 }, reported: { prompt_tokens: 1, completion_tokens: 1 } } } }, AT);
  check('turn entry: billed call -> cost, no flag', billed.cost === 0.01 && !billed.cost_unknown);
  const rejected = requestEntryFromTurn({ turnId: 'turn_5', isError: true, response: { error: { message: '429 Too Many Requests' }, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } } } }, AT);
  check('turn entry: failed without gen id (e.g. 429) -> plain error with message, NOT cost_unknown', !rejected.cost_unknown && rejected.error && rejected.error_message === '429 Too Many Requests', j(rejected));
  check('turn entry: `at` is the given start time', billed.at === AT.toISOString());
}

// Admin read: the ledger shows on the session, and outlives the session record.
{
  const { readCollectionRecord } = await import('../core/src/admin.js');
  const kvData = new Map([
    ['session:s-live', JSON.stringify({ id: 's-live', agentName: 'a' })],
    [requestsKey('s-live'), JSON.stringify({ 'gen-1': entry(1), 'gen-2': entry(2) })],
    [requestsKey('s-gone'), JSON.stringify({ 'gen-9': entry(9) })],
  ]);
  const deps = { kv: { get: async (k) => kvData.get(k) ?? null, list: async () => ({ keys: [], list_complete: true }) } };
  const live = await readCollectionRecord('sessions', 's-live', deps);
  check(
    'admin read: session carries requests + requests_total',
    live?.session?.agentName === 'a' && Object.keys(live.session.requests).length === 2 && live.session.requests_total.requests_count === 2,
    j(live?.session?.requests_total),
  );
  const gone = await readCollectionRecord('sessions', 's-gone', deps);
  check('admin read: ledger still served after the session record expired', gone?.session?.requests_total?.requests_count === 1);
  check('admin read: neither record nor ledger -> not found', (await readCollectionRecord('sessions', 's-none', deps)) === null);
}

// ---------------------------------------------------------------------------
// Writer under KV's write limit and stale reads

async function burst({ kv, n, sessionId = 's1', ledger = createRequestLedger({ store: kv, ...FAST }) }) {
  const promises = [];
  for (let i = 1; i <= n; i += 1) {
    // Placeholder at call start, completion a moment later under the gen id.
    const pendingKey = `turn_${i}:x${i}`;
    promises.push(ledger.record(sessionId, pendingKey, { ...entry(i), pending: true }));
    if (i % 3 === 0) await sleep(5);
    promises.push(ledger.record(sessionId, `gen-${i}`, { id: `gen-${i}`, ...entry(i) }, pendingKey));
  }
  await Promise.all(promises);
  await ledger.pending(sessionId);
  return parseLedger(kv.latest(requestsKey(sessionId)));
}

{
  const kv = fakeKv();
  const stored = await burst({ kv, n: 60 });
  const keys = Object.keys(stored);
  check('burst of 60 calls faster than the write limit: all 60 stored', keys.length === 60 && keys.every((k) => k.startsWith('gen-')), `${keys.length} keys`);
  check('burst: coalesced into far fewer puts than calls, none rejected', kv.stats.puts < 20 && kv.stats.rejected === 0, j(kv.stats));
  check('burst: no placeholder left behind', !keys.some((k) => stored[k].pending));
  check('burst: total = sum of the calls', summarizeRequests(stored).cost_total === Math.round(0.001 * (60 * 61) / 2 * 1e9) / 1e9, String(summarizeRequests(stored).cost_total));
}

{
  const kv = fakeKv({ staleReads: true, failRate: 0.3 });
  const stored = await burst({ kv, n: 80 });
  const keys = Object.keys(stored);
  check('stale reads + 30% failed puts: all 80 stored, no placeholder resurrected', keys.length === 80 && !keys.some((k) => stored[k].pending), `${keys.length} keys, ${j(kv.stats)}`);
}

{
  // Slow KV (real KV takes tens of ms): calls keep arriving WHILE a get/put
  // is in flight, and none of them may be lost.
  const kv = fakeKv({ latencyMs: 25 });
  const ledger = createRequestLedger({ store: kv, ...FAST });
  const writes = [];
  for (let i = 1; i <= 50; i += 1) {
    writes.push(ledger.record('s6', `turn_${i}:p`, { ...entry(i), pending: true }));
    await sleep(4);
    writes.push(ledger.record('s6', `gen-${i}`, { id: `gen-${i}`, ...entry(i) }, `turn_${i}:p`));
    await sleep(4);
  }
  await Promise.all(writes);
  await ledger.pending('s6');
  const stored = parseLedger(kv.latest(requestsKey('s6')));
  const keys = Object.keys(stored);
  check('slow KV, calls arriving during every get/put: all 50 stored, no placeholder', keys.length === 50 && !keys.some((k) => stored[k].pending), `${keys.length} keys`);
}

{
  // Same generation id recorded twice (replay) -> one entry.
  const kv = fakeKv();
  const ledger = createRequestLedger({ store: kv, ...FAST });
  await ledger.record('s2', 'gen-a', { id: 'gen-a', ...entry(1) });
  await ledger.record('s2', 'gen-a', { id: 'gen-a', ...entry(1) });
  check('idempotent: the same gen id twice is one entry', Object.keys(parseLedger(kv.latest(requestsKey('s2')))).length === 1);
}

async function overlap(kv) {
  // Deploy overlap: two isolates (two ledgers) write the same session.
  const oldIsolate = createRequestLedger({ store: kv, ...FAST });
  const newIsolate = createRequestLedger({ store: kv, ...FAST });
  const writes = [];
  for (let i = 1; i <= 30; i += 1) {
    writes.push(oldIsolate.record('s3', `gen-old-${i}`, entry(i)));
    writes.push(newIsolate.record('s3', `gen-new-${i}`, entry(i)));
    if (i % 5 === 0) await sleep(GAP_MS);
  }
  await Promise.all(writes);
  await oldIsolate.pending('s3');
  await newIsolate.pending('s3');
  // Let each side do one more merge round so both have seen the other.
  await oldIsolate.record('s3', 'gen-old-final', entry(31));
  await sleep(GAP_MS * 2);
  await newIsolate.record('s3', 'gen-new-final', entry(32));
  await oldIsolate.pending('s3');
  await newIsolate.pending('s3');
  return Object.keys(parseLedger(kv.latest(requestsKey('s3')))).length;
}
{
  // Realistic: one session's agent runs in ONE location, where KV shows a
  // write immediately — two isolates race their puts but read current data.
  // The read-back after each put repairs whatever the other overwrote.
  const counts = [];
  for (let run = 0; run < 3; run += 1) counts.push(await overlap(fakeKv()));
  check('two isolates racing on one session (current reads): all 62 entries, 3 runs', counts.every((c) => c === 62), counts.join(', '));
  // Worst case beyond what KV does in one location: reads randomly stale AND
  // two writers. Not guaranteed — reported, not asserted.
  console.log(`INFO  two isolates + randomly stale reads (beyond KV's same-location behavior): ${await overlap(fakeKv({ staleReads: true }))}/62 entries kept`);
}
{
  // Restart (the deploy case that actually happens): the old isolate dies,
  // a new one continues the session from what is stored.
  const kv = fakeKv();
  const oldIsolate = createRequestLedger({ store: kv, ...FAST });
  for (let i = 1; i <= 20; i += 1) void oldIsolate.record('s5', `gen-${i}`, entry(i));
  await oldIsolate.pending('s5');
  const newIsolate = createRequestLedger({ store: kv, ...FAST });
  for (let i = 21; i <= 40; i += 1) void newIsolate.record('s5', `gen-${i}`, entry(i));
  await newIsolate.pending('s5');
  check('restart: new isolate keeps the old isolate entries', Object.keys(parseLedger(kv.latest(requestsKey('s5')))).length === 40);
}

{
  // An outage longer than the backoff schedule: the writer keeps retrying on
  // its own (no further call needed) and lands everything once KV is back.
  let down = true;
  const kv = fakeKv();
  const store = { get: kv.get, put: async (k, v) => { if (down) throw new Error('503'); return kv.put(k, v); } };
  const ledger = createRequestLedger({ store, ...FAST, retryDelaysMs: [10, 10] });
  void ledger.record('s4', 'gen-1', entry(1));
  void ledger.record('s4', 'gen-2', entry(2));
  await sleep(300); // far past the 2-step backoff schedule
  check('outage: nothing stored while KV is down', kv.latest(requestsKey('s4')) === null);
  down = false;
  await ledger.pending('s4');
  check('outage: the last calls land once KV is back, with no further call', Object.keys(parseLedger(kv.latest(requestsKey('s4')))).length === 2);
}

{
  // A malformed stored object (a null entry) must not break the writer.
  const kv = fakeKv();
  await kv.put(requestsKey('s7'), JSON.stringify({ bad: null, 'gen-0': entry(0) }));
  await sleep(RATE_MS + 5);
  const ledger = createRequestLedger({ store: kv, ...FAST });
  await ledger.record('s7', 'gen-1', entry(1));
  await ledger.pending('s7');
  await ledger.record('s7', 'gen-2', entry(2));
  await ledger.pending('s7');
  const stored = parseLedger(kv.latest(requestsKey('s7')));
  check('malformed stored entry: dropped, writer keeps working', Object.keys(stored).sort().join() === 'gen-0,gen-1,gen-2', Object.keys(stored).join());
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}  (${total} checks)`);
process.exit(failures === 0 ? 0 : 1);
