/**
 * One agent conversation, rendered with ai-elements (shadcn/Radix): markdown
 * tables, collapsible tool-call cards, streamed reasoning, auto-scroll, and a
 * real busy indicator. Driven by `useFlueAgent({ client, live: 'sse' })`
 * against the conversation's agent Durable Object (v2 conversation-scoped
 * client); flue's `FlueConversationMessage` mirrors the AI SDK v5 `UIMessage`
 * shape ai-elements consumes, so mapping is near 1:1.
 *
 * This is the RENDERER half of the surface: it needs a client (or draft
 * callbacks) handed in. The reusable entry point that owns the session
 * lifecycle is AgentChatContainer (./agent-chat-container.tsx).
 */
import { useFlueAgent } from '@flue/react';
import type { FlueClient } from '@flue/sdk';
import type { ChatStatus } from 'ai';
import { MessageSquareIcon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { Spinner } from '@/components/ui/spinner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from './conversation';
import { Message, MessageContent, MessageResponse } from './message';
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  type PromptInputMessage,
  PromptInputSubmit,
  PromptInputTextarea,
} from './prompt-input';
import { Reasoning, ReasoningContent, ReasoningTrigger } from './reasoning';
import { seedFromMeta, useAgentMeta, withAgentSeed, type ChatAuth } from './session';
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from './tool';
import { WelcomeCard } from './welcome';

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
  auth,
  agentName,
  baseUrl,
  initialMessage,
  onDraftSend,
  draftPending,
  onResponseSettled,
  className,
  placeholder,
}: {
  /** Absent = draft mode: the surface renders before any session exists (the
   * hook stays dormant), and the first submit goes through onDraftSend. */
  client?: FlueClient;
  /** The user's own credential — this component loads the agent's meta with it. */
  auth: ChatAuth;
  /** WHICH agent this conversation is with. The component loads the agent's
   * welcome card and turn-1 seed itself, live from the backend registry
   * (useAgentMeta) — no build-time agent knowledge anywhere. */
  agentName: string;
  /** Backend origin the meta is loaded from (defaults to session.ts BACKEND). */
  baseUrl?: string;
  /** The text whose submit created this session — sent exactly once after the
   * live mount, so the user's first message is never lost in the handoff. */
  initialMessage?: string;
  /** Draft-mode submit: resolves once the session exists (rejects = create
   * failed, and the text is restored into the composer). */
  onDraftSend?: (text: string) => Promise<void>;
  /** True while the session create is in flight — locks the composer. */
  draftPending?: boolean;
  /** Fires once each time a run settles (busy → idle) — e.g. for hosts to
   * refresh a session list whose server-side metadata trails the response. */
  onResponseSettled?: () => void;
  /** Merged into the conversation frame (e.g. to override the default height). */
  className?: string;
  /** Composer placeholder text. */
  placeholder?: string;
}) {
  const [input, setInput] = useState('');
  // The agent's live definition meta: welcome card + turn-1 seed. Draft
  // submits are blocked until it is here (the very first send of a session
  // must carry the seed), so the key-flip remount below always finds it in
  // the module cache, synchronously.
  const { meta, metaError } = useAgentMeta(auth, agentName, baseUrl);
  const welcome = meta?.welcome;
  // Attach the seed to every send; only the instance-creating send reads it.
  const seededClient = useMemo(() => (client && meta ? withAgentSeed(client, seedFromMeta(meta)) : client), [client, meta]);
  // One held SSE stream — needs the @durable-streams/client patch. The v2
  // client is conversation-scoped, so no name/id here: the conversation is
  // whatever URL the client was constructed with.
  const agent = useFlueAgent({ client: seededClient, live: 'sse' });
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

  // Settle edge (busy → idle) reported to the host. Ref-guarded so re-renders
  // at a stable status never re-fire; the callback lives in a ref so a host
  // passing a fresh closure each render doesn't churn the effect.
  const wasBusy = useRef(false);
  const settledCallback = useRef(onResponseSettled);
  settledCallback.current = onResponseSettled;
  useEffect(() => {
    if (busy) {
      wasBusy.current = true;
      return;
    }
    if (wasBusy.current) {
      wasBusy.current = false;
      settledCallback.current?.();
    }
  }, [busy]);

  // The draft submit, echoed as an optimistic user bubble while the session
  // create is in flight (the dormant hook has no messages to show it).
  const [draftEcho, setDraftEcho] = useState<string>();

  // Clears the composer up front and echoes the text into the conversation, so
  // the send is visible instantly. Failure undoes both: the echo drops and the
  // text is restored — including a welcome-card click, which lands in the
  // composer.
  function draftSend(text: string) {
    if (draftPending || !meta) return; // no send before the seed is here
    setInput('');
    setDraftEcho(text);
    void onDraftSend?.(text).then(
      // Success normally unmounts this draft instance (key flip). When it
      // resolves WITHOUT a remount (navigation dropped the create), the echo
      // must not linger over a fresh draft.
      () => setDraftEcho(undefined),
      () => {
        setDraftEcho(undefined);
        setInput(text);
      },
    );
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

  // What to show while the hook has no messages yet: the draft echo carries the
  // create phase, initialMessage carries the post-remount gap (connect + send +
  // history round-trip). The moment real messages land, they take over.
  const echo = draft ? draftEcho : initialMessage;

  // The strip also covers the handoff gap where the echo bubble is the only
  // content: status can blip through 'ready' between the live mount and the
  // initial send, and the chat must not look idle mid-handoff. Error drops it.
  const showBusy = busy || (!!echo && agent.messages.length === 0 && chatStatus !== 'error');

  // A draft whose agent cannot be loaded is not a chat: a bad/expired
  // credential or an unknown agent name renders the error ALONE — no
  // conversation frame, no composer to type into.
  if (draft && metaError) {
    return (
      <div className="mt-2 rounded-lg border bg-background p-6 text-foreground">
        <p className="font-medium">Agent "{agentName}" unavailable</p>
        <p className="mt-1 text-muted-foreground text-sm">{metaError}</p>
      </div>
    );
  }

  return (
    <TooltipProvider>
      <div className={cn('mt-2 flex h-[60vh] flex-col overflow-hidden rounded-lg border bg-background text-foreground', className)}>
        <Conversation>
          <ConversationContent>
            {agent.messages.length === 0 ? (
              echo ? (
                <Message from="user">
                  <MessageContent>
                    <MessageResponse>{echo}</MessageResponse>
                  </MessageContent>
                </Message>
              ) : !meta ? (
                <div className="flex items-center justify-center gap-2 py-10 text-muted-foreground text-sm">
                  <Spinner /> loading {agentName}…
                </div>
              ) : welcome ? (
                <WelcomeCard
                  welcome={welcome}
                  onSend={draft ? draftSend : (text) => void agent.sendMessage(text)}
                  onPrefill={setInput}
                />
              ) : (
                <ConversationEmptyState
                  icon={<MessageSquareIcon className="size-10" />}
                  title="No messages yet"
                  description="Send a message to start the conversation."
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
          {showBusy ? (
            <div className="mb-2 flex items-center gap-2 text-muted-foreground text-sm">
              <Spinner /> Working…
            </div>
          ) : null}
          <PromptInput onSubmit={handleSubmit}>
            <PromptInputBody>
              <PromptInputTextarea
                value={input}
                placeholder={placeholder ?? 'Type a message…'}
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
                disabled={draft ? draftPending || !meta || !input.trim() : !busy && !input.trim()}
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
      // Defensive — the backend likely emits no attachments. Render inline if present.
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
