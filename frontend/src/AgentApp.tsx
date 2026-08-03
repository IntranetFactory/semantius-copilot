/**
 * The per-agent page (`/agent/<name>`) — the INPUT-FREE user surface: no
 * credential textarea, no agent dropdown, no session-id row. The agent is
 * named by the URL (the frontend Worker rewrites `/agent/<name>` to this
 * page's shell — see worker/index.ts), and the page is a shell over
 * AgentChatContainer, which owns the draft, session creation, the
 * conversation, and its own error/signed-out states. Whether the name is a
 * real deployed agent is the backend registry's call, rendered in-page by the
 * container.
 *
 * Beside the chat, the page owns the SESSION SIDEBAR (SessionSidebar): "New
 * request" plus the user's sessions for this agent (`GET /sessions`, narrowed
 * client-side). Navigation follows ChatPage.tsx's container key contract:
 *
 *   key = `${agentName}:${explicitSessionId ?? 'draft'}:${epoch}`
 *
 * `explicitSessionId` is ONLY an id the user navigated to (a sidebar click,
 * or a `#session=` deep link); the id a DRAFT create mints is reported back
 * through `onSessionCreated` and feeds the sidebar highlight + refresh —
 * NEVER the key, which would remount the container mid-handoff and race the
 * first message. `epoch` bumps on every navigation, forcing a fresh container.
 *
 * Credentials, in precedence order (the fragment forms exist for testing and
 * link-handovers; both are consumed and stripped from the address bar):
 *   #jwt=<org>:<jwt>  Semantius token (`pnpm mint-token`) — sent as a bearer
 *   #cookie=<value>   better-auth session cookie value — the custom header
 *   then whatever this browser already stored: the cookie before the token.
 *   NOTHING AT ALL    ambient mode — the container sends every request with
 *                     `credentials: 'include'`, so a browser already signed
 *                     in to a same-site backend needs no handover at all; a
 *                     401 renders as the container's signed-out notice.
 */
import { useEffect, useMemo, useState } from 'react';

import { AgentChatContainer } from './components/ai-elements/agent-chat-container';
import { SessionSidebar } from './components/ai-elements/session-sidebar';
import { agentNameFromPath, consumeCredentialFragment, COOKIE_STORAGE, TOKEN_STORAGE } from './pages';

export function AgentApp() {
  const agentName = useMemo(() => agentNameFromPath(window.location.pathname), []);
  const fragment = useMemo(() => consumeCredentialFragment(), []);
  // A link-borne credential wins, is persisted for next time, and EVICTS the
  // competing stored credential: a fragment handover says "be this user in
  // this browser", and leaving the other credential behind made every later
  // plain reload silently flip back to it (the stored cookie outranks the
  // stored jwt below) — the page then chats and lists sessions as a DIFFERENT
  // identity with no visible sign. Without a fragment, fall back to what this
  // browser holds — the cookie before the jwt, because the cookie is this
  // page's primary credential and the jwt a testing convenience shared with
  // /chat. Neither present = ambient mode.
  const { bearer, authCookie } = useMemo(() => {
    if (fragment.jwt) {
      localStorage.setItem(TOKEN_STORAGE, fragment.jwt);
      localStorage.removeItem(COOKIE_STORAGE);
      return { bearer: fragment.jwt.trim(), authCookie: undefined };
    }
    if (fragment.cookie) {
      localStorage.setItem(COOKIE_STORAGE, fragment.cookie);
      localStorage.removeItem(TOKEN_STORAGE);
      return { bearer: undefined, authCookie: fragment.cookie.trim() };
    }
    const stored = localStorage.getItem(COOKIE_STORAGE)?.trim();
    if (stored) return { bearer: undefined, authCookie: stored };
    const jwt = localStorage.getItem(TOKEN_STORAGE)?.trim();
    if (jwt) return { bearer: jwt, authCookie: undefined };
    return { bearer: undefined, authCookie: undefined };
  }, [fragment]);

  // Navigation state per the key contract in the header. `fragment` is
  // memoized once, so a `#session=` deep link seeds the initial state and is
  // then owned by the sidebar's navigation.
  const [explicitSessionId, setExplicitSessionId] = useState<string | undefined>(fragment.session);
  const [epoch, setEpoch] = useState(0);
  /** Sidebar highlight only — explicit navigation OR the reported draft
   * create. NEVER fed into the container key (see the header). */
  const [activeSessionId, setActiveSessionId] = useState<string | undefined>(fragment.session);
  const [sessionsRefresh, setSessionsRefresh] = useState(0);

  /** A fresh draft. Zero-cost: nothing is provisioned until the first send. */
  function newRequest() {
    setEpoch((n) => n + 1);
    setExplicitSessionId(undefined);
    setActiveSessionId(undefined);
  }

  /** Re-attach to a listed session. Whether it opens is the server's call. */
  function openSession(id: string) {
    setEpoch((n) => n + 1);
    setExplicitSessionId(id);
    setActiveSessionId(id);
  }

  /** The draft create reporting back — highlight it and refetch the list. */
  function onSessionCreated(id: string) {
    setActiveSessionId(id);
    setSessionsRefresh((n) => n + 1);
  }

  useEffect(() => {
    if (agentName) document.title = agentName;
  }, [agentName]);

  // A direct hit on the shell asset (or a mangled path): no name to work with.
  if (!agentName) {
    return (
      <main>
        <header>
          <h1>Agent</h1>
        </header>
        <p className="status status-error">This page needs an agent name in its URL — /agent/&lt;name&gt;.</p>
      </main>
    );
  }

  // This page IS the chat, so it fills the viewport as a flex ROW: sidebar
  // beside chat. The root must not be <main> — the unlayered legacy rule
  // `main { max-width: 960px; margin: 0 auto; padding: 1.5rem }` (style.css)
  // beats Tailwind utilities and would cap the whole shell. The chat column
  // stays a NESTED <main> on purpose: inside the row, that same rule keeps
  // centering it (auto margins absorb the free flex space, flex-1 grows it up
  // to the 960px cap) exactly as before the sidebar existed. The frame trades
  // its h-[60vh] default for flex-1 (min-h-0 lets the conversation scroll
  // instead of growing the page).
  return (
    <div className="flex h-dvh overflow-hidden">
      {/* Fixed-width sidebar on the sidebar design tokens (index.css); hidden
         on narrow viewports so the chat keeps working full-width on mobile. */}
      <aside className="hidden w-64 shrink-0 border-r border-sidebar-border bg-sidebar text-sidebar-foreground md:flex md:flex-col">
        <SessionSidebar
          agentName={agentName}
          bearer={bearer}
          authCookie={authCookie}
          activeSessionId={activeSessionId}
          refreshToken={sessionsRefresh}
          onNewRequest={newRequest}
          onOpenSession={openSession}
        />
      </aside>
      <main className="flex min-w-0 flex-1 flex-col">
        <AgentChatContainer
          key={`${agentName}:${explicitSessionId ?? 'draft'}:${epoch}`}
          agentName={agentName}
          bearer={bearer}
          authCookie={authCookie}
          sessionId={explicitSessionId}
          onSessionCreated={onSessionCreated}
          className="h-auto min-h-0 flex-1"
        />
      </main>
    </div>
  );
}
