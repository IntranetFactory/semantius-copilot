/**
 * The chat page (`/chat`) — the USER-facing half of the split UI.
 *
 * Authenticated by the user's own Semantius token (`<org>:<jwt>`, from
 * `pnpm mint-token`) and nothing else: no deployment API key is entered here,
 * loaded here, or accepted by the routes this page calls. A token buys exactly
 * two things, both enforced server-side:
 *
 *   New session   POST /sessions/:id/agent with the token as bearer. The
 *                 backend pins the verified user onto the session as its owner.
 *   Open session  paste a session id. The backend admits it only when that
 *                 session's owner IS the token's user — someone else's id is a
 *                 403, so ids are not a capability.
 *
 * Data browsing is not reachable from here at all: it lives on the admin
 * console behind the deployment key.
 *
 * The token can also arrive in the URL fragment (`/chat#jwt=<org>:<jwt>`,
 * optionally with `#session=<id>`), which is how a link — or the admin
 * console's "Open chat" — hands one over. The fragment never reaches the
 * server; it is consumed into localStorage and stripped from the address bar.
 */
import { useEffect, useMemo, useState } from 'react';

import { AgentChat } from './AgentChat';
import {
  AGENT_NAMES,
  AGENT_SEEDS,
  BACKEND,
  TOKEN_STORAGE,
  useConversationClient,
} from './lib/session';

/** `#jwt=…&session=…` — read once at mount, then wiped from the URL. */
function consumeFragment(): { jwt?: string; session?: string } {
  const raw = window.location.hash.replace(/^#/, '');
  if (!raw) return {};
  const params = new URLSearchParams(raw);
  const jwt = params.get('jwt') ?? undefined;
  const session = params.get('session') ?? undefined;
  if (jwt) {
    // Don't leave a credential sitting in the address bar. (It stays in browser
    // history for this entry either way — a link-borne token is a convenience
    // for POC/automation, not a way to keep one secret.)
    params.delete('jwt');
    const rest = params.toString();
    window.history.replaceState(null, '', `${window.location.pathname}${rest ? `#${rest}` : ''}`);
  }
  return { jwt, session };
}

export function ChatApp() {
  const fragment = useMemo(consumeFragment, []);
  const [token, setToken] = useState(() => fragment.jwt ?? localStorage.getItem(TOKEN_STORAGE) ?? '');
  const [agentName, setAgentName] = useState<string>(AGENT_NAMES[0] ?? '');
  const [sessionId, setSessionId] = useState<string>();
  const [sessionInput, setSessionInput] = useState(fragment.session ?? '');
  const [phase, setPhase] = useState<'idle' | 'preparing' | 'ready' | 'error'>('idle');
  const [detail, setDetail] = useState('');

  useEffect(() => {
    if (fragment.jwt) localStorage.setItem(TOKEN_STORAGE, fragment.jwt);
  }, [fragment.jwt]);

  function updateToken(value: string) {
    setToken(value);
    localStorage.setItem(TOKEN_STORAGE, value);
  }

  const trimmedToken = token.trim();
  const client = useConversationClient(trimmedToken, sessionId, AGENT_SEEDS[agentName]);

  async function newSession() {
    const id = crypto.randomUUID();
    setPhase('preparing');
    setSessionId(undefined);
    setDetail('provisioning session…');
    try {
      // Name-based: the definition must already be deployed to KV via
      // `pnpm deploy:agent <name>` — the route 404s otherwise. The token is the
      // bearer, so nothing credential- or tenant-shaped travels in the body:
      // the org and the user come from the token the backend verifies.
      const response = await fetch(`${BACKEND.baseUrl}/sessions/${id}/agent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${trimmedToken}` },
        body: JSON.stringify({ agentName }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(`${response.status}: ${payload?.error ?? JSON.stringify(payload)}`);
      setSessionId(id);
      setSessionInput(id); // surface the new id so it can be copied / re-opened
      setPhase('ready');
      setDetail(
        `${payload.user?.name ?? payload.user?.sub} <${payload.user?.email ?? '—'}> @${payload.user?.org} · ` +
          `agent ${payload.agentName}@${payload.version}`,
      );
    } catch (err) {
      setPhase('error');
      setDetail(String(err));
    }
  }

  /**
   * Re-attach to an existing conversation. Deliberately does NOT re-provision:
   * the conversation already lives in its agent Durable Object, and a bundle
   * snapshot is immutable per session id. Whether this id is yours to open is
   * the server's call — the first request either streams or comes back 403.
   */
  function openSession() {
    const id = sessionInput.trim();
    if (!id) return;
    setSessionId(id);
    setPhase('ready');
    setDetail('opened existing session (the backend rejects it unless it is yours)');
  }

  // Open the session a deep link named, once a token is present.
  useEffect(() => {
    if (fragment.session && trimmedToken && !sessionId) {
      setSessionId(fragment.session);
      setPhase('ready');
      setDetail(`opened ${fragment.session} from link`);
    }
  }, [fragment.session, trimmedToken, sessionId]);

  const trimmedInput = sessionInput.trim();

  return (
    <main>
      <header>
        <h1>Hoth Trip Planner</h1>
        <div className="controls">
          <textarea
            className="jwt"
            value={token}
            rows={2}
            placeholder={'your Semantius token — <org>:<jwt> (mint one with `pnpm mint-token`)'}
            spellCheck={false}
            onChange={(event) => updateToken(event.target.value)}
          />
        </div>
        {!trimmedToken ? <p className="status">Paste your Semantius token to begin.</p> : null}
      </header>

      <div className="controls">
        <select
          value={agentName}
          onChange={(event) => {
            setAgentName(event.target.value);
            setSessionId(undefined);
            setPhase('idle');
            setDetail('');
          }}
        >
          {AGENT_NAMES.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <button onClick={() => newSession()} disabled={phase === 'preparing' || !trimmedToken || !agentName}>
          {phase === 'preparing' ? 'Preparing…' : 'New session'}
        </button>
        {AGENT_NAMES.length === 0 ? <span className="status">no agents built — run `pnpm bundle`</span> : null}
      </div>

      <div className="controls">
        <input
          className="sessionid"
          value={sessionInput}
          placeholder="session id"
          spellCheck={false}
          onChange={(event) => setSessionInput(event.target.value)}
        />
        <button onClick={openSession} disabled={!trimmedInput || !trimmedToken}>
          Open session
        </button>
      </div>

      <p className={`status status-${phase}`}>
        {sessionId ? `session ${sessionId} · ` : ''}
        {detail || (trimmedToken ? 'Start a new session, or paste a session id and open it.' : '')}
      </p>

      {client && phase === 'ready' ? <AgentChat key={sessionId} client={client} /> : null}
    </main>
  );
}
