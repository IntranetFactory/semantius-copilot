/**
 * Hoth POC UI (plan §10): a chat with an A/B backend dropdown, plus a
 * read-only Data browser over everything the backends persist in Cloudflare.
 *
 * Chat: Flue v2 clients are conversation-scoped — one createFlueClient per
 * conversation URL (`<backend>/agents/<mount>/<sessionId>`; mount is `hoth`
 * on A, `main` on B), passed to useFlueAgent({ client }). New session mints a
 * lowercase UUID; for B, pick an agent and POST just its NAME ({ agentName })
 * — the definition itself lives in KV, deployed via `pnpm deploy:agent
 * <name>` — and await the 2xx before opening the chat (seeds the bearer
 * mapping and pre-warms the container); for A, POST the provision route (A is
 * fixed to the image-baked hoth-trip-planner agent, so it has no agent
 * selector). The agent list and the turn-1 seed are the bundler output:
 * `pnpm bundle` emits one JSON per agents/<name>/ into src/generated/agents/,
 * glob-imported below — a new agent folder appears here with no code change
 * (deploy it with `pnpm deploy:agent` or sessions for it will 404).
 *
 * Data browser: a generic collection → record → detail tree with breadcrumbs.
 * Each backend exposes its stores as "collections" via /admin/collections:
 *   - kv        — the raw KV namespace (named agent definitions, per-session
 *                 bundle snapshots, bearers, tags, session index)
 *   - sessions  — one record per conversation id (from the session index); the
 *                 detail streams the live conversation held in the Flue agent
 *                 Durable Object (its SQLite conversation stream)
 * (The beta `runs` collection is gone — Flue v2 removed the workflow-run
 * registry.) No id is needed upfront — every level is enumerated from the
 * server.
 */
import { useFlueAgent } from '@flue/react';
import { createFlueClient } from '@flue/sdk';
import { skillCatalogFromBundle } from '@hoth/core';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { AgentChat } from './AgentChat';

type AgentBundle = {
  agentName: string;
  version: string;
  baseImage: string;
  instructions: string;
  model?: string;
  modelBaseUrl?: string;
  proxyWhitelist?: string[];
  skills: Record<string, Record<string, string>>;
};

// Every agents/<name>/ folder the bundler built — eager glob import, so a new
// agent is picked up by re-running `pnpm bundle`, with no code change here.
const agentModules = import.meta.glob('./generated/agents/*.json', {
  eager: true,
  import: 'default',
}) as Record<string, AgentBundle>;
const AGENTS: Record<string, AgentBundle> = Object.fromEntries(
  Object.values(agentModules).map((bundle) => [bundle.agentName, bundle]),
);
const AGENT_NAMES = Object.keys(AGENTS).sort();

/**
 * Instance-creation seed for backend B conversations: the bundle meta minus
 * the skill files. Sent as `initialData` with EVERY send (Flue consults it
 * only on the send that creates the instance, ignores it afterwards), so the
 * agent's very first model turn already runs with the right instructions and
 * model — state written in useAgentStart only lands after turn 1.
 */
type AgentSeed = {
  agentName: string;
  version: string;
  baseImage: string;
  instructions: string;
  model?: string;
  modelBaseUrl?: string;
  /** Explicit skill catalog (name + description) so turn 1 mounts skills via useSkill(). */
  skillCatalog?: Array<{ name: string; description: string }>;
};
const AGENT_SEEDS: Record<string, AgentSeed> = Object.fromEntries(
  Object.values(AGENTS).map((b) => {
    const skillCatalog = skillCatalogFromBundle(b);
    return [
      b.agentName,
      {
        agentName: b.agentName,
        version: b.version,
        baseImage: b.baseImage,
        instructions: b.instructions,
        ...(b.model ? { model: b.model } : {}),
        ...(b.modelBaseUrl ? { modelBaseUrl: b.modelBaseUrl } : {}),
        ...(skillCatalog.length > 0 ? { skillCatalog } : {}),
      },
    ];
  }),
);

const BACKENDS = {
  a: {
    label: 'Backend A — image-baked skills (OOTB)',
    baseUrl: import.meta.env.VITE_BACKEND_A_URL ?? 'http://localhost:3583',
    agentMount: 'hoth',
  },
  b: {
    label: 'Backend B — dynamic bundle (multi-agent)',
    baseUrl: import.meta.env.VITE_BACKEND_B_URL ?? 'http://localhost:3584',
    agentMount: 'main',
  },
} as const;

type BackendKey = keyof typeof BACKENDS;
type View = 'chat' | 'data' | 'chats';

const API_KEY_STORAGE = 'hoth-api-key';

/** The one conversation URL a v2 FlueClient addresses (mount + session id). */
const conversationUrl = (backend: BackendKey, sessionId: string) =>
  `${BACKENDS[backend].baseUrl}/agents/${BACKENDS[backend].agentMount}/${encodeURIComponent(sessionId)}`;

/**
 * Conversation-scoped client (v2: no deployment-wide client, no name/id).
 * With a seed (backend B), `send` always carries it as `initialData` — only
 * the instance-creating send records it, so this is idempotent by contract.
 */
function useConversationClient(backend: BackendKey, apiKey: string, sessionId?: string, seed?: AgentSeed) {
  return useMemo(() => {
    if (!sessionId) return undefined;
    const client = createFlueClient({ url: conversationUrl(backend, sessionId), token: apiKey });
    if (!seed) return client;
    return {
      ...client,
      send: (opts: Parameters<typeof client.send>[0]) => client.send({ ...opts, initialData: seed }),
    };
  }, [backend, apiKey, sessionId, seed]);
}

/** A request from the Chat tab to jump straight to a session in the browser. */
type InspectTarget = { backend: BackendKey; sessionId: string };

/** The Chat tab's currently-ready session, shared with the Chats (A/B) tab. */
type ActiveSession = { backend: BackendKey; sessionId: string; agentName?: string };

// The active tab lives in the URL hash (#chat / #data / #chats) rather than in
// plain state, so it's deep-linkable and browser back/forward works. The hash
// never reaches the server, so it needs no router and no Worker route config.
const readView = (): View => {
  const h = window.location.hash.replace(/^#\/?/, '');
  return h === 'data' ? 'data' : h === 'chats' ? 'chats' : 'chat'; // exact ('chats' ⊃ 'chat')
};

function useHashView(): [View, (v: View) => void] {
  const [view, setView] = useState<View>(readView);
  useEffect(() => {
    const onHash = () => setView(readView());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  // Assigning the hash creates a history entry and fires 'hashchange', which the
  // listener above turns back into `view` — that's what makes back/forward work.
  return [view, (v) => { window.location.hash = v; }];
}

export function App() {
  const [view, setView] = useHashView();
  const [inspect, setInspect] = useState<InspectTarget>();
  // The Chat tab's ready session, lifted here so the side-by-side "Chats (A/B)"
  // tab can mirror it (both panels observe the same agent id).
  const [active, setActive] = useState<ActiveSession>();
  // Data browser and the dual-chat view do real work on mount (admin fetches /
  // extra streams), so mount them lazily on first visit, then keep them alive.
  const [dataMounted, setDataMounted] = useState(false);
  const [chatsMounted, setChatsMounted] = useState(false);
  // API key is entered at runtime (never baked into the build) and persisted
  // locally so it survives reloads. It rides every request as
  // Authorization: Bearer <key> — via the FlueClient `token` for chat + SSE,
  // and via an explicit header on the setup/admin fetches below.
  const [apiKey, setApiKey] = useState(() => localStorage.getItem(API_KEY_STORAGE) ?? '');

  function updateApiKey(value: string) {
    setApiKey(value);
    localStorage.setItem(API_KEY_STORAGE, value);
  }

  useEffect(() => { if (view === 'data') setDataMounted(true); }, [view]);
  useEffect(() => { if (view === 'chats') setChatsMounted(true); }, [view]);

  return (
    <main>
      <header>
        <h1>Hoth Trip Planner</h1>
        <nav className="tabs">
          <button className={view === 'chat' ? 'tab active' : 'tab'} onClick={() => setView('chat')}>
            Chat
          </button>
          <button className={view === 'data' ? 'tab active' : 'tab'} onClick={() => setView('data')}>
            Data browser
          </button>
          <button className={view === 'chats' ? 'tab active' : 'tab'} onClick={() => setView('chats')}>
            Chats (A/B)
          </button>
        </nav>
        <div className="controls">
          <input
            type="password"
            className="apikey"
            value={apiKey}
            placeholder="API key"
            onChange={(event) => updateApiKey(event.target.value.trim())}
          />
        </div>
        {!apiKey ? <p className="status">Enter your API key to begin.</p> : null}
      </header>
      {/* All tabs stay mounted (inactive ones hidden) so the Chat session +
          streamed messages survive tab switches instead of being torn down. */}
      <div hidden={view !== 'chat'}>
        <ChatView
          key={apiKey}
          apiKey={apiKey}
          onActiveSession={setActive}
          onInspect={(target) => {
            setInspect(target);
            setView('data');
          }}
        />
      </div>
      {chatsMounted ? (
        <div hidden={view !== 'chats'}>
          <DualChatView key={apiKey} apiKey={apiKey} active={active} />
        </div>
      ) : null}
      {dataMounted ? (
        // Keyed by the inspect target so a fresh "inspect" from Chat remounts
        // the browser straight onto that session record.
        <div hidden={view !== 'data'}>
          <DataBrowser
            key={`${apiKey}:${inspect?.backend ?? ''}:${inspect?.sessionId ?? ''}`}
            apiKey={apiKey}
            initial={inspect}
            onOpenInChats={(target) => {
              setActive(target);
              setView('chats');
            }}
          />
        </div>
      ) : null}
    </main>
  );
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

function ChatView({
  apiKey,
  onInspect,
  onActiveSession,
}: {
  apiKey: string;
  onInspect: (target: InspectTarget) => void;
  onActiveSession: (session?: ActiveSession) => void;
}) {
  const [backend, setBackend] = useState<BackendKey>('a');
  // Backend B only: which agents/<name>/ bundle a new session delivers.
  const [agentName, setAgentName] = useState<string>(AGENT_NAMES[0] ?? '');
  const [sessionId, setSessionId] = useState<string>();
  const [phase, setPhase] = useState<'idle' | 'preparing' | 'ready' | 'error'>('idle');
  const [detail, setDetail] = useState('');
  // The session id box: filled automatically by "New session", and editable so
  // an existing conversation can be re-opened (simulating a reconnect/refresh).
  const [sessionInput, setSessionInput] = useState('');

  const client = useConversationClient(
    backend,
    apiKey,
    sessionId,
    backend === 'b' ? AGENT_SEEDS[agentName] : undefined,
  );

  // Report the ready session up to App so the "Chats (A/B)" tab can mirror it.
  useEffect(() => {
    onActiveSession(
      sessionId && phase === 'ready'
        ? { backend, sessionId, ...(backend === 'b' ? { agentName } : {}) }
        : undefined,
    );
  }, [backend, agentName, sessionId, phase, onActiveSession]);

  async function newSession(nextBackend: BackendKey) {
    const id = crypto.randomUUID();
    setPhase('preparing');
    setSessionId(undefined);
    setDetail('provisioning session…');
    try {
      const base = BACKENDS[nextBackend].baseUrl;
      const url =
        nextBackend === 'b'
          ? `${base}/sessions/${id}/agent`
          : `${base}/sessions/${id}/provision`;
      // B is name-based: the definition must already be deployed to KV via
      // `pnpm deploy:agent <name>` — the ingest route 404s otherwise. The
      // generated bundles below still feed the dropdown and the turn-1 seed.
      const body =
        nextBackend === 'b'
          ? JSON.stringify({ agentName, tenantTag: `tenant-${id.slice(0, 8)}` })
          : '{}';
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(payload)}`);
      setSessionId(id);
      setSessionInput(id); // surface the new id so it can be copied / re-opened
      setPhase('ready');
      setDetail(
        nextBackend === 'b'
          ? `agent ${payload.agentName}@${payload.version}; tag ${payload.tenantTag}`
          : 'static provision OK',
      );
    } catch (err) {
      setPhase('error');
      setDetail(String(err));
    }
  }

  // Re-attach to an existing conversation. Deliberately does NOT re-provision:
  // the conversation already lives in its agent Durable Object, and on B a
  // bundle is immutable per session id (re-POSTing would 409). This is the
  // "refresh an existing connection" path.
  function openSession() {
    const id = sessionInput.trim();
    if (!id) return;
    setSessionId(id);
    setPhase('ready');
    setDetail('re-opened existing session (no re-provision)');
  }

  const trimmedInput = sessionInput.trim();

  return (
    <>
      <div className="controls">
        <select
          value={backend}
          onChange={(event) => {
            setBackend(event.target.value as BackendKey);
            setSessionId(undefined);
            setPhase('idle');
            setDetail('');
          }}
        >
          {Object.entries(BACKENDS).map(([key, value]) => (
            <option key={key} value={key}>
              {value.label}
            </option>
          ))}
        </select>
        {backend === 'b' ? (
          // B is the multi-agent backend: pick which agent bundle a NEW
          // session delivers. A is fixed to the image-baked agent — no choice.
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
        ) : null}
        <button
          onClick={() => newSession(backend)}
          disabled={phase === 'preparing' || !apiKey || (backend === 'b' && !agentName)}
        >
          {phase === 'preparing' ? 'Preparing…' : 'New session'}
        </button>
        {backend === 'b' && AGENT_NAMES.length === 0 ? (
          <span className="status">no agents built — run `pnpm bundle`</span>
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
        <button onClick={openSession} disabled={!trimmedInput || !apiKey}>
          Open session
        </button>
        {trimmedInput ? (
          <button className="linkbtn" onClick={() => onInspect({ backend, sessionId: trimmedInput })}>
            Inspect in Data browser ›
          </button>
        ) : null}
      </div>
      <p className={`status status-${phase}`}>
        {sessionId ? `session ${sessionId} · ` : ''}
        {detail || (apiKey ? 'Start a new session, or paste a session id and open it.' : '')}
      </p>
      {client && phase === 'ready' ? (
        <AgentChat key={`${backend}:${sessionId}`} client={client} />
      ) : null}
    </>
  );
}

function Chat({ client }: { client: ReturnType<typeof createFlueClient> }) {
  const [input, setInput] = useState('');
  // live: 'sse' — ONE held connection streams both idle and active generation.
  // Still requires the @durable-streams/client patch (patches/): the v2 SDK
  // pins the same 0.2.6 client, whose stock build only opens SSE after
  // reaching up-to-date, so it busy-polls catch-up reads while an agent is
  // generating (never up-to-date) — a request flood. The patch sends live=sse
  // on the first request so the held stream opens immediately.
  const agent = useFlueAgent({ client, live: 'sse' });

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const message = input.trim();
    if (!message) return;
    setInput('');
    await agent.sendMessage(message);
  }

  return (
    <section className="chat">
      <div className="messages" aria-live="polite">
        {agent.messages.map((message) => (
          <Message key={message.id} message={message} />
        ))}
      </div>
      <form onSubmit={submit}>
        <input
          value={input}
          placeholder='Try: "Plan me a spa day in the Echo Basin, Aug 1-3 2026"'
          onChange={(event) => setInput(event.target.value)}
        />
        <button disabled={!input.trim()} type="submit">
          Send
        </button>
      </form>
      <p className="status">stream: {agent.status}</p>
    </section>
  );
}

type AgentMessage = ReturnType<typeof useFlueAgent>['messages'][number];

function Message({ message }: { message: AgentMessage }) {
  return (
    <article className={`msg msg-${message.role}`}>
      <strong>{message.role}</strong>
      {message.parts.map((part, index) =>
        part.type === 'text' ? (
          <p key={index}>{part.text}</p>
        ) : part.type === 'dynamic-tool' ? (
          <details key={index} className="tool">
            <summary>tool: {'toolName' in part ? String(part.toolName) : 'call'}</summary>
            <pre>{JSON.stringify(part, null, 2)}</pre>
          </details>
        ) : null,
      )}
    </article>
  );
}

// ---------------------------------------------------------------------------
// Chats (A/B) — two chat panels on one session, to show they converge
// ---------------------------------------------------------------------------

// Panel B is an isolated, swappable slot: the flue baseline (Panel A) on the
// left, the ai-elements rebuild on the right. Both take { client, sessionId }
// and observe the same agent session, so they still converge.
const PanelB = AgentChat;

/**
 * Two independent chat replicas of the SAME session, side by side. Each panel
 * runs its own useFlueAgent (its own SSE stream to the same agent Durable
 * Object), so they demonstrate server-authoritative convergence: a message sent
 * in one appears in both once the DO broadcasts it, while unsent input text —
 * being component-local — stays in the panel you typed it in. The session is
 * mirrored from the Chat tab via `active`.
 */
function DualChatView({ apiKey, active }: { apiKey: string; active?: ActiveSession }) {
  // One conversation-scoped client for the mirrored session; each panel's
  // useFlueAgent still opens its own stream over it, so the panels remain
  // independent replicas.
  const client = useConversationClient(
    active?.backend ?? 'a',
    apiKey,
    active?.sessionId,
    active?.backend === 'b' && active.agentName ? AGENT_SEEDS[active.agentName] : undefined,
  );

  if (!active || !client) {
    return <p className="status">Start or open a session on the Chat tab — both panels here mirror it.</p>;
  }

  const { backend, sessionId } = active;
  return (
    <>
      <p className="status">
        Two independent replicas of session {sessionId} ({BACKENDS[backend].label.split(' — ')[0]}).
        Each opens its own stream; type-then-send appears in both — the server is the source of truth.
      </p>
      <div className="dual">
        <div className="pane">
          <h3 className="pane-title">Panel A · Chat</h3>
          <Chat key={`a:${backend}:${sessionId}`} client={client} />
        </div>
        <div className="pane">
          <h3 className="pane-title">Panel B · ai-elements</h3>
          <PanelB key={`b:${backend}:${sessionId}`} client={client} />
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Data browser — generic collection → record → detail tree
// ---------------------------------------------------------------------------

type Collection = { id: string; label: string; kind: string; description?: string };
type RecordRef = { id: string; label: string; sublabel?: string; group?: string; meta?: unknown };

/** ISO timestamp -> local, compact. Falls back to the raw string if unparseable. */
function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}
type RecordList = { records: RecordRef[]; note?: string };

async function adminGet<T>(base: string, apiKey: string, path: string): Promise<T> {
  const res = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${apiKey}` } });
  const payload = await res.json();
  if (!res.ok) throw new Error(`${res.status}: ${JSON.stringify(payload)}`);
  return payload as T;
}

/** Mirrors the server's `sessions` collection, for deep-linking from Chat. */
const SESSIONS_COLLECTION: Collection = { id: 'sessions', label: 'Agent sessions', kind: 'sessions' };

function DataBrowser({
  apiKey,
  initial,
  onOpenInChats,
}: {
  apiKey: string;
  initial?: InspectTarget;
  onOpenInChats: (target: ActiveSession) => void;
}) {
  // When Chat deep-links a session, start already drilled into that record.
  // (This component is remounted per target, so initial state is enough.)
  const [backend, setBackend] = useState<BackendKey>(initial?.backend ?? 'b');
  const [collection, setCollection] = useState<Collection | undefined>(initial ? SESSIONS_COLLECTION : undefined);
  const [record, setRecord] = useState<RecordRef | undefined>(
    initial ? { id: initial.sessionId, label: initial.sessionId } : undefined,
  );

  const base = BACKENDS[backend].baseUrl;

  // Switching backend resets the drill-down (done here rather than in an effect
  // so it can't clobber the deep-linked initial state on mount).
  function changeBackend(next: BackendKey) {
    setBackend(next);
    setCollection(undefined);
    setRecord(undefined);
  }

  return (
    <section className="browser">
      <div className="controls">
        <select value={backend} onChange={(event) => changeBackend(event.target.value as BackendKey)}>
          {Object.entries(BACKENDS).map(([key, value]) => (
            <option key={key} value={key}>
              {value.label}
            </option>
          ))}
        </select>
      </div>

      <nav className="crumbs" aria-label="Breadcrumb">
        <button
          className="crumb"
          onClick={() => {
            setCollection(undefined);
            setRecord(undefined);
          }}
        >
          {BACKENDS[backend].label.split(' — ')[0]}
        </button>
        {collection ? (
          <>
            <span className="crumb-sep">›</span>
            <button className="crumb" onClick={() => setRecord(undefined)}>
              {collection.label}
            </button>
          </>
        ) : null}
        {record ? (
          <>
            <span className="crumb-sep">›</span>
            <span className="crumb current">{record.label}</span>
          </>
        ) : null}
      </nav>

      {!apiKey ? (
        <p className="status">Enter your API key to browse data.</p>
      ) : !collection ? (
        <CollectionList base={base} apiKey={apiKey} onOpen={setCollection} />
      ) : !record ? (
        <RecordsList base={base} apiKey={apiKey} collection={collection} onOpen={setRecord} />
      ) : (
        <RecordDetail base={base} apiKey={apiKey} backend={backend} collection={collection} record={record} onOpenInChats={onOpenInChats} />
      )}
    </section>
  );
}

function CollectionList({ base, apiKey, onOpen }: { base: string; apiKey: string; onOpen: (c: Collection) => void }) {
  const [state, setState] = useState<{ collections?: Collection[]; error?: string; loading: boolean }>({ loading: true });

  const load = useCallback(() => {
    setState({ loading: true });
    adminGet<{ collections: Collection[] }>(base, apiKey, '/admin/collections')
      .then((r) => setState({ collections: r.collections, loading: false }))
      .catch((err) => setState({ error: String(err), loading: false }));
  }, [base, apiKey]);

  useEffect(() => load(), [load]);

  if (state.loading) return <p className="status">loading…</p>;
  if (state.error) return <p className="status status-error">{state.error}</p>;
  return (
    <div className="cards">
      {state.collections?.map((c) => (
        <button key={c.id} className="card" onClick={() => onOpen(c)}>
          <span className="card-title">{c.label}</span>
          {c.description ? <span className="card-desc">{c.description}</span> : null}
          <span className="card-open">Open ›</span>
        </button>
      ))}
    </div>
  );
}

function RecordsList({
  base,
  apiKey,
  collection,
  onOpen,
}: {
  base: string;
  apiKey: string;
  collection: Collection;
  onOpen: (r: RecordRef) => void;
}) {
  const [state, setState] = useState<{ data?: RecordList; error?: string; loading: boolean }>({ loading: true });

  const load = useCallback(() => {
    setState({ loading: true });
    adminGet<RecordList>(base, apiKey, `/admin/collections/${collection.id}/records`)
      .then((data) => setState({ data, loading: false }))
      .catch((err) => setState({ error: String(err), loading: false }));
  }, [base, apiKey, collection.id]);

  useEffect(() => load(), [load]);

  const groups = useMemo(() => {
    const byGroup = new Map<string, RecordRef[]>();
    for (const r of state.data?.records ?? []) {
      const key = r.group ?? '';
      const arr = byGroup.get(key) ?? [];
      arr.push(r);
      byGroup.set(key, arr);
    }
    return [...byGroup.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [state.data]);

  if (state.loading) return <p className="status">loading…</p>;
  if (state.error) return <p className="status status-error">{state.error}</p>;

  const total = state.data?.records.length ?? 0;
  return (
    <div>
      <div className="controls">
        <button onClick={() => load()}>Refresh</button>
        <span className="status">
          {total} record{total === 1 ? '' : 's'}
        </span>
      </div>
      {state.data?.note ? <p className="status">{state.data.note}</p> : null}
      <div className="keylist">
        {groups.map(([group, records]) => (
          <div key={group || '_'} className="keygroup">
            {group ? (
              <div className="keygroup-head">
                {group} <span className="count">{records.length}</span>
              </div>
            ) : null}
            {records.map((r) => (
              <button key={r.id} className="keyrow" onClick={() => onOpen(r)} title={r.id}>
                <span className="keyrow-label">{group ? r.label.replace(`${group}:`, '') || r.label : r.label}</span>
                {r.sublabel ? <span className="keyrow-sub">{formatWhen(r.sublabel)}</span> : null}
                <span className="keyrow-open">›</span>
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

type Detail =
  | { kind: 'kv'; key: string; value: string; size: number; json: unknown }
  | { kind: 'session'; id: string; session: Record<string, unknown> }
  | Record<string, unknown>;

function RecordDetail({
  base,
  apiKey,
  backend,
  collection,
  record,
  onOpenInChats,
}: {
  base: string;
  apiKey: string;
  backend: BackendKey;
  collection: Collection;
  record: RecordRef;
  onOpenInChats: (target: ActiveSession) => void;
}) {
  const [state, setState] = useState<{ detail?: Detail; error?: string; loading: boolean }>({ loading: true });
  // Rendered view vs the raw stored payload. Sessions label it "Chat" since the
  // rendered form is the conversation; everything else is "Formatted".
  const [tab, setTab] = useState<'view' | 'raw'>('view');

  useEffect(() => {
    let cancelled = false;
    setState({ loading: true });
    setTab('view');
    adminGet<Detail>(base, apiKey, `/admin/collections/${collection.id}/record?id=${encodeURIComponent(record.id)}`)
      .then((detail) => !cancelled && setState({ detail, loading: false }))
      .catch((err) => !cancelled && setState({ error: String(err), loading: false }));
    return () => {
      cancelled = true;
    };
  }, [base, apiKey, collection.id, record.id]);

  if (state.loading) return <div className="detail"><p className="status">loading…</p></div>;
  if (state.error) return <div className="detail"><p className="status status-error">{state.error}</p></div>;

  const detail = state.detail as Detail;
  const isSession = detail.kind === 'session';

  return (
    <div className="detail">
      <div className="detail-head">
        <code className="detail-key">{record.id}</code>
        <span className="detail-head-actions">
          {'size' in detail && typeof detail.size === 'number' ? <span className="status">{detail.size} bytes</span> : null}
          {isSession ? (
            // Symmetric to the Chat tab's "Inspect in Data browser ›": lifts this
            // session up to App's `active` and jumps to the side-by-side A/B view.
            <button className="linkbtn" onClick={() => onOpenInChats({ backend, sessionId: record.id })}>
              Open in Chats (A/B) ›
            </button>
          ) : null}
        </span>
      </div>

      <nav className="tabs tabs-sub">
        <button className={tab === 'view' ? 'tab active' : 'tab'} onClick={() => setTab('view')}>
          {isSession ? 'Chat' : 'Formatted'}
        </button>
        <button className={tab === 'raw' ? 'tab active' : 'tab'} onClick={() => setTab('raw')}>
          Raw JSON
        </button>
      </nav>

      {tab === 'raw' ? (
        isSession ? (
          // For a session the raw form is what's actually persisted: the KV
          // session-index record plus the agent DO's conversation snapshot.
          <RawSession backend={backend} apiKey={apiKey} sessionId={record.id} session={(detail as { session: Record<string, unknown> }).session} />
        ) : (
          <pre className="value">{JSON.stringify(detail, null, 2)}</pre>
        )
      ) : detail.kind === 'kv' ? (
        <KvValue value={(detail as { value: string }).value} json={(detail as { json: unknown }).json} />
      ) : isSession ? (
        <SessionDetail apiKey={apiKey} backend={backend} session={(detail as { session: Record<string, unknown> }).session} sessionId={record.id} />
      ) : (
        <pre className="value">{JSON.stringify(detail, null, 2)}</pre>
      )}
    </div>
  );
}

/**
 * Raw persisted form of a session: the KV session-index record plus the agent
 * Durable Object's conversation snapshot, read straight from the Flue
 * conversation endpoint (the same bytes the chat client consumes). A session
 * that never received a prompt has no stream yet — that error is shown as-is,
 * because it is the truthful state.
 */
function RawSession({
  backend,
  apiKey,
  sessionId,
  session,
}: {
  backend: BackendKey;
  apiKey: string;
  sessionId: string;
  session: Record<string, unknown>;
}) {
  const [conversation, setConversation] = useState<unknown>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    setConversation(undefined);
    setError(undefined);
    fetch(conversationUrl(backend, sessionId), {
      headers: { authorization: `Bearer ${apiKey}` },
    })
      .then((res) => res.json())
      .then((payload) => !cancelled && setConversation(payload))
      .catch((err) => !cancelled && setError(String(err)));
    return () => {
      cancelled = true;
    };
  }, [backend, apiKey, sessionId]);

  return (
    <pre className="value">
      {JSON.stringify(
        {
          sessionIndex: session,
          conversation: error ? { error } : conversation ?? '(loading…)',
        },
        null,
        2,
      )}
    </pre>
  );
}

function KvValue({ value, json }: { value: string; json: unknown }) {
  const bundle = asBundle(json);
  if (bundle) return <BundleView bundle={bundle} />;
  if (json !== null && json !== undefined) return <pre className="value">{JSON.stringify(json, null, 2)}</pre>;
  return <pre className="value">{value}</pre>;
}

function SessionDetail({
  apiKey,
  backend,
  session,
  sessionId,
}: {
  apiKey: string;
  backend: BackendKey;
  session: Record<string, unknown>;
  sessionId: string;
}) {
  return (
    <div>
      <dl className="meta">
        {Object.entries(session).map(([k, v]) => (
          <div key={k} className="meta-row">
            <dt>{k}</dt>
            <dd>{typeof v === 'string' ? v : JSON.stringify(v)}</dd>
          </div>
        ))}
      </dl>
      <h3 className="subhead">Conversation (live, from the agent Durable Object)</h3>
      <ConversationView apiKey={apiKey} backend={backend} sessionId={sessionId} />
    </div>
  );
}

/** Reads the stored conversation (Flue agent DO SQLite) for a session id. */
function ConversationView({ apiKey, backend, sessionId }: { apiKey: string; backend: BackendKey; sessionId: string }) {
  const client = useConversationClient(backend, apiKey, sessionId);
  // Read-only catch-up: 'long-poll' reaches the stored state without holding the
  // SSE stream open (no live generation to follow when browsing).
  const agent = useFlueAgent({ client, live: 'long-poll' });

  if (agent.messages.length === 0) {
    return <p className="status">No messages stored for this conversation ({agent.status}).</p>;
  }
  return (
    <div className="messages messages-read">
      {agent.messages.map((message) => (
        <Message key={message.id} message={message} />
      ))}
    </div>
  );
}

function asBundle(json: unknown): AgentBundle | null {
  if (!json || typeof json !== 'object') return null;
  const b = json as Record<string, unknown>;
  if (typeof b.agentName === 'string' && typeof b.version === 'string' && b.skills && typeof b.skills === 'object') {
    return b as AgentBundle;
  }
  return null;
}

function BundleView({ bundle }: { bundle: AgentBundle }) {
  // Flatten every skill's files to `<skill>/<path>` entries for the file list.
  const files = useMemo(
    () =>
      Object.entries(bundle.skills).flatMap(([skillName, skillFiles]) =>
        Object.entries(skillFiles).map(([path, content]): [string, string] => [`${skillName}/${path}`, content]),
      ),
    [bundle],
  );
  const contents = useMemo(() => new Map(files), [files]);
  const [open, setOpen] = useState<string | undefined>(files[0]?.[0]);
  return (
    <div className="bundle">
      <dl className="meta">
        <div className="meta-row">
          <dt>agent</dt>
          <dd>
            <code>{bundle.agentName}</code>@<code>{bundle.version}</code>
          </dd>
        </div>
        <div className="meta-row">
          <dt>baseImage</dt>
          <dd>
            <code>{bundle.baseImage}</code>
          </dd>
        </div>
        {bundle.model ? (
          <div className="meta-row">
            <dt>model</dt>
            <dd>
              <code>{bundle.model}</code>
            </dd>
          </div>
        ) : null}
        {bundle.modelBaseUrl ? (
          <div className="meta-row">
            <dt>modelBaseUrl</dt>
            <dd>
              <code>{bundle.modelBaseUrl}</code>
            </dd>
          </div>
        ) : null}
        <div className="meta-row">
          <dt>instructions</dt>
          <dd>{bundle.instructions}</dd>
        </div>
        <div className="meta-row">
          <dt>egress</dt>
          <dd>{bundle.proxyWhitelist?.length ? bundle.proxyWhitelist.join(', ') : '(deny all)'}</dd>
        </div>
        <div className="meta-row">
          <dt>skills</dt>
          <dd>
            {Object.keys(bundle.skills).join(', ') || '(none)'} — {files.length} file{files.length === 1 ? '' : 's'}
          </dd>
        </div>
      </dl>
      <div className="filelist">
        {files.map(([path]) => (
          <button
            key={path}
            className={open === path ? 'keyrow active' : 'keyrow'}
            onClick={() => setOpen(path)}
            title={path}
          >
            <span className="keyrow-label">{path}</span>
            <span className="count">{contents.get(path)?.length ?? 0}</span>
          </button>
        ))}
      </div>
      {open ? <pre className="value">{contents.get(open)}</pre> : null}
    </div>
  );
}
