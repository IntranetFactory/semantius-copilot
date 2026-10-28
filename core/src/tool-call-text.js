/**
 * The registry's `drop_tool_call_text` (backend-b/agents_config.jsonc): short
 * status notes next to tool calls are dropped. Muse Spark writes one next to
 * nearly every tool call ("Switching to quick setup — checking your current
 * setup…"), at every reasoning effort and under every system prompt tried
 * (README "Dropping text next to tool calls"); prompting does not stop it, so
 * the text is removed from the model's stream before Flue sees it. Flue then
 * never records it, the chat never shows it, and the model never reads its
 * own status notes back on later turns.
 *
 * What a response that calls a tool keeps:
 *  - substantial text: multi-line or at least SUBSTANTIAL_CHARS long (a plan,
 *    a table, a summary) — streamed from the moment it qualifies;
 *  - the first short line of a user turn, when nothing has been shown since
 *    the user's last message (`keepFirstLine`, worked out per call by
 *    withoutToolCallText from the conversation) — one acknowledgement;
 *  - everything, when it calls one of the `keepTextWith` tools (the backend
 *    passes AskUserQuestion): text next to a question card is written for the
 *    user — the guidance before a first question, the table a confirmation
 *    question asks about.
 * A response with no tool call (the final answer, a question in plain text)
 * keeps all its text.
 *
 * Text is held until its kind is known: a block is released once it becomes
 * substantial, at the first `toolcall_start` (keep tool: all held text;
 * otherwise the first short line if allowed), or at a terminal event without
 * a tool call. Chat Completions sends a response's content before its tool
 * calls, so at `toolcall_start` the text is complete (pi-ai still emits its
 * `text_end` after that). So short text no longer streams on these models —
 * a short final answer appears in one piece. Reasoning and tool-call events
 * pass through as they arrive.
 *
 * Content indexes are left as they are: Flue keys blocks by index and orders
 * them by it on replay (unique, non-negative — gaps are fine), and the
 * `partial` messages still carry all text, which only the final message
 * replaces. That final message (the `done` event's, which is also the
 * stream's result) keeps only the text blocks that were released.
 */

const TEXT_EVENTS = new Set(['text_start', 'text_delta', 'text_end']);

/** Text at least this long, or spanning lines, is content, not a status note. */
export const SUBSTANTIAL_CHARS = 200;

const isSubstantial = (text) => text.length >= SUBSTANTIAL_CHARS || text.trim().includes('\n');

/**
 * pi-ai AssistantMessageEvents in, the same events with status notes removed out.
 *
 * @param {AsyncIterable<any>} events
 * @param {{ keepTextWith?: string[], keepFirstLine?: boolean }} [options]
 *   keepTextWith: tool names whose calls keep all of the response's text;
 *   keepFirstLine: whether this response may keep one short line
 * @returns {AsyncGenerator<any>}
 */
export async function* dropToolCallText(events, { keepTextWith = [], keepFirstLine = false } = {}) {
  /** contentIndex -> { state: 'held' | 'kept' | 'dropped', events, text } */
  let blocks = new Map();
  let keepAll = false;
  let firstLineFree = keepFirstLine;

  const release = function* (block) {
    block.state = 'kept';
    yield* block.events;
    block.events = [];
  };
  const releaseAll = function* () {
    for (const block of [...blocks.values()].filter((b) => b.state === 'held')) yield* release(block);
  };
  /** Settle every held block of a tool-call response: the first short line if allowed, else drop. */
  const settle = function* () {
    for (const block of [...blocks.values()].filter((b) => b.state === 'held')) {
      if (firstLineFree && block.text.trim().length > 0) {
        firstLineFree = false;
        yield* release(block);
      } else {
        block.state = 'dropped';
        block.events = [];
      }
    }
  };

  for await (const event of events) {
    if (TEXT_EVENTS.has(event.type)) {
      let block = blocks.get(event.contentIndex);
      if (!block) blocks.set(event.contentIndex, (block = { state: 'held', events: [], text: '' }));
      if (event.type === 'text_delta') block.text += event.delta;
      // A dropped block stays silent even after a keep tool call: pi-ai emits
      // every text_end after the last tool call, and Flue throws on an end
      // (or delta) for a block whose text_start it never saw, which fails the
      // whole run, the question card included.
      if (block.state === 'kept' || (keepAll && block.state === 'held')) yield event;
      else if (block.state === 'held') {
        block.events.push(event);
        if (isSubstantial(block.text)) yield* release(block);
      }
    } else if (event.type === 'toolcall_start') {
      // pi-ai names the block from the call's first chunk, before this event.
      if (!keepAll && keepTextWith.includes(event.partial?.content?.[event.contentIndex]?.name)) {
        keepAll = true;
        yield* releaseAll();
      } else if (!keepAll) {
        yield* settle();
      }
      yield event;
    } else if (event.type === 'done') {
      const hasToolCall = event.message.content.some((block) => block.type === 'toolCall');
      if (keepAll || !hasToolCall) yield* releaseAll();
      else yield* settle();
      // A block settled as dropped stays dropped, even when a later keep
      // tool call in the same response let the rest of its text through.
      const dropped = new Set([...blocks].filter(([, b]) => b.state === 'dropped').map(([index]) => index));
      const content = event.message.content.filter((block, index) => block.type !== 'text' || !dropped.has(index));
      yield dropped.size > 0 ? { ...event, message: { ...event.message, content } } : event;
      blocks = new Map();
      keepAll = false;
    } else if (event.type === 'error') {
      // A failed or aborted response keeps whatever text it got to.
      yield* releaseAll();
      yield event;
    } else {
      yield event;
    }
  }
  yield* releaseAll();
}

/**
 * Whether a model call starts with nothing shown since the user's last
 * message: no assistant text after it in the conversation. Dropped status
 * notes never reach the conversation, so they do not count.
 *
 * @param {{ messages?: any[] }} context pi-ai Context
 */
export function nothingShownThisTurn(context) {
  const messages = context?.messages ?? [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === 'user') return true;
    if (
      message.role === 'assistant' &&
      Array.isArray(message.content) &&
      message.content.some((block) => block.type === 'text' && block.text.trim().length > 0)
    ) {
      return false;
    }
  }
  return true;
}

/**
 * A pi-ai API implementation (ProviderStreams) whose streams run through
 * dropToolCallText. `createStream` is pi-ai's createAssistantMessageEventStream
 * (core does not depend on pi-ai).
 *
 * A throw inside the filter must not hang the turn: ending the stream without
 * a result would leave its result() pending forever, so the stream ends with
 * the unfiltered response instead (text included).
 *
 * @param {{ stream: Function, streamSimple: Function }} api
 * @param {() => { push(event: any): void, end(result?: any): void }} createStream
 * @param {string[]} [keepTextWith] tool names whose calls keep all of the response's text
 */
export function withoutToolCallText(api, createStream, keepTextWith = []) {
  const filter = (inner, context) => {
    const out = createStream();
    (async () => {
      try {
        const options = { keepTextWith, keepFirstLine: nothingShownThisTurn(context) };
        for await (const event of dropToolCallText(inner, options)) out.push(event);
        out.end();
      } catch {
        out.end(await inner.result());
      }
    })();
    return out;
  };
  return {
    stream: (model, context, options) => filter(api.stream(model, context, options), context),
    streamSimple: (model, context, options) => filter(api.streamSimple(model, context, options), context),
  };
}
