/**
 * Per-instance LLM-call counter feeding session_state.llm_calls_count.
 *
 * Flue emits one `turn` event per model call (including compaction turns —
 * those are billed calls too), carrying the agent instanceId. The observer
 * registry composes with the braintrust.ts / otel.ts observers and runs in
 * the same isolate as the agent DO, so main.ts can drain the count
 * synchronously inside its useResponseFinish callback.
 *
 * Known limits (same best-effort posture as the observability sinks): the map
 * is isolate-local, so turns before a mid-response eviction are lost; turns
 * from an aborted/failed submission stay queued and fold into the next
 * response's count — the session aggregate remains truthful.
 */
import { observe } from '@flue/runtime';

const llmCallsByInstance = new Map<string, number>();

observe((event) => {
  if (event.type !== 'turn') return;
  const { instanceId } = event as { instanceId?: string };
  if (!instanceId) return;
  llmCallsByInstance.set(instanceId, (llmCallsByInstance.get(instanceId) ?? 0) + 1);
  // Bound isolate memory (mirrors otel.ts's costByTurn eviction): entries
  // linger only for sessions that die between a turn and its response finish.
  if (llmCallsByInstance.size > 500) {
    const oldest = llmCallsByInstance.keys().next().value;
    if (oldest !== undefined) llmCallsByInstance.delete(oldest);
  }
});

/** Read-and-clear the model-call count observed for one agent instance. */
export function drainLlmCalls(instanceId: string): number {
  const count = llmCallsByInstance.get(instanceId) ?? 0;
  llmCallsByInstance.delete(instanceId);
  return count;
}
