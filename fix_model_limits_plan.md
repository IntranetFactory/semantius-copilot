# Plan: fix model output limits (dated-slug catalog miss)

**Status: IMPLEMENTED 2026-08-13** (all four fixes + tests; see below). One
plan fact turned out wrong and forced a scope addition: the pi-ai copy
backend-b imported (0.81.1) ships a STALE catalog — its
`deepseek/deepseek-v4-flash` entry says `maxTokens: 4096` (below even the 8k
placeholder!), and since `configureLlm` re-registers the `openrouter`
provider whenever LLM_API_KEY is set, that stale catalog governed EVERY
session — the post-incident undated pin was still running with a 4096-token
output cap. The 1M/393k numbers in "The verified chain" below only exist in
pi-ai 0.83 (the copy Flue's own registry uses). Fix: backend-b now depends on
`@earendil-works/pi-ai@^0.83.0`; the 4-hunk patch (2 pre-existing OpenRouter
usage-accounting hunks + fixes 3 and 4a below) was ported to
`patches/@earendil-works__pi-ai@0.83.0.patch` and the 0.81.1 patch was
dropped — one pi-ai copy, one catalog, for llm.ts and the runtime alike.
Implementation notes: fix 1 lives in core (`resolveCatalogModel`,
`applyModelLimits` in `core/src/agent.js`) with llm.ts as the thin consumer;
fix 2 added `max_tokens`/`context_window` to agent.jsonc (schema +
`validateAgentConfig`/`validateAgentBundle` + bundler hash + seed/meta
plumbing through app.ts, agents/main.ts, channels/github.ts, and the
frontend seed type); fix 4b is a new
`patches/@earendil-works__pi-agent-core@0.83.0.patch`. Tests:
`scripts/model-limits.test.mjs` (wired into `pnpm test`) covers all four
fixes, driving the PATCHED dists from node_modules — including a real
`runAgentLoop` replay proving a flagged (truncated) tool call is failed with
the re-issue message and never executed. `agents/semantius-admin` is back on
the dated `-0731` slug on purpose (plan test 3).

**Original plan follows.** Status then: ready for implementation in a fresh session. Supersedes `fix_limits_and_stdin_hangs_plan.md` (deleted). Scope is the incident root cause only. **Consciously out of scope:** any default exec deadline or stdin handling — closing stdin is impossible in the persistent-session architecture (it is the command channel), and long-running scripts preclude a default command timeout; the existing skill-side warnings ("always pass commands their input explicitly") remain the mitigation for stdin-reading commands. Also out of scope, descoped earlier: bash content guards, heredoc validation, write/edit chunk caps.

Every fact below was verified against the code on 2026-08-13. Path shorthand: `PI81` = the patched pi-ai copy that actually runs (`backend-b/src/llm.ts:15` imports from `@earendil-works/pi-ai` 0.81.1; the runtime resolves 0.83 for its own registry — patch the running copy). `CORE` = `@earendil-works/pi-agent-core`. Both are patchable via the existing `patches/` mechanism.

## The verified chain (incident 2026-08-12)

We run `deepseek/deepseek-v4-flash-0731`; only the undated `deepseek/deepseek-v4-flash` is in pi-ai's catalog. On the miss, `backend-b/src/llm.ts:201-202` synthesizes a placeholder `contextWindow: 128000, maxTokens: 8192`. The context clamp (`PI81 dist/api/simple-options.js:2-13`) then shrinks the effective output budget as the conversation fills — in the incident to ~3,900 tokens ≈ the observed 8–15 KB mid-word cuts. DeepSeek recommends ~384k output tokens for the agentic workflow; the catalog's real entry is `contextWindow: 1048576, maxTokens: 393216` (= 384 × 1024). Already in the repo post-incident: `modelCatalogWarning` (`llm.ts:89-108`, deploy-time + once-per-isolate runtime warning) and `agent.jsonc` pinned to the undated slug — a tripwire that costs snapshot pinning and stops nothing at runtime.

## Fixes

1. **Dated-slug metadata fallback** (`backend-b/src/llm.ts`, the resolution path around `agentModelSpecifier` / the placeholder synthesis at `:201-202`): on a catalog miss, strip a trailing date suffix (`/-\d{3,4}$/`, e.g. `-0731`) and retry the catalog lookup with the base slug; on a hit, use the base model's metadata (1M window / 393k output) while keeping the original dated slug as the request model id. Pinned snapshots then get real limits. `modelCatalogWarning` keeps firing only for misses the fallback also can't resolve.
2. **Explicit per-agent override (optional but cheap):** allow `max_tokens` (and optionally `context_window`) in `agent.jsonc` for models no catalog knows. Touch: `core/agent.schema.json` + the `allowed` key list in `validateAgentConfig` (`core/src/agent.js:182-209`) + plumbing in `llm.ts`.
3. **Kill the silent floor:** `MIN_MAX_TOKENS = 1` (`PI81 dist/api/simple-options.js:8`, via the existing pi-ai patch) currently ships `max_tokens: 1` once context exceeds the window. Replace with a surfaced context-overflow error — a loud failure instead of a silently useless request.
4. **Safety net for residual truncation (recommended, ~10 lines across two patches; strike for the absolute minimum):** the incident proved providers don't reliably report `finish_reason: "length"` when they cut output — pi-ai then salvages the incomplete tool-call JSON (`parseStreamingJson` + `delete block.partialArgs` in `finishBlock`, `PI81 dist/api/openai-completions.js:171-174`) and the only guard (`CORE dist/agent-loop.js:117-123`) keys on the provider's honesty, so a truncated `write` executes with cut content. Patch (a): in `finishBlock`, strict-`JSON.parse` first and set `block.argumentsTruncated = true` before falling back to salvage. Patch (b): extend the guard to route `stopReason === "length" || toolCalls.some(c => c.argumentsTruncated)` into the existing `failToolCallsFromTruncatedMessage`, which already returns a model-readable "re-issue with complete arguments" result. Any residual truncation from any cause then becomes a loud, retried failure instead of a silently corrupt artifact.

## Tests

1. **Unit:** the dated-slug fallback resolves `deepseek/deepseek-v4-flash-0731` to the base entry (1M/393k); a genuinely unknown slug still warns; with the override key set, `agent.jsonc` values win; context overflow surfaces an error instead of shipping `max_tokens: 1`.
2. **Replay fixture (if fix 4 is kept):** a streamed response whose tool-call argument buffer ends mid-string with `finish_reason: stop` → the call is failed with the re-issue message, not executed.
3. **End-to-end regression:** deploy the HVAC blueprint (the incident artifact, 12 custom entities) on the **dated `-0731` slug** — the full-size single-shot spec writes must complete without truncation.

## Implementation order

1. Dated-slug fallback + `MIN_MAX_TOKENS` fix (+ override key if wanted) — kills the incident trigger.
2. Salvage-flag patches (if kept) — converts residual truncation into loud retries.
3. HVAC end-to-end regression on `-0731`.
