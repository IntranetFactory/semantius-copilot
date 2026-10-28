#!/usr/bin/env node
/**
 * Per-request LLM accounting (core/src/llm-usage.js), offline.
 *
 * The invariant an audit relies on: a session's LLM totals are sums over its
 * request rows, so sum(rows.cost) === cost_total and every billed OpenRouter
 * generation is one row with its `gen-…` id. Covers: a Flue `turn` event ->
 * row (ids, purpose, tokens, billed cost, errors); a non-streaming completion
 * body (the title call) -> row with pi-ai's token split; reconciliation
 * against Flue's durable response.usage (equal -> untouched; short -> one
 * `unobserved` row; above -> untouched); totals and the purpose breakdown,
 * including compaction (which Flue keeps out of response.usage) and a
 * session persisted before the breakdown existed.
 *
 *   node scripts/llm-usage.test.mjs        (also part of `pnpm test`)
 */
import {
  addLlmRequests,
  llmRequestFromCompletion,
  llmRequestFromTurn,
  reconcileWithResponseUsage,
  roundUsd,
  ZERO_LLM_TOTALS,
} from '../core/src/llm-usage.js';

let failures = 0;
let total = 0;
function check(name, ok, extra = '') {
  total += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
}
const j = (v) => JSON.stringify(v);

const AT = new Date('2026-10-28T10:00:00.000Z');
const usage = (input, output, cacheRead, cost, extra = {}) => ({
  input,
  output,
  cacheRead,
  cacheWrite: 0,
  totalTokens: input + output + cacheRead,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
  ...extra,
});
const turn = (purpose, id, u, extra = {}) => ({
  type: 'turn',
  turnId: `t-${id}`,
  purpose,
  durationMs: 1234.4,
  request: { requestedModel: 'z-ai/glm-5.3' },
  response: { responseId: id, responseModel: 'z-ai/glm-5.3-20261001', usage: u, finishReason: 'toolUse' },
  isError: false,
  ...extra,
});

// ---------------------------------------------------------------------------
// llmRequestFromTurn

{
  const row = llmRequestFromTurn(turn('agent', 'gen-1', usage(100, 20, 900, 0.0012345678)), AT);
  check(
    'turn -> row: id, purpose, served model, tokens, billed cost, rounded ms',
    j(row) ===
      j({
        at: '2026-10-28T10:00:00.000Z',
        id: 'gen-1',
        purpose: 'agent',
        model: 'z-ai/glm-5.3-20261001',
        input_tokens: 100,
        output_tokens: 20,
        cache_read_tokens: 900,
        cache_write_tokens: 0,
        total_tokens: 1020,
        cost: 0.0012345678,
        ms: 1234,
      }),
    j(row),
  );
  const compaction = llmRequestFromTurn(turn('compaction', 'gen-2', usage(5000, 800, 0, 0.004)), AT);
  check('turn -> row: compaction purpose kept', compaction.purpose === 'compaction' && compaction.cost === 0.004);
  const failed = llmRequestFromTurn(
    { ...turn('agent', undefined, undefined), isError: true, response: { finishReason: 'error' } },
    AT,
  );
  check(
    'turn -> row: failed call without usage/id -> zero row flagged error, no id',
    failed.cost === 0 && failed.total_tokens === 0 && failed.error === 'error' && !('id' in failed),
    j(failed),
  );
  const web = llmRequestFromTurn(turn('agent', 'gen-3', usage(10, 5, 0, 0.02, { serverToolUse: { web_search_requests: 2 } })), AT);
  check('turn -> row: server_tool_use carried', j(web.server_tool_use) === j({ web_search_requests: 2 }));
  const requestedOnly = llmRequestFromTurn({ ...turn('agent', 'gen-4', usage(1, 1, 0, 0)), response: { responseId: 'gen-4', usage: usage(1, 1, 0, 0) } }, AT);
  check('turn -> row: falls back to the requested model', requestedOnly.model === 'z-ai/glm-5.3');
}

// ---------------------------------------------------------------------------
// llmRequestFromCompletion (the title call)

{
  const body = {
    id: 'gen-title-1',
    model: 'z-ai/glm-5.3',
    usage: { prompt_tokens: 400, completion_tokens: 12, cost: 0.00031, prompt_tokens_details: { cached_tokens: 100 } },
  };
  const row = llmRequestFromCompletion(body, { ms: 812.6, at: AT });
  check(
    'completion -> row: pi-ai token split (input excludes cache reads), billed cost, title purpose',
    row.id === 'gen-title-1' &&
      row.purpose === 'title' &&
      row.input_tokens === 300 &&
      row.cache_read_tokens === 100 &&
      row.output_tokens === 12 &&
      row.total_tokens === 412 &&
      row.cost === 0.00031 &&
      row.ms === 813 &&
      !('unpriced' in row),
    j(row),
  );
  const unpriced = llmRequestFromCompletion({ id: 'chatcmpl-1', usage: { prompt_tokens: 10, completion_tokens: 2 } }, { model: 'gpt-x', at: AT });
  check('completion -> row: no reported cost -> cost 0 + unpriced, model from options', unpriced.cost === 0 && unpriced.unpriced === true && unpriced.model === 'gpt-x', j(unpriced));
}

// ---------------------------------------------------------------------------
// reconcileWithResponseUsage

{
  const rows = [
    llmRequestFromTurn(turn('agent', 'gen-a', usage(100, 10, 0, 0.001)), AT),
    llmRequestFromTurn(turn('agent', 'gen-b', usage(50, 5, 200, 0.0005)), AT),
    llmRequestFromTurn(turn('compaction', 'gen-c', usage(3000, 400, 0, 0.003)), AT),
  ];
  const durable = usage(150, 15, 200, 0.0015);
  check('reconcile: rows match durable usage -> rows untouched (compaction not compared)', reconcileWithResponseUsage(rows, durable, AT) === rows);

  const lost = reconcileWithResponseUsage(rows.slice(1), durable, AT);
  const gap = lost.at(-1);
  check(
    'reconcile: observer missed a turn -> one unobserved row with the cost/token shortfall',
    lost.length === 3 && gap.purpose === 'unobserved' && gap.cost === 0.001 && gap.input_tokens === 100 && gap.output_tokens === 10 && !('id' in gap),
    j(gap),
  );

  const extra = [...rows, llmRequestFromTurn(turn('agent', 'gen-aborted', usage(80, 0, 0, 0.0007)), AT)];
  check('reconcile: rows above durable usage (aborted submission folded in) -> untouched', reconcileWithResponseUsage(extra, durable, AT) === extra);
  check('reconcile: float noise below a nano-dollar is no gap', reconcileWithResponseUsage(rows, usage(150, 15, 200, 0.0015 + 1e-12), AT) === rows);
}

// ---------------------------------------------------------------------------
// addLlmRequests

{
  const rows = [
    llmRequestFromTurn(turn('agent', 'gen-a', usage(100, 10, 0, 0.1)), AT),
    llmRequestFromTurn(turn('agent', 'gen-b', usage(50, 5, 200, 0.2)), AT),
    llmRequestFromTurn(turn('compaction', 'gen-c', usage(3000, 400, 0, 0.3)), AT),
    { at: AT.toISOString(), purpose: 'unobserved', input_tokens: 7, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, total_tokens: 7, cost: 0.05 },
  ];
  const state = addLlmRequests({ ...ZERO_LLM_TOTALS, tool_calls_count: 3 }, rows);
  check('totals: cost is the row sum, float noise rounded away (0.1+0.2+0.3+0.05)', state.cost_total === 0.65, String(state.cost_total));
  check('totals: unobserved adds cost/tokens but no call', state.llm_calls_count === 3 && state.input_tokens === 3157);
  check(
    'totals: cost_by_purpose sums to cost_total',
    j(state.cost_by_purpose) === j({ agent: 0.3, compaction: 0.3, unobserved: 0.05 }) &&
      roundUsd(Object.values(state.cost_by_purpose).reduce((a, b) => a + b, 0)) === state.cost_total,
    j(state.cost_by_purpose),
  );
  check('totals: unrelated fields of prev preserved', state.tool_calls_count === 3);

  const next = addLlmRequests(state, [llmRequestFromTurn(turn('agent', 'gen-d', usage(1, 1, 0, 0.01)), AT)]);
  check('totals: accumulate across responses', next.cost_total === 0.66 && next.llm_calls_count === 4 && next.cost_by_purpose.agent === 0.31);

  const legacy = addLlmRequests({ cost_total: 1.5, llm_calls_count: 9, input_tokens: 10 }, [
    llmRequestFromTurn(turn('compaction', 'gen-e', usage(1, 1, 0, 0.25)), AT),
  ]);
  check(
    'totals: pre-breakdown session -> prior total attributed to agent, breakdown still sums',
    legacy.cost_total === 1.75 && j(legacy.cost_by_purpose) === j({ agent: 1.5, compaction: 0.25 }) && legacy.llm_calls_count === 10,
    j(legacy),
  );
  const sorted = (o) => j(Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b))));
  check('totals: empty prev, no rows -> zeros, empty breakdown', sorted(addLlmRequests({}, [])) === sorted({ ...ZERO_LLM_TOTALS, cost_by_purpose: {} }));
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}  (${total} checks)`);
process.exit(failures === 0 ? 0 : 1);
