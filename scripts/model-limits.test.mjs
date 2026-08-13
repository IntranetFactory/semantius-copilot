#!/usr/bin/env node
/**
 * Model-limit regression tests for the 2026-08-12 truncation incident
 * (fix_model_limits_plan.md): a dated model slug (`deepseek/deepseek-v4-flash-0731`)
 * missed pi-ai's catalog, sessions ran on the synthesized 128k/8k placeholder,
 * and the context clamp squeezed the output budget until long single-shot
 * writes were cut mid-word — which the provider did not report as
 * finish_reason "length", so the salvage parser executed truncated tool calls.
 *
 * Covers the four fixes:
 *  1. dated-slug catalog fallback (core resolveCatalogModel) against the REAL
 *     pi-ai openrouter catalog the backend ships,
 *  2. agent.jsonc max_tokens/context_window overrides (validation, bundler
 *     plumbing, applyModelLimits precedence),
 *  3. the patched pi-ai context clamp: context overflow throws instead of
 *     silently shipping max_tokens: 1,
 *  4. the patched truncation guard: a tool call whose argument buffer only
 *     parsed via the streaming salvage parser (argumentsTruncated) is failed
 *     with the re-issue message, never executed — driven through the REAL
 *     patched pi-agent-core runAgentLoop with a canned stream function.
 *
 * Tests 3 and 4 import the PATCHED dists out of node_modules on purpose: they
 * verify the pnpm patches survived a reinstall, not a copy of their logic.
 */
import { realpathSync } from 'node:fs';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

import {
  AGENT_LIMITS,
  applyModelLimits,
  resolveCatalogModel,
  validateAgentBundle,
  validateAgentConfig,
} from '../core/src/agent.js';
import { createAgentBundleFromDir } from '../core/src/node.js';

let failures = 0;
let total = 0;
function check(name, ok, extra = '') {
  total += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
}

/** Resolve a file inside the pi-ai copy backend-b actually runs (0.81.1, patched). */
const piAiDir = realpathSync(
  fileURLToPath(new URL('../backend-b/node_modules/@earendil-works/pi-ai', import.meta.url)),
);
/** Resolve pi-agent-core through @flue/runtime's dependency link (0.83.0, patched). */
const flueRuntimeDir = realpathSync(
  fileURLToPath(new URL('../backend-b/node_modules/@flue/runtime', import.meta.url)),
);
const piAgentCoreDir = realpathSync(join(flueRuntimeDir, '..', '..', '@earendil-works', 'pi-agent-core'));

const { openrouterProvider } = await import(pathToFileURL(join(piAiDir, 'dist', 'providers', 'openrouter.js')));
const { clampMaxTokensToContext } = await import(pathToFileURL(join(piAiDir, 'dist', 'api', 'simple-options.js')));
const { parseJsonWithRepair, parseStreamingJson } = await import(
  pathToFileURL(join(piAiDir, 'dist', 'utils', 'json-parse.js'))
);
const { runAgentLoop } = await import(pathToFileURL(join(piAgentCoreDir, 'dist', 'agent-loop.js')));

// --- 1. dated-slug catalog fallback --------------------------------------
console.log('== dated-slug catalog fallback ==');
{
  const models = openrouterProvider().getModels();

  const dated = resolveCatalogModel(models, 'deepseek/deepseek-v4-flash-0731');
  check('the incident slug resolves via the undated base entry', dated.entry !== undefined && dated.exact === false);
  check('the request model id stays the DATED slug', dated.entry?.id === 'deepseek/deepseek-v4-flash-0731');
  check(
    'the metadata is the base entry\'s real limits (1M window / 393k output)',
    dated.entry?.contextWindow === 1048576 && dated.entry?.maxTokens === 393216,
    `got ${dated.entry?.contextWindow}/${dated.entry?.maxTokens}`,
  );

  const exact = resolveCatalogModel(models, 'deepseek/deepseek-v4-flash');
  check('the undated slug is an exact hit (case-1 fast path stays intact)', exact.exact === true && exact.entry?.id === 'deepseek/deepseek-v4-flash');

  const unknown = resolveCatalogModel(models, 'acme/model-nobody-has-heard-of');
  check('a genuinely unknown slug still misses (the deploy warning keeps firing)', unknown.entry === undefined && unknown.exact === false);

  const synthetic = [{ id: 'a/base', name: 'a/base', maxTokens: 7, contextWindow: 9 }];
  check('a non-date suffix (-v2) is not treated as a dated slug', resolveCatalogModel(synthetic, 'a/base-v2').entry === undefined);
  check('a 4-digit date suffix resolves too', resolveCatalogModel(synthetic, 'a/base-2024').entry?.maxTokens === 7);
  check('stripping only applies to the TAIL', resolveCatalogModel(synthetic, 'a/base-0731-x').entry === undefined);
}

// --- 2. explicit per-agent limit overrides -------------------------------
console.log('\n== agent.jsonc max_tokens / context_window overrides ==');
{
  const entry = { id: 'm', name: 'm', maxTokens: 8192, contextWindow: 128000 };
  const overridden = applyModelLimits(entry, { maxTokens: 393216, contextWindow: 1048576 });
  check('explicit overrides win over the entry', overridden.maxTokens === 393216 && overridden.contextWindow === 1048576);
  check('no overrides -> entry unchanged', applyModelLimits(entry, {}).maxTokens === 8192 && applyModelLimits(entry, undefined).contextWindow === 128000);
  const partial = applyModelLimits(entry, { maxTokens: 4096 });
  check('a partial override leaves the other limit alone', partial.maxTokens === 4096 && partial.contextWindow === 128000);

  const okConfig = { instructions: 'x', model: 'deepseek/deepseek-v4-flash-0731', max_tokens: 393216, context_window: 1048576 };
  let threw = null;
  try {
    validateAgentConfig(okConfig);
  } catch (err) {
    threw = err;
  }
  check('validateAgentConfig accepts the new keys', threw === null, String(threw ?? ''));

  const rejects = (patch) => {
    try {
      validateAgentConfig({ instructions: 'x', ...patch });
      return false;
    } catch {
      return true;
    }
  };
  check('max_tokens: 0 is rejected', rejects({ max_tokens: 0 }));
  check('max_tokens: 1.5 is rejected', rejects({ max_tokens: 1.5 }));
  check('max_tokens: "8192" is rejected', rejects({ max_tokens: '8192' }));
  check(`max_tokens above the ${AGENT_LIMITS.maxModelLimitTokens} sanity cap is rejected`, rejects({ max_tokens: AGENT_LIMITS.maxModelLimitTokens + 1 }));
  check('context_window: -1 is rejected', rejects({ context_window: -1 }));
  check('unknown keys are still rejected (typo guard)', rejects({ max_output_tokens: 5 }));

  // Bundler plumbing: agent.jsonc snake_case -> bundle camelCase, hashed into version.
  const dir = mkdtempSync(join(tmpdir(), 'model-limits-'));
  try {
    const agentDir = join(dir, 'testagent');
    const write = (maxTokens) => {
      writeFileSync(
        join(agentDir, 'agent.jsonc'),
        JSON.stringify({ instructions: 'do things', model: 'deepseek/deepseek-v4-flash-0731', max_tokens: maxTokens, context_window: 1048576 }),
      );
    };
    const { mkdirSync } = await import('node:fs');
    mkdirSync(agentDir, { recursive: true });
    write(393216);
    const bundle = createAgentBundleFromDir(agentDir);
    check('bundle carries maxTokens/contextWindow', bundle.maxTokens === 393216 && bundle.contextWindow === 1048576);
    check('bundle model got the openrouter/ prefix', bundle.model === 'openrouter/deepseek/deepseek-v4-flash-0731');
    check('the bundle re-validates (server ingest gate)', validateAgentBundle(JSON.stringify(bundle)).maxTokens === 393216);
    write(200000);
    check('changing max_tokens changes the version hash', createAgentBundleFromDir(agentDir).version !== bundle.version);

    const badBundle = { ...bundle, maxTokens: 'lots' };
    let rejected = false;
    try {
      validateAgentBundle(badBundle);
    } catch {
      rejected = true;
    }
    check('validateAgentBundle rejects a non-integer maxTokens', rejected);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- 3. context overflow is loud (patched pi-ai clamp) -------------------
console.log('\n== context overflow (patched clampMaxTokensToContext) ==');
{
  const model = { id: 'm', contextWindow: 16000, maxTokens: 8192 };
  const ctx = (chars) => ({ messages: [{ role: 'user', content: 'x'.repeat(chars) }] });

  check('a small context returns the full model cap', clampMaxTokensToContext(model, ctx(8), 8192) === 8192);

  const squeezed = clampMaxTokensToContext(model, ctx(40000), 8192); // ~10k tokens of context
  check('a filling context still degrades gradually (no throw, no floor)', squeezed > 1 && squeezed < 8192, `got ${squeezed}`);

  let overflow = null;
  try {
    clampMaxTokensToContext(model, ctx(20000 * 4), 8192); // ~20k tokens > 16k window
  } catch (err) {
    overflow = err;
  }
  check('context overflow THROWS instead of shipping max_tokens: 1', overflow instanceof Error, `got ${overflow === null ? 'no throw' : overflow}`);
  check('the error names the condition for the session log', String(overflow?.message).includes('Context overflow'));

  check('contextWindow <= 0 (unknown) still passes the cap through', clampMaxTokensToContext({ ...model, contextWindow: 0 }, ctx(8), 8192) === 8192);
}

// --- 4. truncated tool calls are failed, not executed --------------------
console.log('\n== truncation guard (patched finishBlock + agent loop) ==');
{
  // finishBlock's classification, at the parser level: a buffer cut mid-string
  // fails the complete-parse (-> argumentsTruncated) but still salvages;
  // complete-but-quirky JSON (raw newline in a string) repairs WITHOUT being
  // flagged, so legitimate model quirks keep executing.
  const cut = '{"path": "a.txt", "content": "hel';
  let strictFailed = false;
  try {
    parseJsonWithRepair(cut);
  } catch {
    strictFailed = true;
  }
  check('a mid-string cut fails the complete-parse (would be flagged)', strictFailed);
  check('…but the salvage parser still recovers partial args for the log', parseStreamingJson(cut).path === 'a.txt');
  check('complete-but-quirky JSON (raw newline) repairs, NOT flagged', parseJsonWithRepair('{"a": "l1\nl2"}').a === 'l1\nl2');

  // The guard, driven through the REAL patched runAgentLoop: a canned stream
  // function returns an assistant message carrying a flagged tool call.
  const executed = [];
  const writeTool = {
    name: 'write',
    description: 'write a file',
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
    execute: async (toolCallId, args) => {
      executed.push(args);
      return { content: [{ type: 'text', text: 'written' }], details: {} };
    },
  };
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const assistant = (content, stopReason) => ({
    role: 'assistant',
    content,
    api: 'openai-completions',
    provider: 'test',
    model: 'm',
    usage,
    stopReason,
    timestamp: Date.now(),
  });
  const cannedStreamFn = (queue) => () => {
    const message = queue.shift();
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: 'done', reason: message.stopReason, message };
      },
      result: async () => message,
    };
  };
  const run = async (toolCallBlock, stopReason) => {
    const queue = [
      assistant([toolCallBlock], stopReason),
      assistant([{ type: 'text', text: 'done' }], 'stop'),
    ];
    const config = { model: { id: 'm', api: 'openai-completions', provider: 'test' }, convertToLlm: async (m) => m };
    const context = { systemPrompt: 'test', messages: [], tools: [writeTool] };
    const messages = await runAgentLoop(
      [{ role: 'user', content: 'go', timestamp: Date.now() }],
      context,
      config,
      async () => {},
      undefined,
      cannedStreamFn(queue),
    );
    return messages.find((m) => m.role === 'toolResult');
  };

  const call = { type: 'toolCall', id: 'call_1', name: 'write', arguments: { path: 'a.txt', content: 'partial' } };

  const flagged = await run({ ...call, argumentsTruncated: true }, 'stop');
  check('a flagged call is NOT executed', executed.length === 0);
  check('…and fails with the re-issue message', flagged?.isError === true && flagged?.content?.[0]?.text?.includes('Re-issue the tool call'), JSON.stringify(flagged?.content));

  const lengthStop = await run({ ...call }, 'length');
  check('stopReason "length" still fails the batch (pre-existing guard intact)', executed.length === 0 && lengthStop?.isError === true);

  const clean = await run({ ...call }, 'stop');
  check('an unflagged call on a clean stop still executes', executed.length === 1 && clean?.isError !== true && clean?.content?.[0]?.text === 'written');
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}  (${total} checks)`);
process.exit(failures === 0 ? 0 : 1);
