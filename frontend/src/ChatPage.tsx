/**
 * The user-facing chat page CHROME, shared by `/chat` (ChatApp) and `/copilot`
 * (CopilotApp): page title, the credential textarea, the agent dropdown, the
 * session-id row, and the status line. The two pages are the same surface —
 * they differ ONLY in which credential they collect, which is a prop here so
 * the pages cannot drift apart.
 *
 * Everything below the chrome — the draft, session creation, the key-flip
 * handoff, the conversation — is AgentChatContainer
 * (components/ai-elements/agent-chat-container.tsx). This page only decides
 * WHICH container instance exists, via the container's key contract:
 *
 *   key = `${agentName}:${explicitSessionId ?? 'draft'}:${epoch}`
 *
 * `explicitSessionId` is ONLY an id the user navigated to (the "Open session"
 * button, or a `#session=` deep link — consumed once by construction, since
 * it merely initializes the state). The id a DRAFT create mints is reported
 * back through `onSessionCreated` and feeds the status line and the id input
 * — NEVER the key, which would remount the container mid-handoff and race the
 * first message. `epoch` bumps on every navigation ("New session", "Open
 * session", agent switch), forcing a fresh container.
 *
 * There is NO build-time agent knowledge anywhere on this surface: the
 * dropdown lists what `GET /agents` answers (the backend KV registry), and
 * everything an agent IS — welcome card, turn-1 seed — is loaded by the
 * container itself. Deploying an agent needs no frontend rebuild.
 *
 * Data browsing is not reachable from any user page: it lives on the admin
 * console behind the deployment key.
 */
import { useEffect, useState } from 'react';

import { AgentChatContainer } from './components/ai-elements/agent-chat-container';
import {
  fetchAgentNames,
  hasCredential,
  type ChatAuth,
  type SessionCreateInfo,
} from './components/ai-elements/session';

export type ChatPageProps = {
  /** Page heading. */
  title: string;
  /** The credential this page authenticates with, already trimmed. */
  auth: ChatAuth;
  /** The credential textarea — owned by the page, since only it knows where the
   * value is persisted. */
  credential?: {
    value: string;
    onChange: (value: string) => void;
    placeholder: string;
    /** Shown while the box is empty. */
    prompt: string;
  };
  /** Session id from a deep link, opened once a credential is present. */
  initialSessionId?: string;
};

export function ChatPage({ title, auth, credential, initialSessionId }: ChatPageProps) {
  /** The dropdown's list — the RUNTIME registry (GET /agents), fetched once a
   * credential is present. undefined = not fetched yet. */
  const [agentNames, setAgentNames] = useState<string[]>();
  const [selectedAgent, setSelectedAgent] = useState('');
  /** Only Open-session / deep-link ids — see the key contract above. */
  const [explicitSessionId, setExplicitSessionId] = useState(initialSessionId);
  /** Bumped by every navigation, so the container remounts fresh. */
  const [epoch, setEpoch] = useState(0);
  const [sessionInput, setSessionInput] = useState(initialSessionId ?? '');
  /** The id the status line names: explicit navigation or a reported create. */
  const [displayId, setDisplayId] = useState(initialSessionId);
  const [detail, setDetail] = useState(initialSessionId ? `opened ${initialSessionId} from link` : '');

  const authenticated = hasCredential(auth);

  // Destructured to primitives for the effect below — `auth` is a fresh object
  // literal on every render. (These pages always pass an explicit credential,
  // never ambient.)
  const bearer = 'bearer' in auth ? auth.bearer : '';
  const authCookie = 'authCookie' in auth ? auth.authCookie : '';
  useEffect(() => {
    if (!(bearer || authCookie)) return;
    let cancelled = false;
    fetchAgentNames(bearer ? { bearer } : { authCookie }).then(
      (names) => {
        if (cancelled) return;
        setAgentNames(names);
        setSelectedAgent((prev) => (prev && names.includes(prev) ? prev : (names[0] ?? '')));
      },
      (err) => {
        if (cancelled) return;
        setAgentNames([]);
        setDetail(`could not list agents — ${String(err)}`);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [bearer, authCookie]);

  /** A fresh draft for the current agent. Zero-cost: the container provisions
   * nothing until the first message is sent. */
  function newSession() {
    setEpoch((n) => n + 1);
    setExplicitSessionId(undefined);
    setDisplayId(undefined);
    setDetail('new session — it will be created when you send your first message');
  }

  /** Re-attach to an existing conversation. Whether this id is yours to open
   * is the server's call — the first request either streams or answers 403. */
  function openSession() {
    const id = sessionInput.trim();
    if (!id) return;
    setEpoch((n) => n + 1);
    setExplicitSessionId(id);
    setDisplayId(id);
    setDetail('opened existing session (the backend rejects it unless it is yours)');
  }

  function switchAgent(name: string) {
    setSelectedAgent(name);
    setEpoch((n) => n + 1);
    setExplicitSessionId(undefined);
    setDisplayId(undefined);
    setDetail('');
  }

  /** The draft create reporting back — status line + id input only, never the
   * container key (see the key contract in the header). */
  function onSessionCreated(id: string, info: SessionCreateInfo) {
    setDisplayId(id);
    setSessionInput(id); // surface the new id so it can be copied / re-opened
    setDetail(
      `${info.user?.name ?? info.user?.sub} <${info.user?.email ?? '—'}> @${info.user?.org} · ` +
        `agent ${info.agentName}@${info.version}`,
    );
  }

  const trimmedInput = sessionInput.trim();

  return (
    <main>
      <header>
        <h1>{title}</h1>
        {credential ? (
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
        ) : null}
        {!authenticated ? <p className="status">{credential?.prompt}</p> : null}
      </header>

      <div className="controls">
        <select value={selectedAgent} onChange={(event) => switchAgent(event.target.value)}>
          {(agentNames ?? []).map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <button onClick={newSession} disabled={!authenticated || !selectedAgent}>
          New session
        </button>
        {authenticated && agentNames?.length === 0 ? (
          <span className="status">no agents deployed — `pnpm deploy:agent &lt;name&gt;`</span>
        ) : null}
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

      <p className="status">
        {displayId ? `session ${displayId} · ` : ''}
        {detail ||
          (authenticated ? 'A new session is created when you send your first message. Or paste a session id and open it.' : '')}
      </p>

      {authenticated && selectedAgent ? (
        <AgentChatContainer
          key={`${selectedAgent}:${explicitSessionId ?? 'draft'}:${epoch}`}
          agentName={selectedAgent}
          bearer={bearer || undefined}
          authCookie={authCookie || undefined}
          sessionId={explicitSessionId}
          onSessionCreated={onSessionCreated}
          onError={(err) => setDetail(`session create failed — ${String(err)}`)}
        />
      ) : null}
    </main>
  );
}
