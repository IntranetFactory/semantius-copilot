/**
 * Semantius Copilot admin console (`/admin`, plan §10): a read-only Data browser over
 * everything the backend persists in Cloudflare, plus today's Cloudflare
 * container spend per session (the Costs tab).
 *
 * ADMIN ONLY. This page authenticates with the shared deployment API key
 * (`Authorization: Bearer <API_TOKEN>`), which can deploy agent definitions and
 * read every stored record — so it is deliberately NOT the page users chat on.
 * Chatting lives at /chat (src/ChatApp.tsx), authenticated by the user's own
 * Semantius token, and at /copilot (src/CopilotApp.tsx), authenticated by their
 * better-auth session cookie; neither can reach any admin route. The only link
 * between them is one-way: a session record here offers "Open in chat ›".
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

import { BACKEND, useConversationClient } from './components/ai-elements/session';
import type { AgentWelcome } from './components/ai-elements/welcome';
import { API_KEY_STORAGE, chatPageUrl } from './pages';

/** The full stored agent definition (KV `agentdef:<name>`), as the bundle
 * viewer renders it: the turn-1 seed fields plus the welcome card and the
 * skill FILES. Admin-only — the chat surface never sees skill contents, so
 * this type lives here rather than in the copyable ai-elements folder. */
type AgentBundle = {
  agentName: string;
  version: string;
  baseImage: string;
  instructions: string;
  model?: string;
  modelBaseUrl?: string;
  proxyWhitelist?: string[];
  welcome?: AgentWelcome;
  skills: Record<string, Record<string, string>>;
};

/**
 * A conversation read through the admin console's credential. The backend
 * mounts the agent router twice — `/agents/main/*` for the owner's own
 * credential, `/admin/agents/main/*` (read-only, GET only) for the deployment
 * key — so the data browser can show conversations without the operator
 * holding anyone's user token.
 */
const adminConversationUrl = (sessionId: string) =>
  `${BACKEND.baseUrl}/admin/agents/main/${encodeURIComponent(sessionId)}`;

export function App() {
  // Deployment API key: entered at runtime (never baked into the build) and
  // persisted locally so it survives reloads. It rides every admin request as
  // Authorization: Bearer <key>. It is NOT a chat credential -- the chat page
  // authenticates users with their own Semantius token instead.
  const [apiKey, setApiKey] = useState(() => localStorage.getItem(API_KEY_STORAGE) ?? '');
  const [tab, setTab] = useState<'data' | 'costs'>('data');

  function updateApiKey(value: string) {
    setApiKey(value);
    localStorage.setItem(API_KEY_STORAGE, value);
  }

  return (
    <main>
      <header>
        <h1>Semantius Copilot &middot; admin</h1>
        <nav className="tabs">
          <button
            type="button"
            className={`tab${tab === 'data' ? ' active' : ''}`}
            onClick={() => setTab('data')}
          >
            Data browser
          </button>
          <button
            type="button"
            className={`tab${tab === 'costs' ? ' active' : ''}`}
            onClick={() => setTab('costs')}
          >
            Costs
          </button>
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
      {tab === 'data' ? (
        <DataBrowser key={apiKey} apiKey={apiKey} />
      ) : (
        <CostsView key={apiKey} apiKey={apiKey} />
      )}
    </main>
  );
}

// ---------------------------------------------------------------------------
// Costs — today's Cloudflare container spend, per session, plus the session's
// LLM spend beside it.
//
// CONTAINER cost only on the Cloudflare side, and deliberately so: Cloudflare's
// Worker/Durable-Object datasets carry no session-shaped dimension, so a
// per-session Worker figure could only be an estimate. The backend
// (GET /admin/costs) reports what is measured — see core/src/cost.js.
//
// The LLM column is `session_state.cost_total` off THE session record — the
// session's LIFETIME total, against a container figure that is today-only. Two
// windows, two columns, no combined column: adding them would produce a number
// that means nothing.
// ---------------------------------------------------------------------------

type CostSums = {
  cpuSeconds: number;
  memoryGiBSeconds: number;
  diskGBSeconds: number;
  egressBytes: number;
  cost: { cpu: number; memory: number; disk: number; egress: number; total: number };
};
type CostRow = CostSums & {
  /** Cloudflare's grouping label — the SANDBOX name (`<org>-<tail>`), not always the session id. */
  sessionId: string;
  /** The full session id when the backend resolved it — what the chat page addresses. */
  fullSessionId?: string;
  agentName?: string;
  version?: string;
  createdAt?: string;
  /** Session LIFETIME LLM spend (session_state.cost_total) — a different window to the rest. */
  llmCost?: number;
  /** Current R2 backup archive size (session_backup.size_bytes). */
  backupSizeBytes?: number;
  /** Backups persisted so far (each supersedes the previous). */
  backupCount?: number;
  /** R2 storage run rate for that archive, $/month — a THIRD window. */
  backupMonthlyUsd?: number;
};
type Costs = {
  date: string;
  start: string;
  end: string;
  currency: string;
  basis: string;
  backupBasis?: string;
  configured: boolean;
  reason?: string;
  rows?: CostRow[];
  unlabeled?: CostSums | null;
  totals?: CostSums;
  llmTotal?: number;
  backupMonthlyTotal?: number;
  truncated?: boolean;
};

/** Four decimals, not two: a POC session costs well under a cent. */
const usd = (n: number) => `$${n.toFixed(4)}`;
const num = (n: number, digits = 1) => n.toLocaleString(undefined, { maximumFractionDigits: digits });

function megabytes(n: number): string {
  return `${(n / 1e6).toLocaleString(undefined, { maximumFractionDigits: 2 })} MB`;
}

function CostsView({ apiKey }: { apiKey: string }) {
  const [costs, setCosts] = useState<Costs>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const load = useCallback(() => {
    if (!apiKey) return;
    setLoading(true);
    setError('');
    adminGet<Costs>(BACKEND.baseUrl, apiKey, '/admin/costs')
      .then((data) => setCosts(data))
      .catch((err) => setError(String(err instanceof Error ? err.message : err)))
      .finally(() => setLoading(false));
  }, [apiKey]);

  useEffect(() => load(), [load]);

  if (!apiKey) return null;

  const rows = costs?.rows ?? [];

  return (
    <section className="browser">
      <div className="detail-head">
        <span className="detail-key">
          Cloudflare containers &middot; {costs?.date ?? 'today'} (UTC{costs ? `, to ${costs.end.slice(11, 16)}` : ''})
        </span>
        <div className="detail-head-actions">
          <button type="button" className="linkbtn" onClick={load} disabled={loading}>
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>
      </div>

      {error ? <p className="status status-error">{error}</p> : null}
      {costs && !costs.configured ? <p className="status status-error">{costs.reason}</p> : null}
      {costs?.truncated ? (
        <p className="status status-error">Result hit the group limit — totals are partial.</p>
      ) : null}

      {costs?.configured ? (
        <div className="keylist">
          <table className="costs">
            <thead>
              <tr>
                <th>Session</th>
                <th>Agent</th>
                <th>Started</th>
                <th className="numcol">vCPU s</th>
                <th className="numcol">GiB·s</th>
                <th className="numcol">GB·s disk</th>
                <th className="numcol">Egress</th>
                {/* Three money columns, three different windows — never summed. */}
                <th className="numcol">Container $ (today)</th>
                <th className="numcol">LLM $ (session)</th>
                <th className="numcol">Backup MB</th>
                <th className="numcol">Backup $/mo</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.sessionId}>
                  <td className="costs-id">
                    <a className="linkbtn" href={chatPageUrl(row.fullSessionId ?? row.sessionId)}>
                      {row.fullSessionId ?? row.sessionId}
                    </a>
                  </td>
                  <td>{row.agentName ?? '—'}</td>
                  <td>{row.createdAt ? formatWhen(row.createdAt) : '—'}</td>
                  <td className="numcol">{num(row.cpuSeconds)}</td>
                  <td className="numcol">{num(row.memoryGiBSeconds)}</td>
                  <td className="numcol">{num(row.diskGBSeconds)}</td>
                  <td className="numcol">{megabytes(row.egressBytes)}</td>
                  <td className="numcol">{usd(row.cost.total)}</td>
                  <td className="numcol">{row.llmCost === undefined ? '—' : usd(row.llmCost)}</td>
                  <td className="numcol">{row.backupSizeBytes === undefined ? '—' : megabytes(row.backupSizeBytes)}</td>
                  <td className="numcol">{row.backupMonthlyUsd === undefined ? '—' : usd(row.backupMonthlyUsd)}</td>
                </tr>
              ))}
              {/* Containers started before the session label shipped (or by
                  anything that isn't a session) still cost money — showing them
                  as their own row is what keeps the total honest. */}
              {costs.unlabeled ? (
                <tr>
                  <td className="costs-id">(unlabeled)</td>
                  <td>—</td>
                  <td>—</td>
                  <td className="numcol">{num(costs.unlabeled.cpuSeconds)}</td>
                  <td className="numcol">{num(costs.unlabeled.memoryGiBSeconds)}</td>
                  <td className="numcol">{num(costs.unlabeled.diskGBSeconds)}</td>
                  <td className="numcol">{megabytes(costs.unlabeled.egressBytes)}</td>
                  <td className="numcol">{usd(costs.unlabeled.cost.total)}</td>
                  <td className="numcol">—</td>
                  <td className="numcol">—</td>
                  <td className="numcol">—</td>
                </tr>
              ) : null}
              {rows.length === 0 && !costs.unlabeled ? (
                <tr>
                  <td colSpan={11} className="status">
                    No container usage recorded today. (Analytics lags a few minutes.)
                  </td>
                </tr>
              ) : null}
            </tbody>
            {costs.totals ? (
              <tfoot>
                <tr>
                  <td colSpan={3}>Total</td>
                  <td className="numcol">{num(costs.totals.cpuSeconds)}</td>
                  <td className="numcol">{num(costs.totals.memoryGiBSeconds)}</td>
                  <td className="numcol">{num(costs.totals.diskGBSeconds)}</td>
                  <td className="numcol">{megabytes(costs.totals.egressBytes)}</td>
                  <td className="numcol">{usd(costs.totals.cost.total)}</td>
                  <td className="numcol">{costs.llmTotal === undefined ? '—' : usd(costs.llmTotal)}</td>
                  <td className="numcol">
                    {(() => {
                      const bytes = rows.reduce((sum, r) => sum + (r.backupSizeBytes ?? 0), 0);
                      return bytes > 0 ? megabytes(bytes) : '—';
                    })()}
                  </td>
                  <td className="numcol">
                    {costs.backupMonthlyTotal === undefined || costs.backupMonthlyTotal === 0
                      ? '—'
                      : usd(costs.backupMonthlyTotal)}
                  </td>
                </tr>
              </tfoot>
            ) : null}
          </table>
        </div>
      ) : null}

      {costs?.basis ? (
        <p className="status">
          {costs.basis} The money columns cover DIFFERENT periods — container cost is today&rsquo;s UTC
          day, LLM cost is the session&rsquo;s running lifetime total (<code>session_state.cost_total</code>),
          and Backup $/mo is a storage run-rate estimate for the session&rsquo;s current R2 archive
          (<code>session_backup</code>) — so they are shown side by side and never added together.
          {costs.backupBasis ? ` ${costs.backupBasis}` : ''}
        </p>
      ) : null}
    </section>
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

type BackupDetailShape = {
  kind: 'backup';
  id: string;
  backup: Record<string, unknown> | null;
  sessionId: string | null;
  sessionExists: boolean;
  storageMonthlyUsd: number;
  keys: { archive: string; meta: string };
};

type Detail =
  | { kind: 'kv'; key: string; value: string; size: number; json: unknown }
  | { kind: 'session'; id: string; session: Record<string, unknown> }
  | BackupDetailShape
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
      ) : detail.kind === 'backup' ? (
        <BackupView base={base} apiKey={apiKey} detail={detail as BackupDetailShape} />
      ) : (
        <pre className="value">{JSON.stringify(detail, null, 2)}</pre>
      )}
    </div>
  );
}

/**
 * One R2 workspace backup: the meta.json facts, whether its session is still
 * alive, the storage run rate, and an authenticated download of the squashfs
 * archive (a plain <a href> would lack the Authorization header, so the
 * download goes fetch -> blob -> object URL).
 */
function BackupView({ base, apiKey, detail }: { base: string; apiKey: string; detail: BackupDetailShape }) {
  const [error, setError] = useState('');
  const [downloading, setDownloading] = useState(false);
  const meta = detail.backup ?? {};
  const sizeBytes = typeof meta.sizeBytes === 'number' ? meta.sizeBytes : undefined;
  const createdAt = typeof meta.createdAt === 'string' ? meta.createdAt : undefined;

  const download = () => {
    setDownloading(true);
    setError('');
    fetch(`${base}/admin/backups/${encodeURIComponent(detail.id)}/archive`, {
      headers: { authorization: `Bearer ${apiKey}` },
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
        return res.blob();
      })
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${detail.id}.sqsh`;
        a.click();
        URL.revokeObjectURL(url);
      })
      .catch((err) => setError(String(err instanceof Error ? err.message : err)))
      .finally(() => setDownloading(false));
  };

  return (
    <div>
      <div className="controls">
        <button onClick={download} disabled={downloading}>
          {downloading ? 'Downloading…' : 'Download archive'}
        </button>
        {detail.sessionId ? (
          <a className="linkbtn" href={chatPageUrl(detail.sessionId)}>
            Open session in chat ›
          </a>
        ) : null}
      </div>
      {error ? <p className="status status-error">{error}</p> : null}
      <div className="keylist">
        <table className="costs">
          <tbody>
            <tr>
              <td>Session</td>
              <td>
                {detail.sessionId ?? '—'}
                {detail.sessionId ? (detail.sessionExists ? ' (live)' : ' (session gone — sweep candidate)') : ''}
              </td>
            </tr>
            <tr>
              <td>Created</td>
              <td>{createdAt ? formatWhen(createdAt) : '—'}</td>
            </tr>
            <tr>
              <td>Archive size</td>
              <td>{sizeBytes === undefined ? '—' : megabytes(sizeBytes)}</td>
            </tr>
            <tr>
              <td>Storage run rate</td>
              <td>{usd(detail.storageMonthlyUsd)}/month</td>
            </tr>
            <tr>
              <td>Directory</td>
              <td>{typeof meta.dir === 'string' ? meta.dir : '—'}</td>
            </tr>
            <tr>
              <td>R2 keys</td>
              <td>
                <code>{detail.keys.archive}</code>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
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
  const client = useConversationClient({ bearer: apiKey }, sessionId, adminConversationUrl);
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
