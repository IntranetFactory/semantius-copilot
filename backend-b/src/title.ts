/**
 * Auto-generated session titles for the sidebar (session record `title`).
 *
 * Two halves, same isolate-local observer posture as usage.ts:
 *  - observe() captures each agent-purpose `turn_request` — the only event
 *    that carries the model-visible message list — and keeps a compact text
 *    transcript per instance (never the raw messages: those can hold base64
 *    images).
 *  - maybeGenerateTitle() runs fire-and-forget from useResponseFinish: one
 *    small chat-completions call on the session's own model/key, merged into
 *    the KV session record. Best-effort like every KV mirror on this path —
 *    a lost write self-heals because the "is a title still needed" check
 *    reads the record again at the next response finish.
 *
 * Timing: first title after response 1 (every session gets one), refined
 * once at response >= 4 when there is real context. `title_responses`
 * records which response count produced the stored title.
 */
import { observe, type LlmMessage } from '@flue/runtime';
import { mergeExistingSessionRecord, readSession } from '@semantius-copilot/core';
import { chatCompletionsTarget, type AgentLlm } from './llm';

const TITLE_REFINE_AT = 4;
const MESSAGE_MAX_CHARS = 500;
const TRANSCRIPT_MAX_CHARS = 4000;
const TITLE_MAX_CHARS = 80;

const TITLE_SYSTEM_PROMPT =
  'You write titles for chat sessions. Reply with only a 3-6 word title ' +
  "summarizing what the user is doing, in the conversation's language. " +
  'No quotes, punctuation, or markdown.';

const transcriptByInstance = new Map<string, string>();

/** User/assistant text only — tool results, thinking, and images are noise
 * for a title and (images) unbounded memory. */
function transcriptFromMessages(messages: LlmMessage[]): string {
  const lines: string[] = [];
  let total = 0;
  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    const text = (
      typeof message.content === 'string'
        ? message.content
        : message.content
            .map((part) => (part.type === 'text' ? part.text : ''))
            .join(' ')
    ).replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const line = `${message.role === 'user' ? 'User' : 'Assistant'}: ${text.slice(0, MESSAGE_MAX_CHARS)}`;
    // Keep the EARLIEST messages when over budget — they define the topic.
    if (total + line.length > TRANSCRIPT_MAX_CHARS) break;
    lines.push(line);
    total += line.length;
  }
  return lines.join('\n');
}

observe((event) => {
  if (event.type !== 'turn_request' || event.purpose !== 'agent') return;
  const { instanceId } = event as { instanceId?: string };
  if (!instanceId) return;
  transcriptByInstance.set(instanceId, transcriptFromMessages(event.request.input.messages));
  // Bound isolate memory (same eviction posture as usage.ts): entries linger
  // only for sessions that die between a turn and its response finish.
  if (transcriptByInstance.size > 200) {
    const oldest = transcriptByInstance.keys().next().value;
    if (oldest !== undefined) transcriptByInstance.delete(oldest);
  }
});

/** Read-and-clear the transcript captured for one agent instance. */
export function drainTitleTranscript(instanceId: string): string {
  const transcript = transcriptByInstance.get(instanceId) ?? '';
  transcriptByInstance.delete(instanceId);
  return transcript;
}

/** One model reply -> one clean single-line title, or null to keep silent. */
function sanitizeTitle(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const title = raw
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'`“‘]+|["'`”’.]+$/g, '')
    .trim()
    .slice(0, TITLE_MAX_CHARS);
  return title.length > 0 ? title : null;
}

async function generateTitle(transcript: string, agent: AgentLlm | null | undefined): Promise<string | null> {
  const target = chatCompletionsTarget(agent);
  if (!target) return null;
  const res = await fetch(`${target.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${target.apiKey}`,
    },
    body: JSON.stringify({
      model: target.model,
      messages: [
        { role: 'system', content: TITLE_SYSTEM_PROMPT },
        { role: 'user', content: transcript },
      ],
      // Reasoning models spend the token budget on chain-of-thought and
      // return `content: null` once max_tokens is hit (observed with
      // tencent/hy3: finish_reason "length", 30/30 tokens in `reasoning`).
      // So: turn reasoning off via OpenRouter's unified param (only sent to
      // OpenRouter — a plain OpenAI-compatible endpoint may reject unknown
      // fields) and keep headroom in case it still reasons.
      max_tokens: 100,
      temperature: 0.3,
      ...(target.baseUrl.includes('openrouter.ai') ? { reasoning: { enabled: false } } : {}),
    }),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { choices?: { message?: { content?: unknown } }[] };
  return sanitizeTitle(data.choices?.[0]?.message?.content);
}

/**
 * Fire-and-forget from a SYNCHRONOUS useResponseFinish callback — returns
 * void immediately; all async work (KV read, model call, KV merge) happens
 * behind an unawaited promise so the chat response is never delayed.
 * mergeExistingSessionRecord (not the creating variant) so a straggling
 * title write can never resurrect a deleted/expired session.
 */
export function maybeGenerateTitle(
  store: { get(k: string): Promise<string | null>; put(k: string, v: string, o?: object): Promise<void> },
  id: string,
  transcript: string,
  agent: AgentLlm | null | undefined,
  responsesCount: number,
): void {
  if (!transcript || responsesCount < 1) return;
  void (async () => {
    const record = (await readSession(store, id)) as
      | { title?: unknown; title_responses?: unknown }
      | null;
    if (!record) return;
    const hasTitle = typeof record.title === 'string' && record.title.length > 0;
    const refined = Number(record.title_responses ?? 0) >= TITLE_REFINE_AT;
    // Needed when: no title yet (first pass, retried until it lands), or the
    // conversation reached the refine threshold and the stored title predates it.
    if (hasTitle && (refined || responsesCount < TITLE_REFINE_AT)) return;
    const title = await generateTitle(transcript, agent);
    if (!title) return;
    await mergeExistingSessionRecord(store, id, { title, title_responses: responsesCount });
  })().catch(() => {});
}
