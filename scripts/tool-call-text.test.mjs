#!/usr/bin/env node
/**
 * Model registry `drop_tool_call_text` -> entry `dropToolCallText` -> core
 * withoutToolCallText around the model's pi-ai API (backend-b/src/llm.ts
 * modelSpecifierFor). Muse Spark writes a status note next to nearly every
 * tool call; the filter drops those notes before Flue records anything, but
 * keeps substantial text, the first line of a turn, and text next to a
 * question card.
 *
 * Covers:
 *  1. validation (parseModelsConfig): boolean only, openrouter models only,
 *     inherited by `@` variants — and set on the real Muse entries;
 *  2. the event filter on hand-built event sequences: short notes next to a
 *     tool call are dropped (final message too); the first line of a turn is
 *     kept, once; multi-line or long text is kept and released as soon as it
 *     qualifies; AskUserQuestion keeps everything; text-only responses and
 *     errors keep their text; nothingShownThisTurn reads the conversation;
 *  3. the wrapper around the REAL pi-ai dist backend-b ships: openai-completions
 *     stream() against a canned SSE response, piped through
 *     withoutToolCallText with pi-ai's own createAssistantMessageEventStream,
 *     the way llm.ts wires it.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parseModelsConfig } from '../core/src/models.js';
import { dropToolCallText, nothingShownThisTurn, withoutToolCallText, SUBSTANTIAL_CHARS } from '../core/src/tool-call-text.js';

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
console.log('== drop_tool_call_text validation (model registry) ==');
{
  const registry = (value, provider = 'openrouter') =>
    parseModelsConfig(JSON.stringify({ models: { m: { name: 'M', provider, drop_tool_call_text: value } } }));
  check('true is accepted and carried as dropToolCallText', registry(true).m.dropToolCallText === true);
  check('false is accepted and leaves no entry field', !('dropToolCallText' in registry(false).m));
  check('a string is rejected', rejects(() => registry('true')));
  check('on an openai model it is rejected', rejects(() => registry(true, 'openai')));
  const variants = parseModelsConfig(
    JSON.stringify({
      models: {
        m: { name: 'M', provider: 'openrouter', drop_tool_call_text: true, reasoning_efforts: ['low', 'max'] },
        'm@max': { name: 'M (Max)' },
      },
    }),
  );
  check('an @ variant inherits it', variants['m@max'].dropToolCallText === true);

  const real = parseModelsConfig(readFileSync(new URL('../backend-b/agents_config.jsonc', import.meta.url), 'utf8'));
  const muse = Object.keys(real).filter((id) => id.startsWith('meta/muse-spark'));
  check('every Muse entry in agents_config.jsonc has it', muse.length > 0 && muse.every((id) => real[id].dropToolCallText === true), muse.join(', '));
  const others = Object.keys(real).filter((id) => !id.startsWith('meta/muse-spark') && real[id].dropToolCallText);
  check('no other model has it', others.length === 0, others.join(', '));
}

// --- 2. the event filter -------------------------------------------------
console.log('\n== event filter ==');
const filter = async (events, options) => {
  const out = [];
  for await (const event of dropToolCallText((async function* () { yield* events; })(), options)) out.push(event);
  return out;
};
const text = (i, s) => [
  { type: 'text_start', contentIndex: i },
  { type: 'text_delta', contentIndex: i, delta: s },
  { type: 'text_end', contentIndex: i, content: s },
];
// pi-ai names the tool-call block on the partial before toolcall_start.
const call = (i, name, content) => [
  { type: 'toolcall_start', contentIndex: i, partial: { content } },
  { type: 'toolcall_end', contentIndex: i, toolCall: { type: 'toolCall', id: `c${i}`, name, arguments: {} } },
];
const thinking = [{ type: 'thinking_start', contentIndex: 0 }, { type: 'thinking_end', contentIndex: 0, content: 'hm' }];
const done = (content) => ({ type: 'done', reason: content.some((b) => b.type === 'toolCall') ? 'toolUse' : 'stop', message: { role: 'assistant', content } });
const types = (events) => events.map((e) => e.type).join(',');
const blockTypes = (event) => event.message.content.map((b) => b.type).join(',');
const NOTE = 'Switching to quick setup — checking your current setup.';
{
  const toolMessage = [{ type: 'thinking', thinking: 'hm' }, { type: 'text', text: NOTE }, { type: 'toolCall', name: 'read' }, { type: 'text', text: 'and more' }];
  const toolEvents = [{ type: 'start' }, ...thinking, ...text(1, NOTE), ...call(2, 'read', toolMessage), ...text(3, 'and more'), done(toolMessage)];
  const out = await filter(toolEvents, { keepFirstLine: false });
  check('a short note before and after a tool call is dropped', !out.some((e) => e.type.startsWith('text_')), types(out));
  check('reasoning and tool-call events pass through', types(out) === 'start,thinking_start,thinking_end,toolcall_start,toolcall_end,done', types(out));
  check('the final message keeps reasoning and the tool call, no text', blockTypes(out.at(-1)) === 'thinking,toolCall', blockTypes(out.at(-1)));

  const first = await filter(toolEvents, { keepFirstLine: true });
  check('first line of a turn: kept, released ahead of the tool call', types(first) === 'start,thinking_start,thinking_end,text_start,text_delta,text_end,toolcall_start,toolcall_end,done', types(first));
  check('…only once: the second short text is still dropped', blockTypes(first.at(-1)) === 'thinking,text,toolCall', blockTypes(first.at(-1)));

  const long = 'Here is the plan. '.repeat(Math.ceil(SUBSTANTIAL_CHARS / 18));
  const longMessage = [{ type: 'text', text: long }, { type: 'toolCall', name: 'read' }];
  const longOut = await filter([{ type: 'start' }, ...text(0, long), ...call(1, 'read', longMessage), done(longMessage)], { keepFirstLine: false });
  check(`text of ${SUBSTANTIAL_CHARS}+ chars is kept and released before the tool call`, types(longOut) === 'start,text_start,text_delta,text_end,toolcall_start,toolcall_end,done' && blockTypes(longOut.at(-1)) === 'text,toolCall', types(longOut));

  const table = '| Entity | Purpose |\n|---|---|\n| Work Order | a job |';
  const tableMessage = [{ type: 'text', text: table }, { type: 'toolCall', name: 'read' }];
  const tableOut = await filter([{ type: 'start' }, ...text(0, table), ...call(1, 'read', tableMessage), done(tableMessage)], { keepFirstLine: false });
  check('multi-line text (a table) is kept even when short', blockTypes(tableOut.at(-1)) === 'text,toolCall', blockTypes(tableOut.at(-1)));

  const streaming = await filter([{ type: 'start' }, { type: 'text_start', contentIndex: 0 }, { type: 'text_delta', contentIndex: 0, delta: 'Step one.' }, { type: 'text_delta', contentIndex: 0, delta: '\nStep two.' }, { type: 'text_delta', contentIndex: 0, delta: ' More.' }], { keepFirstLine: false });
  check('substantial text streams from the moment it qualifies', types(streaming) === 'start,text_start,text_delta,text_delta,text_delta', types(streaming));

  const answer = await filter([{ type: 'start' }, ...thinking, ...text(1, 'The answer.'), done([{ type: 'thinking', thinking: 'hm' }, { type: 'text', text: 'The answer.' }])], { keepFirstLine: false });
  check('a text-only response keeps all its events, in order', types(answer) === 'start,thinking_start,thinking_end,text_start,text_delta,text_end,done', types(answer));
  check('…and its final message text', blockTypes(answer.at(-1)) === 'thinking,text');

  const failed = await filter([{ type: 'start' }, ...text(0, 'partial'), { type: 'error', reason: 'aborted', error: { role: 'assistant', content: [] } }]);
  check('an error keeps the text it got to', types(failed) === 'start,text_start,text_delta,text_end,error', types(failed));

  const askMessage = [{ type: 'text', text: NOTE }, { type: 'toolCall', name: 'AskUserQuestion' }];
  const asked = await filter([{ type: 'start' }, ...text(0, NOTE), ...call(1, 'AskUserQuestion', askMessage), done(askMessage)], { keepTextWith: ['AskUserQuestion'] });
  check('text next to AskUserQuestion is kept, ahead of the call', types(asked) === 'start,text_start,text_delta,text_end,toolcall_start,toolcall_end,done', types(asked));
  check('…and the final message keeps it', blockTypes(asked.at(-1)) === 'text,toolCall');

  const mixedMessage = [{ type: 'text', text: NOTE }, { type: 'toolCall', name: 'TaskUpdate' }, { type: 'toolCall', name: 'AskUserQuestion' }];
  const mixed = await filter([{ type: 'start' }, ...text(0, NOTE), ...call(1, 'TaskUpdate', mixedMessage), ...call(2, 'AskUserQuestion', mixedMessage), done(mixedMessage)], { keepTextWith: ['AskUserQuestion'] });
  check('a note settled at an earlier tool call stays dropped, even if a question follows', blockTypes(mixed.at(-1)) === 'toolCall,toolCall', blockTypes(mixed.at(-1)));

  // nothingShownThisTurn: the per-call keepFirstLine.
  const user = { role: 'user', content: 'hi' };
  const silentStep = { role: 'assistant', content: [{ type: 'toolCall', name: 'read' }] };
  const result = { role: 'toolResult', content: [] };
  const spoke = { role: 'assistant', content: [{ type: 'text', text: 'Got it.' }, { type: 'toolCall', name: 'read' }] };
  check('first call of a turn: nothing shown', nothingShownThisTurn({ messages: [user] }));
  check('after silent tool steps: still nothing shown', nothingShownThisTurn({ messages: [user, silentStep, result] }));
  check('after a step that showed text: something shown', !nothingShownThisTurn({ messages: [user, spoke, result, silentStep, result] }));
  check('a new user message starts a new turn', nothingShownThisTurn({ messages: [user, spoke, result, user] }));
}

// --- 3. through the real pi-ai dist ----------------------------------------
console.log('\n== pi-ai wrapper (installed dist) ==');
{
  const piAiDir = realpathSync(fileURLToPath(new URL('../backend-b/node_modules/@earendil-works/pi-ai', import.meta.url)));
  const { stream } = await import(pathToFileURL(join(piAiDir, 'dist', 'api', 'openai-completions.js')));
  const { createAssistantMessageEventStream } = await import(pathToFileURL(join(piAiDir, 'dist', 'utils', 'event-stream.js')));
  // As llm.ts wires it: AskUserQuestion is the keep tool.
  const api = withoutToolCallText({ stream, streamSimple: stream }, createAssistantMessageEventStream, ['AskUserQuestion']);
  // The placeholder entry modelSpecifierFor builds for Muse (a catalog miss).
  const model = {
    id: 'meta/muse-spark-1.3-contributor', name: 'meta/muse-spark-1.3-contributor', api: 'openai-completions',
    provider: 'model-meta-muse-spark-1.3-contributor', baseUrl: 'https://openrouter.ai/api/v1', reasoning: false,
    input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1048576, maxTokens: 16,
  };
  const firstCall = [{ role: 'user', content: 'hi', timestamp: Date.now() }];
  const laterCall = [
    ...firstCall,
    { role: 'assistant', content: [{ type: 'text', text: 'Got it.' }, { type: 'toolCall', id: 'call_0', name: 'read_file', arguments: {} }], stopReason: 'toolUse', timestamp: Date.now() },
    { role: 'toolResult', toolCallId: 'call_0', toolName: 'read_file', content: [{ type: 'text', text: 'ok' }], isError: false, timestamp: Date.now() },
  ];
  // A streamed (SSE) completion, as OpenRouter sends it: the content delta
  // first, then the tool call. pi-ai emits that response's text_end only
  // AFTER toolcall_start.
  const run = async ({ content, tool_calls }, messages = laterCall) => {
    const chunks = [
      { id: 'x', choices: [{ index: 0, delta: { role: 'assistant', content } }] },
      ...(tool_calls ? [{ id: 'x', choices: [{ index: 0, delta: { tool_calls: tool_calls.map((tc, index) => ({ index, ...tc })) } }] }] : []),
      { id: 'x', choices: [{ index: 0, delta: {}, finish_reason: tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
    ];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    try {
      const context = { systemPrompt: 's', messages, tools: [] };
      const s = api.stream(model, context, { apiKey: 'test-key', maxTokens: 16 });
      const events = [];
      for await (const event of s) events.push(event);
      return { events, result: await s.result() };
    } finally {
      globalThis.fetch = realFetch;
    }
  };
  const readCall = [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"/workspace/plan.md"}' } }];
  const resultTypes = (r) => r.result.content.map((b) => b.type).join(',');

  const note = await run({ content: "I'll read your plan file and summarize it.", tool_calls: readCall });
  check('later call, short note + tool call: no text reaches the consumer', !note.events.some((e) => e.type.startsWith('text_')), types(note.events));
  check('…the tool call does, and result() has no text', note.events.some((e) => e.type === 'toolcall_end') && resultTypes(note) === 'toolCall', resultTypes(note));

  const ack = await run({ content: "I'll read your plan file and summarize it.", tool_calls: readCall }, firstCall);
  check('first call of a turn: the short note is kept', ack.events.some((e) => e.type === 'text_delta') && resultTypes(ack) === 'text,toolCall', resultTypes(ack));

  const plan = await run({ content: 'Here is the plan:\n1. Capture what you are building.\n2. Draft the design.', tool_calls: readCall });
  check('later call, multi-line plan + tool call: kept', plan.events.some((e) => e.type === 'text_delta') && resultTypes(plan) === 'text,toolCall', resultTypes(plan));

  const question = await run({
    content: 'Here is the design I propose.',
    tool_calls: [{ id: 'call_2', type: 'function', function: { name: 'AskUserQuestion', arguments: '{"questions":[]}' } }],
  });
  check('AskUserQuestion response: its text reaches the consumer', question.events.some((e) => e.type === 'text_delta') && resultTypes(question) === 'text,toolCall', resultTypes(question));

  const answer = await run({ content: 'Here is the summary.' });
  check('text-only response: text events reach the consumer', answer.events.some((e) => e.type === 'text_delta'), types(answer.events));
  check('…and result() keeps the text', answer.result.content.some((b) => b.type === 'text' && b.text === 'Here is the summary.'));

  // A throw inside the filter (here: a done message without a content array)
  // must still settle result() — with the unfiltered message — not hang.
  const broken = { role: 'assistant', content: undefined, stopReason: 'stop' };
  const inner = createAssistantMessageEventStream();
  const out = withoutToolCallText({ stream: () => inner, streamSimple: () => inner }, createAssistantMessageEventStream).stream(model, { messages: firstCall });
  inner.push({ type: 'done', reason: 'stop', message: broken });
  inner.end();
  const settled = await Promise.race([out.result(), new Promise((resolve) => setTimeout(() => resolve('timeout'), 1000))]);
  check('a filter throw settles result() with the unfiltered message', settled === broken, String(settled));
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}  (${total} checks)`);
process.exit(failures === 0 ? 0 : 1);
