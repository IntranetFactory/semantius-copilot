/**
 * The reusable entry point of the chat surface: one deployed agent, one
 * conversation, session lifecycle included. Drop this component into any app
 * — the whole `components/ai-elements/` folder (plus the shadcn `ui/` folder,
 * `lib/utils.ts`, and the theme CSS) is copyable as-is; nothing in it knows
 * hoth's pages.
 *
 * Backend contract (any backend-b-shaped Worker, addressed via `baseUrl`):
 *   GET  /agents/:name/meta      welcome card + turn-1 seed
 *   POST /sessions/agent         create a session (server mints the id)
 *   /agents/main/:sessionId      the conversation (flue v2 + SSE)
 *
 * Auth: pass `bearer` (Semantius token) OR `authCookie` (better-auth session
 * cookie value) — or NEITHER, which is AMBIENT mode: every request goes out
 * with `credentials: 'include'` and the browser attaches its own better-auth
 * cookie. Ambient requires the backend to be same-site with the page (a
 * `workers.dev` backend is cross-site to everything — it needs a custom
 * domain under the app's zone, and the cookie needs `Domain=.<zone>`) and the
 * page's origin to be in the backend's ALLOWED_ORIGINS. A missing/invalid
 * browser session answers 401, rendered here as a signed-out notice.
 *
 * Session lifecycle: without `sessionId` the container mounts as a zero-cost
 * DRAFT — no request, nothing provisioned. The first submit creates the
 * session (`POST /sessions/agent`), the internal key flip remounts AgentChat
 * live, and the message is delivered exactly once. With `sessionId`, the
 * container attaches to that existing conversation instead (whether it is
 * yours to open is the server's call — a stranger's id answers 403).
 *
 * KEY CONTRACT for hosts: `agentName` and `sessionId` are fixed for the life
 * of one instance — to navigate (new draft, open another session, switch
 * agents), change the container's `key`. `onSessionCreated` reports the
 * server-minted id for display/deep-linking; feeding it back into `key` or
 * `sessionId` would remount mid-handoff and race the first message.
 */
import { useEffect, useMemo, useRef, useState } from 'react';

import { AgentChat } from './agent-chat';
import {
  BACKEND,
  conversationUrl,
  createAgentSession,
  useAgentMeta,
  useConversationClient,
  type ChatAuth,
  type SessionCreateInfo,
} from './session';

/** Deliberately generic — the container cannot know where the host app's
 * sign-in lives. Hosts wanting custom copy gate on their own auth state
 * before rendering the container. */
const SIGNED_OUT_NOTICE = 'No active session. Sign in to this app, then reload the page.';

export function AgentChatContainer({
  agentName,
  bearer,
  authCookie,
  baseUrl = BACKEND.baseUrl,
  sessionId,
  onSessionCreated,
  onResponseSettled,
  onError,
  className,
  placeholder,
}: {
  /** WHICH deployed agent to talk to (`pnpm deploy:agent <name>`). */
  agentName: string;
  /** Semantius token (`<org>:<jwt>`) — wins over authCookie server-side. */
  bearer?: string;
  /** better-auth session cookie VALUE. Both empty ⇒ ambient mode (see header). */
  authCookie?: string;
  /** Backend origin. Defaults to the build-time env default (session.ts BACKEND). */
  baseUrl?: string;
  /** Attach to this existing session instead of starting a draft. Fixed per
   * instance — change the `key` to open a different one. */
  sessionId?: string;
  /** The server-minted id of the session the first submit created — for the
   * host's status line / deep links only, never for the container's key. */
  onSessionCreated?: (sessionId: string, info: SessionCreateInfo) => void;
  /** Fires once each time a run settles (busy → idle) — e.g. to refresh a
   * session list whose server-side metadata (generated title) trails the
   * response. */
  onResponseSettled?: () => void;
  /** Session-create failure. The container also renders the error inline, so
   * wiring this is optional. */
  onError?: (error: unknown) => void;
  /** Merged into the conversation frame (e.g. to override the default height). */
  className?: string;
  /** Composer placeholder text. */
  placeholder?: string;
}) {
  const auth = useMemo<ChatAuth>(() => {
    const b = bearer?.trim();
    if (b) return { bearer: b };
    const c = authCookie?.trim();
    if (c) return { authCookie: c };
    return { ambient: true };
  }, [bearer, authCookie]);

  // The id the draft create produced. `sessionId` (the explicit prop) wins;
  // per the key contract it never changes within one instance.
  const [createdId, setCreatedId] = useState<string>();
  const liveId = sessionId ?? createdId;
  /** The draft submit that triggered the create — delivered by AgentChat
   * exactly once after the live key-flip mount. */
  const [pendingMessage, setPendingMessage] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string>();
  // Unmount guard: an in-flight create resolving after unmount must not fire
  // the host callbacks — setState-on-unmounted is a no-op, a prop callback is
  // not, and a stale create would stomp the host's status with an orphan id.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // Meta is loaded (and cached) here as well as inside AgentChat — same
  // module cache, one request — because the 401-vs-404 split is the
  // container's call: 401 in ambient mode means "no browser session".
  const { metaStatus } = useAgentMeta(auth, agentName, baseUrl);
  const urlFor = useMemo(() => (id: string) => conversationUrl(id, baseUrl), [baseUrl]);
  const client = useConversationClient(auth, liveId, urlFor);

  async function createAndSend(text: string) {
    if (creating) return; // belt; braces = AgentChat locks the composer
    setCreating(true);
    setCreateError(undefined);
    try {
      const info = await createAgentSession(auth, agentName, baseUrl);
      if (!alive.current) return;
      setPendingMessage(text);
      setCreatedId(info.sessionId);
      onSessionCreated?.(info.sessionId, info);
    } catch (err) {
      if (alive.current) {
        setCreateError(String(err));
        onError?.(err);
      }
      throw err; // AgentChat's catch restores the typed text
    } finally {
      if (alive.current) setCreating(false);
    }
  }

  if ('ambient' in auth && metaStatus === 401) {
    return (
      <div className="mt-2 rounded-lg border bg-background p-6 text-foreground">
        <p className="text-muted-foreground text-sm">{SIGNED_OUT_NOTICE}</p>
      </div>
    );
  }

  return (
    <>
      {createError ? (
        <div className="mt-2 rounded-lg border border-destructive/50 bg-background p-3 text-sm text-foreground">
          session create failed — {createError}
        </div>
      ) : null}
      <AgentChat
        // The 'draft' → <sessionId> key flip carries the handoff: the dormant
        // draft instance unmounts, the live one mounts and sends
        // pendingMessage exactly once.
        key={liveId ?? 'draft'}
        client={liveId ? client : undefined}
        auth={auth}
        agentName={agentName}
        baseUrl={baseUrl}
        initialMessage={pendingMessage}
        onDraftSend={createAndSend}
        draftPending={creating}
        onResponseSettled={onResponseSettled}
        className={className}
        placeholder={placeholder}
      />
    </>
  );
}
