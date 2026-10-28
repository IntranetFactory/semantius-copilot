/**
 * Per-call LLM accounting, from Flue's per-call events.
 *
 * Flue emits `turn_request` when a model call starts and `turn` when it ends —
 * for agent turns AND compaction turns (`compaction`, `compaction_prefix`,
 * whose cost Flue keeps OUT of response.usage) — carrying the agent
 * instanceId (= session id), the generation id (`responseId`, OpenRouter's
 * `gen-…`) and the billed usage. The observer registry composes with the
 * braintrust.ts / otel.ts observers and runs in the agent DO's isolate.
 *
 * Two consumers:
 *  1. THE REQUEST LEDGER (KV `requests:<sessionId>`, core request-ledger.js):
 *     a `pending` entry at every call start, replaced by the completed entry
 *     (keyed by its gen id) at the end — written as it happens, so the
 *     session's request list is current while a response is still running and
 *     survives a restart mid-response. The flush promise is RETURNED so Flue
 *     tracks it and hands it to the platform's waitUntil.
 *  2. session_state (main.ts): rows collected per response and drained at
 *     useResponseFinish — the agent Durable Object's own durable totals.
 *     Isolate-local, so a mid-response restart loses rows; main.ts reconciles
 *     against Flue's durable response.usage (`unobserved`). The ledger is the
 *     itemized record; these totals are a cross-check.
 */
import { observe } from '@flue/runtime';
import { env } from 'cloudflare:workers';
import {
  createRequestLedger,
  llmRequestFromTurn,
  pendingRequestEntry,
  requestEntryFromTurn,
} from '@semantius-copilot/core';

export type LlmRequestRow = ReturnType<typeof llmRequestFromTurn>;

const requestsByInstance = new Map<string, LlmRequestRow[]>();

/** The isolate's ledger writer (title.ts records the title call through it too). */
// The binding is looked up per call, not at module load.
const store = () => (env as unknown as { STORE: KVNamespace }).STORE;
export const requestLedger = createRequestLedger({
  store: {
    get: (key) => store().get(key),
    put: (key, value, options) => store().put(key, value, options as KVNamespacePutOptions),
  },
});

// Flue reuses a turn id when it retries a call within one turn, so each call
// start gets its own placeholder key: `<turnId>:<isolate tag><seq>`. The tag
// keeps keys unique across isolates (a restarted isolate restarts the seq).
const ISOLATE_TAG = Date.now().toString(36);
let callSeq = 0;
/** `<instanceId>|<turnId>` -> the placeholder key and start time of that turn's call in flight. */
const pendingKeys = new Map<string, { key: string; startedAt: Date }>();

type TurnEvent = {
  type: string;
  instanceId?: string;
  turnId?: string;
  purpose?: string;
  request?: { requestedModel?: string };
};

observe((event) => {
  const { instanceId, turnId } = event as TurnEvent;
  if (!instanceId) return;

  if (event.type === 'turn_request') {
    const key = `${turnId ?? 'turn'}:${ISOLATE_TAG}${(callSeq += 1)}`;
    const startedAt = new Date();
    pendingKeys.set(`${instanceId}|${turnId}`, { key, startedAt });
    if (pendingKeys.size > 1000) {
      const oldest = pendingKeys.keys().next().value;
      if (oldest !== undefined) pendingKeys.delete(oldest);
    }
    return requestLedger.record(instanceId, key, pendingRequestEntry(event as TurnEvent, startedAt));
  }

  if (event.type !== 'turn') return;
  const rows = requestsByInstance.get(instanceId) ?? [];
  rows.push(llmRequestFromTurn(event));
  requestsByInstance.set(instanceId, rows);
  // Bound isolate memory (mirrors otel.ts's costByTurn eviction): entries
  // linger only for sessions that die between a turn and its response finish.
  if (requestsByInstance.size > 500) {
    const oldest = requestsByInstance.keys().next().value;
    if (oldest !== undefined) requestsByInstance.delete(oldest);
  }

  const pending = pendingKeys.get(`${instanceId}|${turnId}`);
  pendingKeys.delete(`${instanceId}|${turnId}`);
  // Timed by the call's start, as OpenRouter's log is; without a seen start,
  // back-dated by the reported duration.
  const { durationMs } = event as { durationMs?: number };
  const at = pending?.startedAt ?? new Date(Date.now() - (typeof durationMs === 'number' ? durationMs : 0));
  const entry = requestEntryFromTurn(event, at);
  // No start seen and no generation id: a failure before any request left
  // (pi-agent run failure, a stale turn) — nothing was sent, nothing billed.
  if (!pending && !entry.id) return;
  // Keyed by the generation id (idempotent: the same call written twice is one
  // entry); a call that never got one (failed before streaming) keeps its
  // placeholder key.
  const key = entry.id ?? pending?.key ?? `${turnId ?? 'turn'}:${ISOLATE_TAG}${(callSeq += 1)}`;
  return requestLedger.record(instanceId, key, entry, pending?.key);
});

/** Read-and-clear the model requests observed for one agent instance. */
export function drainLlmRequests(instanceId: string): LlmRequestRow[] {
  const rows = requestsByInstance.get(instanceId) ?? [];
  requestsByInstance.delete(instanceId);
  return rows;
}
