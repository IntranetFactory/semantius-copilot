/**
 * The user-facing chat workbench, shared by both user pages.
 *
 * `/chat` (ChatApp) and `/copilot` (CopilotApp) are the same surface — paste a
 * credential, start a session or open one by id, talk to the agent — differing
 * ONLY in which credential they collect. That difference is a prop here rather
 * than a second copy of this file, so the two pages cannot drift apart:
 *
 *   /chat     a Semantius token (`<org>:<jwt>`, from `pnpm mint-token`), sent
 *             as `Authorization: Bearer`.
 *   /copilot  a better-auth session cookie value, sent in the
 *             `x-better-auth-cookie` header (see ChatAuth in lib/session.ts).
 *
 * The backend's chat gate resolves both to the same verified user, so
 * everything below this line is credential-blind. A credential buys exactly two
 * things, both enforced server-side:
 *
 *   New session   POST /sessions/agent. The backend mints the session id from
 *                 the identity it verified and pins that user onto the session
 *                 as its owner.
 *   Open session  paste a session id. The backend admits it only when that
 *                 session's owner IS the caller — someone else's id is a 403,
 *                 so ids are not a capability.
 *
 * Data browsing is not reachable from either page: it lives on the admin
 * console behind the deployment key.
 */
import { useEffect, useState } from 'react';

import { AgentChat } from './AgentChat';
import {
  AGENT_NAMES,
  AGENT_SEEDS,
  AGENTS,
  authHeaders,
  BACKEND,
  hasCredential,
  useConversationClient,
  type ChatAuth,
} from './lib/session';

export type ChatWorkbenchProps = {
  /** Page heading. */
  title: string;
  /** The credential this page authenticates with, already trimmed. */
  auth: ChatAuth;
  /** The credential textarea — owned by the page, since only it knows where the value is persisted. */
  credential: {
    value: string;
    onChange: (value: string) => void;
    placeholder: string;
    /** Shown while the box is empty. */
    prompt: string;
  };
  /** Session id from a deep link, opened once a credential is present. */
  initialSessionId?: string;
};

export function ChatWorkbench({ title, auth, credential, initialSessionId }: ChatWorkbenchProps) {
  const [agentName, setAgentName] = useState<string>(AGENT_NAMES[0] ?? '');
  const [sessionId, setSessionId] = useState<string>();
  const [sessionInput, setSessionInput] = useState(initialSessionId ?? '');
  const [phase, setPhase] = useState<'idle' | 'preparing' | 'ready' | 'error'>('idle');
  const [detail, setDetail] = useState('');

  const authenticated = hasCredential(auth);
  const client = useConversationClient(auth, sessionId, AGENT_SEEDS[agentName]);

  async function newSession() {
    setPhase('preparing');
    setSessionId(undefined);
    setDetail('provisioning session…');
    try {
      // Name-based: the definition must already be deployed to KV via
      // `pnpm deploy:agent <name>` — the route 404s otherwise. The credential
      // travels in the headers, so nothing credential- or tenant-shaped goes in
      // the body: the org and the user come from what the backend verifies.
      //
      // The SESSION ID comes back from the server. This page does not generate
      // one: the id carries the tenant (`<org>-<sub>-<random>`), and an id a
      // browser picked would let a client stamp any tenant it liked on its own
      // KV keys.
      const response = await fetch(`${BACKEND.baseUrl}/sessions/agent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders(auth) },
        body: JSON.stringify({ agentName }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(`${response.status}: ${payload?.error ?? JSON.stringify(payload)}`);
      const id = payload?.sessionId;
      if (typeof id !== 'string' || !id) throw new Error(`session create returned no sessionId: ${JSON.stringify(payload)}`);
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

  // Open the session a deep link named, once a credential is present.
  useEffect(() => {
    if (initialSessionId && authenticated && !sessionId) {
      setSessionId(initialSessionId);
      setPhase('ready');
      setDetail(`opened ${initialSessionId} from link`);
    }
  }, [initialSessionId, authenticated, sessionId]);

  const trimmedInput = sessionInput.trim();

  return (
    <main>
      <header>
        <h1>{title}</h1>
        <div className="controls">
          <textarea
            className="jwt"
            value={credential.value}
            rows={2}
            placeholder={credential.placeholder}
            spellCheck={false}
            onChange={(event) => credential.onChange(event.target.value)}
          />
        </div>
        {!authenticated ? <p className="status">{credential.prompt}</p> : null}
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
        <button onClick={() => newSession()} disabled={phase === 'preparing' || !authenticated || !agentName}>
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
        <button onClick={openSession} disabled={!trimmedInput || !authenticated}>
          Open session
        </button>
      </div>

      <p className={`status status-${phase}`}>
        {sessionId ? `session ${sessionId} · ` : ''}
        {detail || (authenticated ? 'Start a new session, or paste a session id and open it.' : '')}
      </p>

      {client && phase === 'ready' ? (
        <AgentChat key={sessionId} client={client} welcome={AGENTS[agentName]?.welcome} />
      ) : null}
    </main>
  );
}
