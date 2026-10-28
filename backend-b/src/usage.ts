/**
 * Per-instance LLM request rows feeding session_state and the response's
 * `llm_requests` metadata (core llm-usage.js has the row shape and the sums).
 *
 * Flue emits one `turn` event per model call — agent turns AND compaction
 * turns (`compaction`, `compaction_prefix`), whose cost Flue keeps OUT of
 * response.usage — carrying the agent instanceId, the generation id
 * (`responseId`, OpenRouter's `gen-…`) and the billed usage. The observer
 * registry composes with the braintrust.ts / otel.ts observers and runs in
 * the same isolate as the agent DO, so main.ts can drain the rows
 * synchronously inside its useResponseFinish callback.
 *
 * Known limits (same best-effort posture as the observability sinks): the map
 * is isolate-local, so turns before a mid-response eviction are lost — main.ts
 * reconciles agent turns against Flue's durable response.usage, so their COST
 * still lands (as an `unobserved` row), only their ids are missing; turns from
 * an aborted/failed submission stay queued and fold into the next response's
 * rows — the session aggregate remains truthful.
 */
import { observe } from '@flue/runtime';
import { llmRequestFromTurn } from '@semantius-copilot/core';

export type LlmRequestRow = ReturnType<typeof llmRequestFromTurn>;

const requestsByInstance = new Map<string, LlmRequestRow[]>();

observe((event) => {
  if (event.type !== 'turn') return;
  const { instanceId } = event as { instanceId?: string };
  if (!instanceId) return;
  const rows = requestsByInstance.get(instanceId) ?? [];
  rows.push(llmRequestFromTurn(event));
  requestsByInstance.set(instanceId, rows);
  // Bound isolate memory (mirrors otel.ts's costByTurn eviction): entries
  // linger only for sessions that die between a turn and its response finish.
  if (requestsByInstance.size > 500) {
    const oldest = requestsByInstance.keys().next().value;
    if (oldest !== undefined) requestsByInstance.delete(oldest);
  }
});

/** Read-and-clear the model requests observed for one agent instance. */
export function drainLlmRequests(instanceId: string): LlmRequestRow[] {
  const rows = requestsByInstance.get(instanceId) ?? [];
  requestsByInstance.delete(instanceId);
  return rows;
}
