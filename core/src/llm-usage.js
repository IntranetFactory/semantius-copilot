/**
 * Per-request LLM accounting (host-agnostic, pure).
 *
 * The unit OpenRouter bills and logs is ONE model request, identified by its
 * generation id (`gen-…`, the streamed chunk id pi-ai keeps as `responseId`).
 * A session makes dozens of them, so every request becomes one row here, and
 * every session total is a sum over rows — never a separate counter that can
 * drift. That makes the audit mechanical: sum(rows.cost) === the total, and
 * each row's `id` is looked up in OpenRouter's activity log.
 *
 * Row sources (backend-b wires them; this file only shapes and sums):
 *  - Flue `turn` events — one per model call the agent makes: purposes
 *    `agent`, `compaction`, `compaction_prefix` (usage.ts collects them).
 *  - The sidebar-title side call (title.ts), outside Flue: purpose `title`.
 *  - `unobserved`: the gap between Flue's DURABLE response usage (summed from
 *    the record log, survives a Durable Object restart) and the agent rows the
 *    isolate-local observer actually saw. Not a request — it carries no id and
 *    is not counted as a call — but its cost is real and stays in the total.
 *
 * Costs are OpenRouter's billed `usage.cost` (pi-ai patch, title.ts requests
 * the same accounting); a provider that reports none leaves `cost: 0` and the
 * row says `unpriced: true` instead of guessing.
 */

/** Below this, two USD amounts are the same (float noise, not money). */
const COST_EPSILON = 1e-9;

/** Round to nano-dollars: kills float noise without losing OpenRouter's precision. */
export const roundUsd = (n) => Math.round(n * 1e9) / 1e9;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * One Flue `turn` event -> one request row.
 *
 * @param {{ purpose?: string, durationMs?: number, isError?: boolean,
 *           request?: { requestedModel?: string },
 *           response?: { responseId?: string, responseModel?: string, finishReason?: string,
 *                        usage?: { input?: number, output?: number, cacheRead?: number, cacheWrite?: number,
 *                                  totalTokens?: number, cost?: { total?: number }, serverToolUse?: unknown } } }} turn
 * @param {Date} [at]
 */
export function llmRequestFromTurn(turn, at = new Date()) {
  const usage = turn?.response?.usage;
  const serverToolUse = usage?.serverToolUse;
  return {
    at: at.toISOString(),
    ...(turn?.response?.responseId ? { id: turn.response.responseId } : {}),
    purpose: typeof turn?.purpose === 'string' ? turn.purpose : 'agent',
    ...(turn?.response?.responseModel || turn?.request?.requestedModel
      ? { model: turn.response?.responseModel || turn.request?.requestedModel }
      : {}),
    input_tokens: num(usage?.input),
    output_tokens: num(usage?.output),
    cache_read_tokens: num(usage?.cacheRead),
    cache_write_tokens: num(usage?.cacheWrite),
    total_tokens: num(usage?.totalTokens),
    cost: num(usage?.cost?.total),
    ...(typeof turn?.durationMs === 'number' ? { ms: Math.round(turn.durationMs) } : {}),
    ...(turn?.isError ? { error: turn.response?.finishReason ?? true } : {}),
    ...(serverToolUse && typeof serverToolUse === 'object' ? { server_tool_use: serverToolUse } : {}),
  };
}

/**
 * One non-streaming chat-completions body (the title call) -> one request row.
 * Token split mirrors pi-ai's parseChunkUsage, so title rows and turn rows
 * mean the same thing: `input` excludes cache reads/writes.
 *
 * @param {{ id?: string, model?: string, usage?: { prompt_tokens?: number, completion_tokens?: number,
 *           cost?: number, prompt_tokens_details?: { cached_tokens?: number, cache_write_tokens?: number } } }} body
 * @param {{ purpose?: string, model?: string, ms?: number, at?: Date }} [options]
 */
export function llmRequestFromCompletion(body, { purpose = 'title', model, ms, at = new Date() } = {}) {
  const usage = body?.usage ?? {};
  const prompt = num(usage.prompt_tokens);
  const cacheRead = num(usage.prompt_tokens_details?.cached_tokens);
  const cacheWrite = num(usage.prompt_tokens_details?.cache_write_tokens);
  const input = Math.max(0, prompt - cacheRead - cacheWrite);
  const output = num(usage.completion_tokens);
  const billed = usage.cost;
  const priced = typeof billed === 'number' && Number.isFinite(billed);
  return {
    at: at.toISOString(),
    ...(typeof body?.id === 'string' && body.id ? { id: body.id } : {}),
    purpose,
    ...(body?.model || model ? { model: body?.model || model } : {}),
    input_tokens: input,
    output_tokens: output,
    cache_read_tokens: cacheRead,
    cache_write_tokens: cacheWrite,
    total_tokens: input + output + cacheRead + cacheWrite,
    cost: priced ? billed : 0,
    ...(priced ? {} : { unpriced: true }),
    ...(typeof ms === 'number' ? { ms: Math.round(ms) } : {}),
  };
}

/**
 * Close the gap between what the observer saw and what Flue durably counted.
 *
 * `responseUsage` is Flue's aggregate over the response's durably completed
 * agent steps. The observed `agent` rows normally equal it exactly; when the
 * Durable Object restarted mid-response the rows miss the pre-restart turns,
 * and the shortfall comes back as one `unobserved` row so the total never
 * understates. Rows ABOVE the durable figure are legitimate (turns of an
 * aborted submission, which never got a response of their own, fold into the
 * next one) and are kept as-is.
 *
 * @param {ReturnType<typeof llmRequestFromTurn>[]} rows
 * @param {{ input?: number, output?: number, cacheRead?: number, cacheWrite?: number, totalTokens?: number,
 *           cost?: { total?: number } } | undefined} responseUsage
 * @param {Date} [at]
 */
export function reconcileWithResponseUsage(rows, responseUsage, at = new Date()) {
  const agent = rows.filter((r) => r.purpose === 'agent');
  const sum = (key) => agent.reduce((acc, r) => acc + r[key], 0);
  const gap = {
    input_tokens: Math.max(0, num(responseUsage?.input) - sum('input_tokens')),
    output_tokens: Math.max(0, num(responseUsage?.output) - sum('output_tokens')),
    cache_read_tokens: Math.max(0, num(responseUsage?.cacheRead) - sum('cache_read_tokens')),
    cache_write_tokens: Math.max(0, num(responseUsage?.cacheWrite) - sum('cache_write_tokens')),
    total_tokens: Math.max(0, num(responseUsage?.totalTokens) - sum('total_tokens')),
    cost: roundUsd(Math.max(0, num(responseUsage?.cost?.total) - sum('cost'))),
  };
  if (gap.cost <= COST_EPSILON && gap.total_tokens === 0) return rows;
  return [...rows, { at: at.toISOString(), purpose: 'unobserved', ...gap }];
}

/** The running totals every row feeds. Shape of the persisted `session_state` slice. */
export const ZERO_LLM_TOTALS = Object.freeze({
  input_tokens: 0,
  output_tokens: 0,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  total_tokens: 0,
  cost_total: 0,
  llm_calls_count: 0,
});

/**
 * Fold request rows into running totals. `cost_by_purpose` breaks the total
 * down (agent / compaction / compaction_prefix / title / unobserved) and
 * always sums to `cost_total`. `unobserved` rows add cost and tokens but no
 * call — they are a shortfall, not a request.
 *
 * Tolerates `prev` from before this existed (no cost_by_purpose; cost_total
 * then counted only agent turns): the prior total is carried over as-is and
 * attributed to `agent`, so the breakdown keeps summing to the total.
 *
 * @template {object} T
 * @param {T} prev running totals so far (any object; missing fields count as 0)
 * @param {Array<{ purpose: string, input_tokens: number, output_tokens: number, cache_read_tokens: number,
 *                 cache_write_tokens: number, total_tokens: number, cost: number }>} rows
 * @returns {T & { input_tokens: number, output_tokens: number, cache_read_tokens: number, cache_write_tokens: number,
 *                 total_tokens: number, cost_total: number, llm_calls_count: number, cost_by_purpose: Record<string, number> }}
 */
export function addLlmRequests(prev, rows) {
  /** @type {Record<string, any>} */
  const p = prev ?? {};
  const prevCost = num(p.cost_total);
  const byPurpose = { ...(p.cost_by_purpose ?? (prevCost > 0 ? { agent: prevCost } : {})) };
  let cost = prevCost;
  const totals = {
    input_tokens: num(p.input_tokens),
    output_tokens: num(p.output_tokens),
    cache_read_tokens: num(p.cache_read_tokens),
    cache_write_tokens: num(p.cache_write_tokens),
    total_tokens: num(p.total_tokens),
    llm_calls_count: num(p.llm_calls_count),
  };
  for (const row of rows) {
    totals.input_tokens += num(row.input_tokens);
    totals.output_tokens += num(row.output_tokens);
    totals.cache_read_tokens += num(row.cache_read_tokens);
    totals.cache_write_tokens += num(row.cache_write_tokens);
    totals.total_tokens += num(row.total_tokens);
    if (row.purpose !== 'unobserved') totals.llm_calls_count += 1;
    cost += num(row.cost);
    byPurpose[row.purpose] = roundUsd(num(byPurpose[row.purpose]) + num(row.cost));
  }
  return { ...prev, ...totals, cost_total: roundUsd(cost), cost_by_purpose: byPurpose };
}
