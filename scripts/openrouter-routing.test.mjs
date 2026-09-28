#!/usr/bin/env node
/**
 * Model registry (backend-b/agents_config.jsonc) `openrouter_routing` ->
 * entry `openRouterRouting` -> pi-ai `compat.openRouterRouting` -> OpenRouter
 * request-body `provider`.
 *
 * Covers:
 *  1. validation (parseModelsConfig): plain object, size cap, openrouter
 *     models only, NO key whitelist — the object is forwarded verbatim and
 *     OpenRouter validates its own routing fields, so unknown keys must pass;
 *  2. registry plumbing: snake_case -> camelCase, carried verbatim;
 *  3. the forwarding seam in the REAL pi-ai dist backend-b ships: a model
 *     entry carrying `compat.openRouterRouting` yields a request body whose
 *     `provider` field is that object, byte-for-byte — driven through pi-ai's
 *     openai-completions stream() against a canned fetch, so this verifies
 *     the installed package (not a copy of its logic) still forwards.
 *
 * backend-b/src/llm.ts (modelSpecifierFor's withRouting) is Worker code
 * (`cloudflare:workers` import) and cannot be imported here; its contribution
 * is one spread — `compat: { ...entry.compat, openRouterRouting }` — which
 * test 3 exercises at the pi-ai boundary it targets. The live path is
 * verified against the deployed worker (README "OpenRouter provider routing").
 */
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { AGENT_LIMITS } from '../core/src/agent.js';
import { parseModelsConfig } from '../core/src/models.js';

let failures = 0;
let total = 0;
function check(name, ok, extra = '') {
  total += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
}
const rejects = (fn) => {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
};

// --- 1. validation -------------------------------------------------------
console.log('== openrouter_routing validation (model registry) ==');
const registry = (routing, provider = 'openrouter') =>
  parseModelsConfig(JSON.stringify({ models: { m: { name: 'M', provider, model: 'deepseek/deepseek-v4-flash', openrouter_routing: routing } } }));
{
  const routing = { sort: 'throughput', max_price: { prompt: 0.5, completion: 1 }, only: ['deepseek'] };
  check('a routing object is accepted', !rejects(() => registry(routing)));
  check(
    'unknown routing keys pass (verbatim forwarding — OpenRouter validates, not us)',
    !rejects(() => registry({ some_future_field: { p50: 1 } })),
  );
  check('an empty object is accepted (harmless `provider: {}`)', !rejects(() => registry({})));
  check('an array is rejected', rejects(() => registry(['throughput'])));
  check('a string is rejected', rejects(() => registry('throughput')));
  check('null is rejected', rejects(() => registry(null)));
  check(
    `over ${AGENT_LIMITS.maxRoutingBytes} serialized bytes is rejected`,
    rejects(() => registry({ ignore: Array.from({ length: 600 }, (_, i) => `provider-${i}`) })),
  );
  check('routing on an openai model is rejected', rejects(() => registry({}, 'openai')));
}

// --- 2. registry plumbing ------------------------------------------------
console.log('\n== registry plumbing ==');
{
  const withRouting = registry({ sort: 'throughput' });
  check('the entry carries openRouterRouting verbatim', JSON.stringify(withRouting.m.openRouterRouting) === '{"sort":"throughput"}');
  const without = parseModelsConfig(JSON.stringify({ models: { m: { name: 'M', provider: 'openrouter', model: 'x/y' } } }));
  check('no routing -> no entry field', !('openRouterRouting' in without.m));
}

// --- 3. pi-ai forwards compat.openRouterRouting as the `provider` field -----
console.log('\n== pi-ai forwarding (installed dist) ==');
{
  const piAiDir = realpathSync(fileURLToPath(new URL('../backend-b/node_modules/@earendil-works/pi-ai', import.meta.url)));
  const { openrouterProvider } = await import(pathToFileURL(join(piAiDir, 'dist', 'providers', 'openrouter.js')));
  const { stream } = await import(pathToFileURL(join(piAiDir, 'dist', 'api', 'openai-completions.js')));

  const catalogEntry = openrouterProvider().getModels().find((m) => m.id === 'deepseek/deepseek-v4-flash');
  check('the catalog entry exists (test precondition)', catalogEntry !== undefined);

  const routing = { sort: 'throughput', require_parameters: true, max_price: { prompt: 0.5, completion: 1 } };
  // Exactly what backend-b/src/llm.ts withRouting() builds: the entry with the
  // routing spliced into compat, everything else (reasoning, limits) intact.
  const model = { ...catalogEntry, provider: 'agent-test', compat: { ...(catalogEntry.compat ?? {}), openRouterRouting: routing } };

  const captured = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    captured.push({ url: String(url), body: JSON.parse(init.body) });
    // Minimal well-formed completion so stream() settles cleanly.
    return new Response(
      JSON.stringify({ id: 'x', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  try {
    const context = { systemPrompt: 's', messages: [{ role: 'user', content: 'hi', timestamp: Date.now() }], tools: [] };
    const s = stream(model, context, { apiKey: 'test-key', stream: false, maxTokens: 16 });
    try {
      await s.result();
    } catch {
      // The canned response may not satisfy every parse path; the request
      // body was captured before any parsing, which is all this test needs.
    }
  } finally {
    globalThis.fetch = realFetch;
  }
  const req = captured[0];
  check('one request went out', captured.length >= 1, `captured ${captured.length}`);
  check('…to the OpenRouter endpoint', req?.url.startsWith('https://openrouter.ai/api/v1'), req?.url);
  check('the request body `provider` IS the routing object, verbatim', JSON.stringify(req?.body?.provider) === JSON.stringify(routing), JSON.stringify(req?.body?.provider));
  check('the model id is untouched (no :nitro suffix games)', req?.body?.model === 'deepseek/deepseek-v4-flash', req?.body?.model);
  check('the usage-accounting patch still rides along', req?.body?.usage?.include === true);

  const withoutRouting = [];
  globalThis.fetch = async (url, init) => {
    withoutRouting.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ id: 'x', choices: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const context = { systemPrompt: 's', messages: [{ role: 'user', content: 'hi', timestamp: Date.now() }], tools: [] };
    const s = stream({ ...catalogEntry, provider: 'agent-test' }, context, { apiKey: 'test-key', stream: false, maxTokens: 16 });
    try {
      await s.result();
    } catch {
      /* see above */
    }
  } finally {
    globalThis.fetch = realFetch;
  }
  check('no routing on the entry -> no `provider` field at all', withoutRouting[0] !== undefined && !('provider' in withoutRouting[0]));
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}  (${total} checks)`);
process.exit(failures === 0 ? 0 : 1);
