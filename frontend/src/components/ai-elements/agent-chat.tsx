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
  ASK_USER_ANSWER_SIGNAL_TYPE,
  ASK_USER_ANSWER_TAG,
  ASK_USER_TOOL_NAME,
  AskUserQuestionCard,
  parseQuestions,
  type AskUserAnswerPayload,
  type AskUserQuestionStatus,
} from './ask-user-question';
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from './conversation';
import { HintTip } from './hint';
import { Message, MessageContent, MessageResponse } from './message';
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  type PromptInputMessage,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from './prompt-input';
import { Reasoning, ReasoningContent, ReasoningTrigger } from './reasoning';
import { seedFromMeta, useAgentMeta, withAgentSeed, type ChatAuth } from './session';
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from './tool';
import { WelcomeCard } from './welcome';
import { chatMarkdownComponents, WorkspaceLinkContext } from './workspace-link';
import { WorkspaceUploadButton } from './workspace-upload';

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
  sessionId,
  onEnsureSession,
  initialMessage,
  onDraftSend,
  draftPending,
  onResponseSettled,
  hint,
  onHint,
  onDismissHint,
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
  /** The session whose /workspace the composer's upload button targets. */
  sessionId?: string;
  /** Draft-mode fallback for the upload button: answers a session id, creating
   * the session on first use (the container dedupes it with the first-send
   * create). Without it a draft composer's upload button is disabled. */
  onEnsureSession?: () => Promise<string>;
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
  /** The tip to show above the composer, or undefined for none. Held by the
   * HOST, not here: a draft's welcome-card send remounts this component (the
   * container's 'draft' → sessionId key flip), which would drop the tip the
   * very click that raised it. */
  hint?: string;
  /** A clicked welcome prompt's `hint` (`key` = its `display`) — the host
   * decides whether it was already dismissed and puts it back in via `hint`. */
  onHint?: (hint: string, key: string) => void;
  /** The tip's ✕. */
  onDismissHint?: () => void;
  /** Merged into the conversation frame (e.g. to override the default height). */
  className?: string;
  /** Composer placeholder text. */
  placeholder?: string;
}) {
  const [input, setInput] = useState('');
  const [uploadError, setUploadError] = useState<string>();
  // What the markdown link override needs to resolve and download
  // /workspace/{sessionId}/<file> links from agent replies.
  const linkCtx = useMemo(() => ({ auth, sessionId, baseUrl }), [auth, sessionId, baseUrl]);
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

  // The transcript is the `display: 'visible'` messages only. Flue also streams
  // framework-authored system messages classified `diagnostic` (the resources /
  // instructions / environment narration signals — "New skill available: …") and
  // `hidden` (stream_interrupted/continued plumbing). Those are written FOR THE
  // MODEL — it reads them as a <signal> block in a user turn — and belong in an
  // activity panel, not in the chat bubble. Rendering them verbatim put a raw
  // skill catalog at the end of an answer.
  const messages = useMemo(
    () => agent.messages.filter((message) => message.display === 'visible'),
    [agent.messages],
  );

  // AskUserQuestion answers, keyed by toolCallId. Scanned over ALL messages
  // (not the visible filter): the answer signal projects as a diagnostic
  // system message, matched by its tagName — the delivered `type` is not in
  // the projection. Durable truth for the card's answered state, so reloads
  // and the container's key-flip remount re-derive it from history alone.
  const questionAnswers = useMemo(() => {
    const map = new Map<string, AskUserAnswerPayload>();
    for (const message of agent.messages) {
      if (message.signal?.tagName !== ASK_USER_ANSWER_TAG) continue;
      const toolCallId = message.signal.attributes?.toolCallId;
      const text = message.parts.find((part) => part.type === 'text')?.text;
      if (!toolCallId || !text) continue;
      try {
        map.set(toolCallId, JSON.parse(text) as AskUserAnswerPayload);
      } catch {
        // Malformed body — leave the card pending/stale rather than crash.
      }
    }
    return map;
  }, [agent.messages]);

  // Answer sends in flight: toolCallId → submissionId once admitted. Transient
  // UI only ("Sending…" + busy strip) — the signal echo above takes over the
  // moment it lands. Entries are pruned when their submission settles.
  const [answersInFlight, setAnswersInFlight] = useState<Map<string, string | undefined>>(new Map());
  const [answerError, setAnswerError] = useState<string>();

  const chatStatus: ChatStatus = draft ? (draftPending ? 'submitted' : 'ready') : toChatStatus(agent.status);
  const busy = chatStatus === 'submitted' || chatStatus === 'streaming';

  // The hook's status stays 'idle' between a raw client.send() and the first
  // streamed token (activeSubmissionIds only grows via its own sendMessage),
  // so an unsettled answer send keeps the busy strip up itself.
  const answerInFlight =
    answersInFlight.size > 0 &&
    [...answersInFlight.values()].some(
      (submissionId) =>
        !submissionId || !agent.settlements.some((settlement) => settlement.submissionId === submissionId),
    );
  useEffect(() => {
    if (answersInFlight.size === 0) return;
    const settled = [...answersInFlight.entries()].filter(
      ([, submissionId]) =>
        submissionId && agent.settlements.some((settlement) => settlement.submissionId === submissionId),
    );
    if (settled.length === 0) return;
    setAnswersInFlight((prev) => {
      const next = new Map(prev);
      for (const [toolCallId] of settled) next.delete(toolCallId);
      return next;
    });
  }, [agent.settlements, answersInFlight]);

  async function sendQuestionAnswer(toolCallId: string, result: { answers: Record<string, string>; cancelled: boolean }) {
    if (!seededClient) return;
    setAnswerError(undefined);
    setAnswersInFlight((prev) => new Map(prev).set(toolCallId, undefined));
    try {
      const admission = await seededClient.send({
        message: {
          kind: 'signal',
          type: ASK_USER_ANSWER_SIGNAL_TYPE,
          tagName: ASK_USER_ANSWER_TAG,
          attributes: { toolCallId },
          body: JSON.stringify({ toolCallId, ...result }),
        },
        // Double-click / two-tab safe: replays converge on the one admission.
        idempotencyKey: `ask-user-question:${toolCallId}`,
      });
      setAnswersInFlight((prev) => new Map(prev).set(toolCallId, admission.submissionId));
    } catch (error) {
      setAnswersInFlight((prev) => {
        const next = new Map(prev);
        next.delete(toolCallId);
        return next;
      });
      setAnswerError(error instanceof Error ? error.message : String(error));
    }
  }

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
  // An unsettled question-answer send counts too (see answerInFlight above).
  const showBusy = busy || answerInFlight || (!!echo && messages.length === 0 && chatStatus !== 'error');

  // Everything an AskUserQuestion card needs to derive its state from history
  // and hand back an answer. Threaded through MessageView/PartView as plain
  // props (private same-file components — no memo barrier in between).
  const questionCtx = useMemo<QuestionCtx>(
    () => ({
      answers: questionAnswers,
      inFlight: answersInFlight,
      lastVisibleMessageId: messages.at(-1)?.id,
      busy: busy || answerInFlight,
      onAnswer: sendQuestionAnswer,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sendQuestionAnswer is stable in behavior
    [questionAnswers, answersInFlight, messages, busy, answerInFlight],
  );

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
      {/* Reaches the markdown link override (chatMarkdownComponents) through
          streamdown — props can't (MessageResponse's memo ignores them). */}
      <WorkspaceLinkContext.Provider value={linkCtx}>
      <div className={cn('mt-2 flex h-[60vh] flex-col overflow-hidden rounded-lg border bg-background text-foreground', className)}>
        <Conversation>
          <ConversationContent>
            {messages.length === 0 ? (
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
                  onHint={onHint}
                />
              ) : (
                <ConversationEmptyState
                  icon={<MessageSquareIcon className="size-10" />}
                  title="No messages yet"
                  description="Send a message to start the conversation."
                />
              )
            ) : (
              messages.map((message) => <MessageView key={message.id} message={message} questions={questionCtx} />)
            )}
          </ConversationContent>
          <ConversationScrollButton />
        </Conversation>

        <div className="border-t p-3">
          {/* The clicked prompt's tip, above the transient strips: it outlives
              them (it stays until dismissed, including once the welcome card
              itself is gone), so the moving parts stay nearest the input. */}
          {hint ? <HintTip onDismiss={onDismissHint}>{hint}</HintTip> : null}
          {/* Busy strip: visible for the whole run (submitted AND streaming), not
              just before the first token — during streaming the agent can spend
              long stretches in server-side tool calls with nothing new rendering,
              and the chat must not look idle while the stop icon shows. */}
          {showBusy ? (
            <div className="mb-2 flex items-center gap-2 text-muted-foreground text-sm">
              <Spinner /> Working…
            </div>
          ) : null}
          {uploadError ? <div className="mb-2 text-destructive text-sm">upload failed — {uploadError}</div> : null}
          {answerError ? <div className="mb-2 text-destructive text-sm">answer failed — {answerError}</div> : null}
          <PromptInput onSubmit={handleSubmit}>
            <PromptInputBody>
              <PromptInputTextarea
                value={input}
                placeholder={placeholder ?? 'Type a message…'}
                onChange={(event) => setInput(event.currentTarget.value)}
              />
            </PromptInputBody>
            <PromptInputFooter>
              <PromptInputTools>
                <WorkspaceUploadButton
                  auth={auth}
                  sessionId={sessionId}
                  onEnsureSession={onEnsureSession}
                  baseUrl={baseUrl}
                  // Requirement: the landed name goes into the composer with a
                  // leading AND trailing space, so it can be typed around.
                  onUploaded={(name) => setInput((prev) => `${prev} ${name} `)}
                  onError={setUploadError}
                />
              </PromptInputTools>
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
      </WorkspaceLinkContext.Provider>
    </TooltipProvider>
  );
}

/** What an AskUserQuestion card needs from the conversation. */
type QuestionCtx = {
  answers: ReadonlyMap<string, AskUserAnswerPayload>;
  /** toolCallIds whose answer send has not settled yet. */
  inFlight: ReadonlyMap<string, string | undefined>;
  lastVisibleMessageId?: string;
  busy: boolean;
  onAnswer: (toolCallId: string, result: { answers: Record<string, string>; cancelled: boolean }) => void;
};

/** Card state, derived from history alone (survives reloads and remounts):
 * answered beats everything; anything not on the LAST visible message is
 * stale (the user typed past it, or a newer response exists). */
function questionStatus(
  part: Extract<AgentPart, { type: 'dynamic-tool' }>,
  messageId: string,
  ctx: QuestionCtx,
): AskUserQuestionStatus {
  const answer = ctx.answers.get(part.toolCallId);
  if (answer) return { kind: 'answered', answer };
  if (part.state !== 'output-available' || messageId !== ctx.lastVisibleMessageId) return { kind: 'stale' };
  if (ctx.inFlight.has(part.toolCallId) || ctx.busy) return { kind: 'submitting' };
  return { kind: 'pending' };
}

function MessageView({ message, questions }: { message: AgentMessage; questions: QuestionCtx }) {
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
          <PartView key={index} part={part} messageId={message.id} questions={questions} />
        ))}
      </MessageContent>
    </Message>
  );
}

function PartView({ part, messageId, questions }: { part: AgentPart; messageId: string; questions: QuestionCtx }) {
  switch (part.type) {
    case 'text':
      // components: workspace download links + plain anchors (workspace-link.tsx).
      return <MessageResponse components={chatMarkdownComponents}>{part.text}</MessageResponse>;
    case 'dynamic-tool':
      // AskUserQuestion renders as an interactive card, not a collapsible tool
      // dump. A validation error (output-error) or an input the guard doesn't
      // recognize falls through to the generic card, so failures stay visible
      // in the familiar form.
      if (part.toolName === ASK_USER_TOOL_NAME && part.state !== 'output-error' && parseQuestions(part.input)) {
        return (
          <AskUserQuestionCard
            input={part.input}
            status={questionStatus(part, messageId, questions)}
            onSubmit={(result) => questions.onAnswer(part.toolCallId, result)}
          />
        );
      }
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
