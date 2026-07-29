/**
 * Hoth POC admin console (`/`, plan §10): a read-only Data browser over
 * everything the backend persists in Cloudflare.
 *
 * ADMIN ONLY. This page authenticates with the shared deployment API key
 * (`Authorization: Bearer <API_TOKEN>`), which can deploy agent definitions and
 * read every stored record — so it is deliberately NOT the page users chat on.
 * Chatting lives at /chat (src/ChatApp.tsx), authenticated by the user's own
 * Semantius token and unable to reach any admin route. The only link between
 * them is one-way: a session record here offers "Open in chat ›".
 *
 * Conversations ARE browsable here — everything the backend persists is, and a
 * conversation is persisted state. They are read through the backend's
 * read-only `/admin/agents/main/*` mount (the deployment key), never through
 * the user's `/agents/main/*` surface, so browsing needs nobody's user token
 * and this page can never send a message as a user.
 *
 * Data browser: a generic collection → record → detail tree with breadcrumbs.
 * The backend exposes its stores as "collections" via /admin/collections:
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
import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  adminConversationUrl,
  API_KEY_STORAGE,
  BACKEND,
  chatPageUrl,
  useConversationClient,
  type AgentBundle,
} from './lib/session';

export function App() {
  // Deployment API key: entered at runtime (never baked into the build) and
  // persisted locally so it survives reloads. It rides every admin request as
  // Authorization: Bearer <key>. It is NOT a chat credential -- the chat page
  // authenticates users with their own Semantius token instead.
  const [apiKey, setApiKey] = useState(() => localStorage.getItem(API_KEY_STORAGE) ?? '');

  function updateApiKey(value: string) {
    setApiKey(value);
    localStorage.setItem(API_KEY_STORAGE, value);
  }

  return (
    <main>
      <header>
        <h1>Hoth Trip Planner &middot; admin</h1>
        <nav className="tabs">
          <span className="tab active">Data browser</span>
          <a className="tab" href={chatPageUrl()}>
            Chat &rsaquo;
          </a>
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
        {!apiKey ? <p className="status">Enter your API key to browse data.</p> : null}
      </header>
      <DataBrowser key={apiKey} apiKey={apiKey} />
    </main>
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

function DataBrowser({ apiKey }: { apiKey: string }) {
  const [collection, setCollection] = useState<Collection | undefined>();
  const [record, setRecord] = useState<RecordRef | undefined>();

  const base = BACKEND.baseUrl;

  return (
    <section className="browser">
      <nav className="crumbs" aria-label="Breadcrumb">
        <button
          className="crumb"
          onClick={() => {
            setCollection(undefined);
            setRecord(undefined);
          }}
        >
          {BACKEND.label}
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
        <RecordDetail base={base} apiKey={apiKey} collection={collection} record={record} />
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
                {/* Full key, prefix included — stripping it made same-id keys
                    across groups (agent:/session:<id>) read as inexplicable
                    duplicates. */}
                <span className="keyrow-label">{r.label}</span>
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
  collection,
  record,
}: {
  base: string;
  apiKey: string;
  collection: Collection;
  record: RecordRef;
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
            // The one link across the split: hands the session id to the chat
            // page. That page needs the OWNER's Semantius token to actually
            // open it — this link carries no credential and grants nothing.
            <a className="linkbtn" href={chatPageUrl(record.id)}>
              Open in chat ›
            </a>
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
          // session record plus the agent DO's conversation snapshot.
          <RawSession apiKey={apiKey} sessionId={record.id} session={(detail as { session: Record<string, unknown> }).session} />
        ) : detail.kind === 'kv' ? (
          // Payload only — key and size already sit in the header, and the
          // admin envelope's `json` is just the parsed copy of `value`, so
          // showing the whole envelope displayed the same bytes twice.
          <pre className="value">
            {(detail as { json: unknown }).json != null
              ? JSON.stringify((detail as { json: unknown }).json, null, 2)
              : (detail as { value: string }).value}
          </pre>
        ) : (
          <pre className="value">{JSON.stringify(detail, null, 2)}</pre>
        )
      ) : detail.kind === 'kv' ? (
        <KvValue value={(detail as { value: string }).value} json={(detail as { json: unknown }).json} />
      ) : isSession ? (
        <SessionDetail apiKey={apiKey} session={(detail as { session: Record<string, unknown> }).session} sessionId={record.id} />
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
  apiKey,
  sessionId,
  session,
}: {
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
    fetch(adminConversationUrl(sessionId), {
      headers: { authorization: `Bearer ${apiKey}` },
    })
      .then((res) => res.json())
      .then((payload) => !cancelled && setConversation(payload))
      .catch((err) => !cancelled && setError(String(err)));
    return () => {
      cancelled = true;
    };
  }, [apiKey, sessionId]);

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
  session,
  sessionId,
}: {
  apiKey: string;
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
      <ConversationView apiKey={apiKey} sessionId={sessionId} />
    </div>
  );
}

/**
 * Reads the stored conversation (Flue agent DO SQLite) for a session id — via
 * the READ-ONLY admin mount, so the browser shows it with the deployment key
 * and never needs the owner's Semantius token.
 */
function ConversationView({ apiKey, sessionId }: { apiKey: string; sessionId: string }) {
  const client = useConversationClient(apiKey, sessionId, undefined, adminConversationUrl);
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

function asBundle(json: unknown): AgentBundle | null {
  if (!json || typeof json !== 'object') return null;
  const b = json as Record<string, unknown>;
  // A bundle's `skills` is a files MAP ({ name: { path: content } }) and it
  // always carries `instructions`. Both guards matter: THE session record
  // also has agentName/version, and rendering it as a bundle iterates
  // strings character-by-character ("100 files").
  if (
    typeof b.agentName === 'string' &&
    typeof b.version === 'string' &&
    typeof b.instructions === 'string' &&
    b.skills &&
    typeof b.skills === 'object' &&
    !Array.isArray(b.skills)
  ) {
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
