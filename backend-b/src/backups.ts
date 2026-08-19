/**
 * Workspace backup/restore orchestration (add_backup_restore_plan.md).
 *
 * The container disk is ephemeral — reset to the image at sleepAfter (10 min
 * idle) or eviction — so everything the agent writes under /workspace would
 * die with it. The @cloudflare/sandbox SDK's backup feature (squashfs archive
 * in R2) closes that gap; this module decides WHEN it runs:
 *
 *   restore  provisionWorkspace (agents/main.ts) — the lazy env runs it once
 *            per submission, exactly when a turn first touches the container,
 *            and AGAIN whenever the lazy env's reset probe finds the marker
 *            gone mid-submission (the container was replaced under a running
 *            turn: sleepAfter between two slow tool calls, eviction, a deploy).
 *   persist  three writers, all funnelled through requestWorkspacePersist
 *            (per-session single-flight + coalescing, so a burst of tool
 *            calls costs one archive in flight and at most one queued):
 *              - after EVERY mutating container op of a turn (lazy env
 *                onMutation: exec / writeFile / mkdir / rm) — the "every
 *                filesystem mutation is persisted" guarantee, at the cost of
 *                one small squashfs per tool call;
 *              - useResponseFinish (agents/main.ts) — the turn-end sweep, only
 *                when THIS submission touched the container (touched-registry
 *                below; chat-only turns never boot a container to back it up);
 *              - the /workspace upload route (app.ts).
 *            A persist REFUSES to run when the restore marker is absent
 *            (status 'unreconciled'): that container has not been merged with
 *            the session's archive, so archiving it would supersede a good
 *            backup with a blank disk — exactly how an uploaded file was lost
 *            once (reset mid-turn, then the turn-end persist "won").
 *
 * Everything here uses the SDK's `localBucket: true` mode: the sandbox DO
 * moves archive bytes over its own control channel and reads/writes R2 via
 * the BACKUP_BUCKET binding on its env. No presigned URLs, no R2 access keys,
 * no container egress — nothing for the egress whitelist or the Dockerfile CA
 * story to absorb. (The SDK comments call the mode "local dev", but the code
 * path has no environment check and runs identically in production —
 * verified against @cloudflare/sandbox 0.12.3, which package.json pins
 * exactly. Re-verify on any SDK bump.) Trade-off, accepted: the control
 * channel moves ~0.6 MB/s and the restore path can buffer the archive in DO
 * memory, so archives must stay small — the excludes keep the POC's
 * markdown/yaml workspaces in the KB–MB range, and size_bytes is surfaced on
 * the session record and the Costs tab precisely so growth is visible.
 *
 * Failure posture: NOTHING here ever throws into an agent turn. A broken
 * backup service degrades to today's behavior (ephemeral workspace), logged
 * as a `backup:` breadcrumb, never a failed submission.
 */
import { getSandbox } from '@cloudflare/sandbox';
import {
  BACKUP_EXCLUDES,
  BACKUP_TTL_SECONDS,
  backupKeys,
  backupStorageMonthlyUsd,
  deleteBackup,
  mergeExistingSessionRecord,
  readSession,
  sandboxNameForSession,
  sweepOrphanedBackups,
} from '@semantius-copilot/core';

/** The env slice this module needs; BACKUP_BUCKET absent = feature off. */
export type BackupEnv = {
  STORE: KVNamespace;
  BACKUP_BUCKET?: R2Bucket;
};

/**
 * The sandbox surface we touch — structural on purpose (the SandboxLike
 * posture of core/src/provision.js): decoupled from the SDK's generics and
 * stubbable in tests. Satisfied by the stub `getSandbox()` returns.
 */
export type BackupSandbox = {
  exec(command: string): Promise<{ exitCode?: number; success?: boolean; stdout?: string; stderr?: string }>;
  createBackup(options: {
    dir: string;
    name?: string;
    ttl?: number;
    excludes?: string[];
    localBucket?: boolean;
  }): Promise<{ id: string; dir: string; localBucket?: boolean }>;
  restoreBackup(backup: { id: string; dir: string; localBucket?: boolean }): Promise<unknown>;
};

/**
 * "This boot has been reconciled with the session's backup" — the sentinel
 * that makes restore run exactly once per container LIFE, not once per
 * submission. Load-bearing for warm containers: restore is an `unsquashfs -f`
 * merge, so re-running it on a warm workspace would overwrite files edited
 * since the backup with their older archived content. Always touched, even
 * when there is no backup to restore, the restore failed, or the R2 feature
 * is off — retrying a dead backup id on every submission would just spam the
 * log, and the marker doubles as the lazy env's reset probe ("is this still
 * the container we provisioned?"), which must work regardless of the backup
 * feature gate. Excluded from every archive (BACKUP_EXCLUDES), or a restored
 * workspace would look already-reconciled on the NEXT cold boot.
 */
export const RESTORE_MARKER = '/workspace/.restored';

// ---------------------------------------------------------------------------
// Touched-registry — the usage.ts pattern verbatim: an isolate-local mark set
// by provisionWorkspace (which the lazy env calls only when an op genuinely
// needs the container) and drained by the response-finish hook. A mark lost
// to isolate eviction merely skips one backup and self-heals on the next
// touched turn; a mark from an aborted submission folds into the next
// response's drain, which then backs up whatever that turn left behind.
// ---------------------------------------------------------------------------

const touchedByInstance = new Map<string, true>();

/** Record that this conversation's submission booted/used the container. */
export function markWorkspaceTouched(instanceId: string): void {
  touchedByInstance.set(instanceId, true);
  // Bound isolate memory (mirrors usage.ts): entries linger only for sessions
  // that die between a touch and their response finish.
  if (touchedByInstance.size > 500) {
    const oldest = touchedByInstance.keys().next().value;
    if (oldest !== undefined) touchedByInstance.delete(oldest);
  }
}

/** Read-and-clear the touch mark for one agent instance. */
export function drainWorkspaceTouched(instanceId: string): boolean {
  const touched = touchedByInstance.has(instanceId);
  touchedByInstance.delete(instanceId);
  return touched;
}

/**
 * Cold-boot restore, called from provisionWorkspace BEFORE skill
 * provisioning (restored files must be on disk before the agent's first
 * read; `.agents` is excluded from archives, so the skills sentinel is
 * untouched either way). One marker exec on every touched submission; the
 * restore RPC only on a genuinely cold container with a recorded backup.
 * Never throws.
 */
export async function restoreWorkspaceBackup(
  sandbox: BackupSandbox,
  env: BackupEnv,
  record: Record<string, unknown> | null,
): Promise<void> {
  try {
    const probe = await sandbox.exec(`[ -e '${RESTORE_MARKER}' ] && echo restore:present || echo restore:absent`);
    if ((probe.stdout ?? '').includes('restore:present')) return;

    const node = record?.session_backup as { backup_id?: unknown } | undefined;
    const backupId = typeof node?.backup_id === 'string' && node.backup_id ? node.backup_id : undefined;
    // Feature off (no BACKUP_BUCKET): nothing to restore, but the marker is
    // still armed below — it is also the reset probe.
    if (backupId && env.BACKUP_BUCKET) {
      try {
        await sandbox.restoreBackup({ id: backupId, dir: '/workspace', localBucket: true });
        console.log(`backup: restored ${backupId} into /workspace`);
      } catch (err) {
        // Not-found/expired/misconfigured: continue cold rather than fail the
        // turn — the workspace simply starts empty, as it does today.
        console.log(`backup: restore of ${backupId} failed, continuing cold: ${String(err).slice(0, 200)}`);
      }
    }
    await sandbox.exec(`touch '${RESTORE_MARKER}'`);
  } catch (err) {
    console.log(`backup: restore protocol failed: ${String(err).slice(0, 200)}`);
  }
}

/** What persistWorkspaceBackup did — returned to the admin oracle route. */
export type PersistOutcome = {
  status: 'unconfigured' | 'session-gone' | 'unreconciled' | 'persisted' | 'error';
  backupId?: string;
  sizeBytes?: number;
  backupCount?: number;
};

export type PersistOptions = {
  env: BackupEnv;
  namespace: DurableObjectNamespace;
  sessionId: string;
};

/**
 * Persist: archive /workspace into a NEW backup, record it on the session,
 * then supersede the previous one. Reads the record FIRST — a
 * deleted/expired session gets no backup at all (early-exit), and the
 * previous backup id + count come from the same read. If the session
 * disappears between createBackup and the merge (mergeExistingSessionRecord
 * never resurrects), the fresh backup is deleted on the spot — requirement
 * (2) has no window in which a dead session accretes storage.
 *
 * Marker guard: the archive is only taken from a container that carries
 * RESTORE_MARKER, i.e. one that restoreWorkspaceBackup has reconciled with
 * the session's archive during THIS container life. A marker-less container
 * is a fresh disk (reset mid-turn, or a persist requested before any
 * provisioning) — archiving it would supersede the good backup with an empty
 * one, so the call returns 'unreconciled' and touches nothing. Callers that
 * legitimately start cold (the admin oracle) run restoreWorkspaceBackup first.
 * Never throws.
 *
 * Prefer requestWorkspacePersist over calling this directly: it serializes
 * and coalesces per session, which the read-create-merge-delete sequence
 * needs (two interleaved persists both delete the same prevId and orphan one
 * archive — sweep-recoverable, but pure waste).
 */
export async function persistWorkspaceBackup(options: PersistOptions): Promise<PersistOutcome> {
  const { env, namespace, sessionId } = options;
  if (!env.BACKUP_BUCKET) return { status: 'unconfigured' };
  try {
    const record = await readSession(env.STORE, sessionId);
    if (!record) return { status: 'session-gone' };
    const prev = record.session_backup as { backup_id?: unknown; backup_count?: unknown } | undefined;
    const prevId = typeof prev?.backup_id === 'string' ? prev.backup_id : undefined;
    const backupCount = (Number(prev?.backup_count) || 0) + 1;

    const sandbox = getSandbox(namespace, sandboxNameForSession(sessionId)) as unknown as BackupSandbox;
    const probe = await sandbox.exec(`[ -e '${RESTORE_MARKER}' ] && echo restore:present || echo restore:absent`);
    if (!(probe.stdout ?? '').includes('restore:present')) {
      console.log(`backup: persist for ${sessionId} skipped — container not reconciled (marker absent), keeping ${prevId ?? 'no'} backup`);
      return { status: 'unreconciled', ...(prevId ? { backupId: prevId } : {}) };
    }
    const handle = await sandbox.createBackup({
      dir: '/workspace',
      // meta.name = the FULL session id — the join every consumer (sweep,
      // admin browser) relies on. Session ids are ≤128 chars, the SDK caps
      // names at 256.
      name: sessionId,
      ttl: BACKUP_TTL_SECONDS,
      excludes: [...BACKUP_EXCLUDES],
      localBucket: true,
    });

    // The returned handle carries no size; meta.json does (one Class B read).
    let sizeBytes: number | null = null;
    try {
      const metaObj = await env.BACKUP_BUCKET.get(backupKeys(handle.id).meta);
      const meta = metaObj ? (JSON.parse(await metaObj.text()) as { sizeBytes?: unknown }) : null;
      if (typeof meta?.sizeBytes === 'number') sizeBytes = meta.sizeBytes;
    } catch {
      // Size stays null — the node is still written; the sweep keys on ids,
      // never on size.
    }

    const merged = await mergeExistingSessionRecord(env.STORE, sessionId, {
      // snake_case to sit alongside session_state/session_sandbox.
      session_backup: {
        backup_id: handle.id,
        size_bytes: sizeBytes,
        backup_count: backupCount,
        last_backup_at: new Date().toISOString(),
        storage_monthly_usd: backupStorageMonthlyUsd(sizeBytes),
      },
    });
    if (!merged) {
      // Session torn down mid-persist: the new backup is an instant orphan.
      await deleteBackup(env.BACKUP_BUCKET, handle.id).catch(() => {});
      console.log(`backup: session ${sessionId} vanished mid-persist — removed fresh backup ${handle.id}`);
      return { status: 'session-gone', backupId: handle.id };
    }
    if (prevId && prevId !== handle.id) {
      // Supersede: keep exactly one backup per session. Best-effort — a
      // missed delete is caught by sweep rule (b).
      await deleteBackup(env.BACKUP_BUCKET, prevId).catch(() => {});
    }
    console.log(`backup: persisted ${handle.id} for ${sessionId} (${sizeBytes ?? '?'} bytes, #${backupCount})`);
    return { status: 'persisted', backupId: handle.id, sizeBytes: sizeBytes ?? undefined, backupCount };
  } catch (err) {
    console.log(`backup: persist for ${sessionId} failed: ${String(err).slice(0, 300)}`);
    return { status: 'error' };
  }
}

// ---------------------------------------------------------------------------
// Per-session persist scheduler: single-flight + coalescing + spacing.
//
// A turn fires a persist request after every mutating container op, and the
// upload route / turn-end hook add theirs. Running each one would (a) stack
// mksquashfs + control-channel uploads on the container, (b) interleave the
// read-create-merge-delete sequence (both delete the same prevId), and (c)
// hammer the session record — KV allows ONE write per second per key. So:
// while a persist is in flight for a session, further requests only set a
// `pending` flag; when it finishes, at most ONE more run follows (which by
// construction captures every mutation the coalesced requests were about),
// spaced PERSIST_MIN_SPACING_MS from the previous START so the KV write rate
// stays under the limit. Isolate-local, like the touched-registry: an
// evicted entry loses nothing but the pending re-run, and the next request
// (or the turn-end persist) heals it.
// ---------------------------------------------------------------------------

/** Minimum gap between two persist starts for one session (KV: 1 write/s/key). */
export const PERSIST_MIN_SPACING_MS = 1500;

type PersistState = { run: Promise<PersistOutcome>; pending: boolean; startedAt: number };
const persistBySession = new Map<string, PersistState>();

/**
 * Read-only: is a persist (marker exec + mksquashfs + upload) running for
 * this session right now? The task tools stamp it into their timing log line
 * (tasks.ts) so a slow task op can be told apart from a persist-contended one.
 */
export const isPersistInFlight = (sessionId: string): boolean => persistBySession.has(sessionId);

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Request a persist for a session; returns a promise for the run that will
 * cover this request (the in-flight one's follow-up when coalesced). Never
 * rejects — persistWorkspaceBackup never throws.
 */
export function requestWorkspacePersist(options: PersistOptions): Promise<PersistOutcome> {
  const key = options.sessionId;
  const current = persistBySession.get(key);
  if (current) {
    current.pending = true;
    return current.run;
  }
  const state: PersistState = { run: Promise.resolve({ status: 'error' }), pending: false, startedAt: Date.now() };
  persistBySession.set(key, state);
  state.run = (async () => {
    let outcome: PersistOutcome = { status: 'error' };
    // Bounded: each iteration only happens because a request arrived DURING
    // the previous run; once a run completes with nothing pending we stop.
    for (;;) {
      state.pending = false;
      state.startedAt = Date.now();
      outcome = await persistWorkspaceBackup(options);
      if (!state.pending) break;
      const wait = PERSIST_MIN_SPACING_MS - (Date.now() - state.startedAt);
      if (wait > 0) await sleep(wait);
    }
    persistBySession.delete(key);
    return outcome;
  })();
  return state.run;
}

/**
 * The cron body (cloudflare.ts `scheduled`) and the POST /admin/backups/sweep
 * oracle: delete backups whose session is over. Sessions expire silently (24 h
 * KV TTL — no event), so this hourly sweep is what makes requirement (2) hold
 * for them; explicit deletes (supersede + DELETE /sessions/:id) already cover
 * the loud paths. Rules live in core/src/backup.js.
 */
export async function sweepExpiredBackups(
  env: BackupEnv,
): Promise<{ scanned: number; deleted: number; kept: number } | { status: 'unconfigured' }> {
  if (!env.BACKUP_BUCKET) return { status: 'unconfigured' };
  const counts = await sweepOrphanedBackups(env.BACKUP_BUCKET, env.STORE);
  console.log(`backup: sweep scanned=${counts.scanned} deleted=${counts.deleted} kept=${counts.kept}`);
  return counts;
}
