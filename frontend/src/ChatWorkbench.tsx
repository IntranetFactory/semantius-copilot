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
 *   New session   opens a zero-cost DRAFT: no request is made and nothing is
 *                 provisioned. The first message the user sends fires
 *                 POST /sessions/agent — the backend mints the session id from
 *                 the identity it verified and pins that user onto the session
 *                 as its owner — and the message is then delivered to the new
 *                 session. A draft that never sends costs nothing anywhere.
 *   Open session  paste a session id. The backend admits it only when that
 *                 session's owner IS the caller — someone else's id is a 403,
 *                 so ids are not a capability.
 *
 * Data browsing is not reachable from either page: it lives on the admin
 * console behind the deployment key.
 */
import { useEffect, useRef, useState } from 'react';

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
  const [phase, setPhase] = useState<'idle' | 'draft' | 'preparing' | 'ready' | 'error'>('idle');
  const [detail, setDetail] = useState('');
  /** The draft submit that triggered session creation — delivered by AgentChat
   * exactly once after the live mount. Cleared by every other navigation. */
  const [pendingMessage, setPendingMessage] = useState<string>();
  /** Bumped by every navigation away from a draft (new draft, open, deep link,
   * agent switch) so a create still in flight cannot stomp the new state. */
  const createGen = useRef(0);
  /** A deep-linked session id opens exactly once — never over a draft. */
  const deepLinkConsumed = useRef(false);

  const authenticated = hasCredential(auth);
  const client = useConversationClient(auth, sessionId, AGENT_SEEDS[agentName]);

  /** Zero-cost: no request, nothing provisioned. The session is created by the
   * first message (createSessionAndSend), so an untouched draft costs nothing. */
  function startDraft() {
    createGen.current++;
    setSessionId(undefined);
    setPendingMessage(undefined);
    setPhase('draft');
    setDetail('new session — it will be created when you send your first message');
  }

  async function createSessionAndSend(text: string) {
    if (phase === 'preparing') return; // belt; braces = AgentChat locks the composer
    const gen = createGen.current;
    setPhase('preparing');
    setDetail('creating session…');
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
      if (gen !== createGen.current) return; // user navigated away mid-create — drop the result
      setPendingMessage(text);
      setSessionId(id);
      setSessionInput(id); // surface the new id so it can be copied / re-opened
      setPhase('ready');
      setDetail(
        `${payload.user?.name ?? payload.user?.sub} <${payload.user?.email ?? '—'}> @${payload.user?.org} · ` +
          `agent ${payload.agentName}@${payload.version}`,
      );
    } catch (err) {
      if (gen === createGen.current) {
        setPhase('draft');
        setDetail(`session create failed — ${String(err)}`);
      }
      throw err; // AgentChat's catch restores the typed text
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
    createGen.current++;
    setPendingMessage(undefined);
    setSessionId(id);
    setPhase('ready');
    setDetail('opened existing session (the backend rejects it unless it is yours)');
  }

  // Open the session a deep link named, once a credential is present. Exactly
  // once: without the guard this would re-fire whenever sessionId goes back to
  // undefined (e.g. "New session") and stomp the draft.
  useEffect(() => {
    if (initialSessionId && authenticated && phase === 'idle' && !deepLinkConsumed.current) {
      deepLinkConsumed.current = true;
      createGen.current++;
      setPendingMessage(undefined);
      setSessionId(initialSessionId);
      setPhase('ready');
      setDetail(`opened ${initialSessionId} from link`);
    }
  }, [initialSessionId, authenticated, phase]);

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
            createGen.current++; // a create in flight for the old agent is dropped
            setSessionId(undefined);
            setPendingMessage(undefined);
            if (phase === 'draft' || phase === 'preparing') {
              // Stay in the draft: the welcome card swaps, typed text survives
              // (the 'draft'-keyed AgentChat is not remounted).
              setPhase('draft');
              setDetail('new session — it will be created when you send your first message');
            } else {
              setPhase('idle');
              setDetail('');
            }
          }}
        >
          {AGENT_NAMES.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <button onClick={() => startDraft()} disabled={phase === 'preparing' || !authenticated || !agentName}>
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

      {phase === 'draft' || phase === 'preparing' || (phase === 'ready' && client) ? (
        <AgentChat
          // The 'draft' → <sessionId> key flip carries the handoff: the dormant
          // draft instance unmounts, the live one mounts and sends
          // initialMessage exactly once.
          key={sessionId ?? 'draft'}
          client={phase === 'ready' ? client : undefined}
          welcome={AGENTS[agentName]?.welcome}
          initialMessage={pendingMessage}
          onDraftSend={createSessionAndSend}
          draftPending={phase === 'preparing'}
        />
      ) : null}
    </main>
  );
}
