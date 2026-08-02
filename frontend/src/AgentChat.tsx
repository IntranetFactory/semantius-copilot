/**
 * Panel B of the Chats (A/B) tab: the same flue agent session as Panel A, but
 * rendered with Vercel ai-elements (shadcn/Radix) for a richer UX — markdown
 * tables, collapsible tool-call cards, streamed reasoning, auto-scroll, and a
 * real busy indicator.
 *
 * Data source is identical to Panel A's `Chat`: `useFlueAgent({ client,
 * live:'sse' })` against the same agent Durable Object (v2 conversation-scoped
 * client), so both panels still converge. flue's `FlueConversationMessage`
 * mirrors the AI SDK v5 `UIMessage` shape that ai-elements consumes, so
 * mapping is near 1:1 — only role/status need trivial maps.
 */
import { useFlueAgent } from '@flue/react';
import type { FlueClient } from '@flue/sdk';
import type { ChatStatus } from 'ai';
import { MessageSquareIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from '@/components/ai-elements/conversation';
import { Message, MessageContent, MessageResponse } from '@/components/ai-elements/message';
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  type PromptInputMessage,
  PromptInputSubmit,
  PromptInputTextarea,
} from '@/components/ai-elements/prompt-input';
import { Reasoning, ReasoningContent, ReasoningTrigger } from '@/components/ai-elements/reasoning';
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from '@/components/ai-elements/tool';
import { WelcomeCard } from '@/components/ai-elements/welcome';
import { Spinner } from '@/components/ui/spinner';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { AgentWelcome } from '@/lib/session';

type AgentMessage = ReturnType<typeof useFlueAgent>['messages'][number];
type AgentPart = AgentMessage['parts'][number];

/** flue AgentStatus → ai-elements ChatStatus (drives the submit-button icon). */
function toChatStatus(status: ReturnType<typeof useFlueAgent>['status']): ChatStatus {
  if (status === 'streaming') return 'streaming';
  if (status === 'submitted' || status === 'connecting') return 'submitted';
  if (status === 'error') return 'error';
  return 'ready';
}

export function AgentChat({
  client,
  welcome,
  initialMessage,
  onDraftSend,
  draftPending,
}: {
  /** Absent = draft mode: the surface renders before any session exists (the
   * hook stays dormant), and the first submit goes through onDraftSend. */
  client?: FlueClient;
  welcome?: AgentWelcome;
  /** The text whose submit created this session — sent exactly once after the
   * live mount, so the user's first message is never lost in the handoff. */
  initialMessage?: string;
  /** Draft-mode submit: resolves once the session exists (rejects = create
   * failed, and the text is restored into the composer). */
  onDraftSend?: (text: string) => Promise<void>;
  /** True while the session create is in flight — locks the composer. */
  draftPending?: boolean;
}) {
  const [input, setInput] = useState('');
  // One held SSE stream (same as Panel A) — needs the @durable-streams/client
  // patch. The v2 client is conversation-scoped, so no name/id here: the
  // conversation is whatever URL the client was constructed with.
  const agent = useFlueAgent({ client, live: 'sse' });
  const draft = !client;

  // The message that triggered session creation, sent once the live client is
  // mounted. Ref-guarded: key={sessionId} gives one mount per session, and the
  // ref keeps re-renders from re-sending. sendMessage POSTs independently of
  // the history/SSE stream, so firing right after mount is safe.
  const sentInitial = useRef(false);
  useEffect(() => {
    if (!client || !initialMessage || sentInitial.current) return;
    sentInitial.current = true;
    void agent.sendMessage(initialMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once per mount
  }, []);

  const chatStatus: ChatStatus = draft ? (draftPending ? 'submitted' : 'ready') : toChatStatus(agent.status);
  const busy = chatStatus === 'submitted' || chatStatus === 'streaming';

  // Clears the composer up front so it never shows the sent text next to the
  // "Working…" strip while the session create is in flight. Failure restores
  // the text — including a welcome-card click, which lands in the composer.
  function draftSend(text: string) {
    if (draftPending) return;
    setInput('');
    void onDraftSend?.(text).catch(() => setInput(text));
  }

  function handleSubmit(message: PromptInputMessage) {
    const text = message.text.trim();
    if (!text) return;
    if (draft) {
      draftSend(text);
      return;
    }
    setInput('');
    void agent.sendMessage(text);
  }

  function handleStop() {
    // abort() resolves once the intent is recorded; the run settles to
    // 'aborted' asynchronously and status resets via the live stream. In draft
    // mode there is nothing to abort (the composer is locked during create).
    void client?.abort().catch((error) => console.error('abort failed', error));
  }

  return (
    <TooltipProvider>
      <div className="mt-2 flex h-[60vh] flex-col overflow-hidden rounded-lg border bg-background text-foreground">
        <Conversation>
          <ConversationContent>
            {agent.messages.length === 0 ? (
              welcome ? (
                <WelcomeCard
                  welcome={welcome}
                  onSend={draft ? draftSend : (text) => void agent.sendMessage(text)}
                  onPrefill={setInput}
                />
              ) : (
                <ConversationEmptyState
                  icon={<MessageSquareIcon className="size-10" />}
                  title="No messages yet"
                  description="Send a message — it appears in Panel A too (same session)."
                />
              )
            ) : (
              agent.messages.map((message) => <MessageView key={message.id} message={message} />)
            )}
          </ConversationContent>
          <ConversationScrollButton />
        </Conversation>

        <div className="border-t p-3">
          {/* Busy strip: visible for the whole run (submitted AND streaming), not
              just before the first token — during streaming the agent can spend
              long stretches in server-side tool calls with nothing new rendering,
              and the chat must not look idle while the stop icon shows. */}
          {busy ? (
            <div className="mb-2 flex items-center gap-2 text-muted-foreground text-sm">
              <Spinner /> Working…
            </div>
          ) : null}
          <PromptInput onSubmit={handleSubmit}>
            <PromptInputBody>
              <PromptInputTextarea
                value={input}
                placeholder='Try: "Plan me a spa day in the Echo Basin, Aug 1-3 2026"'
                onChange={(event) => setInput(event.currentTarget.value)}
              />
            </PromptInputBody>
            <PromptInputFooter>
              {/* No status text — the submit icon reflects agent.status via
                  toChatStatus: ready ↵ / submitted ⟳ / streaming ⏹ / error ✕.
                  While generating the button is enabled and onStop wires the
                  click to client.abort() (kills the run and any queued work). */}
              <PromptInputSubmit
                status={chatStatus}
                disabled={draft ? draftPending || !input.trim() : !busy && !input.trim()}
                onStop={handleStop}
                className="ml-auto"
              />
            </PromptInputFooter>
          </PromptInput>
        </div>
      </div>
    </TooltipProvider>
  );
}

function MessageView({ message }: { message: AgentMessage }) {
  // Consolidate all reasoning parts into one block (a model may emit several) so
  // there's a single "Thinking…" affordance rather than one per part.
  const reasoningParts = message.parts.filter(
    (part): part is Extract<AgentPart, { type: 'reasoning' }> => part.type === 'reasoning',
  );
  const reasoningText = reasoningParts.map((part) => part.text).join('\n\n');
  const lastPart = message.parts.at(-1);
  const isReasoningStreaming = lastPart?.type === 'reasoning' && lastPart.state === 'streaming';

  return (
    <Message from={message.role}>
      <MessageContent>
        {reasoningParts.length > 0 ? (
          <Reasoning className="w-full" isStreaming={isReasoningStreaming}>
            <ReasoningTrigger />
            <ReasoningContent>{reasoningText}</ReasoningContent>
          </Reasoning>
        ) : null}
        {message.parts.map((part, index) => (
          <PartView key={index} part={part} />
        ))}
      </MessageContent>
    </Message>
  );
}

function PartView({ part }: { part: AgentPart }) {
  switch (part.type) {
    case 'text':
      return <MessageResponse>{part.text}</MessageResponse>;
    case 'dynamic-tool':
      return (
        // Auto-open on error so the failure is visible without a click.
        <Tool defaultOpen={part.state === 'output-error'}>
          <ToolHeader type="dynamic-tool" toolName={part.toolName} state={part.state} />
          <ToolContent>
            <ToolInput input={part.input} />
            <ToolOutput
              output={part.state === 'output-available' ? part.output : undefined}
              errorText={part.state === 'output-error' ? part.errorText : undefined}
            />
          </ToolContent>
        </Tool>
      );
    case 'file':
      // Defensive — hoth likely emits no attachments. Render inline if present.
      if (!part.url) return null;
      return part.mediaType?.startsWith('image/') ? (
        <img src={part.url} alt={part.filename ?? ''} className="max-w-full rounded-md" />
      ) : (
        <a href={part.url} target="_blank" rel="noreferrer" className="text-primary underline">
          {part.filename ?? 'attachment'}
        </a>
      );
    default:
      // 'reasoning' is rendered in the consolidated block above.
      return null;
  }
}
