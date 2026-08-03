/**
 * The per-agent page (`/agent/<name>`) — the INPUT-FREE user surface: no
 * credential textarea, no agent dropdown, no session-id row. The agent is
 * named by the URL (the frontend Worker rewrites `/agent/<name>` to this
 * page's shell — see worker/index.ts), and the page is a thin shell over
 * AgentChatContainer, which owns everything else: the draft, session
 * creation, the conversation, and its own error/signed-out states. Whether
 * the name is a real deployed agent is the backend registry's call, rendered
 * in-page by the container.
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
import { useEffect, useMemo } from 'react';

import { AgentChatContainer } from './components/ai-elements/agent-chat-container';
import { agentNameFromPath, consumeCredentialFragment, COOKIE_STORAGE, TOKEN_STORAGE } from './pages';

export function AgentApp() {
  const agentName = useMemo(() => agentNameFromPath(window.location.pathname), []);
  const fragment = useMemo(() => consumeCredentialFragment(), []);
  // A link-borne credential wins and is persisted for next time; otherwise
  // fall back to what this browser already holds — the cookie before the
  // token, because the cookie is this page's primary credential and the jwt a
  // testing convenience shared with /chat. Neither present = ambient mode.
  const { bearer, authCookie } = useMemo(() => {
    if (fragment.jwt) localStorage.setItem(TOKEN_STORAGE, fragment.jwt);
    if (fragment.cookie) localStorage.setItem(COOKIE_STORAGE, fragment.cookie);
    if (fragment.jwt) return { bearer: fragment.jwt.trim(), authCookie: undefined };
    if (fragment.cookie) return { bearer: undefined, authCookie: fragment.cookie.trim() };
    const stored = localStorage.getItem(COOKIE_STORAGE)?.trim();
    if (stored) return { bearer: undefined, authCookie: stored };
    const jwt = localStorage.getItem(TOKEN_STORAGE)?.trim();
    if (jwt) return { bearer: jwt, authCookie: undefined };
    return { bearer: undefined, authCookie: undefined };
  }, [fragment]);

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

  return (
    <main>
      <AgentChatContainer
        agentName={agentName}
        bearer={bearer}
        authCookie={authCookie}
        sessionId={fragment.session}
      />
    </main>
  );
}
