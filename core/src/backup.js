/**
 * Workspace backup/restore helpers (host-agnostic) — the R2 side of the
 * sandbox backup feature (add_backup_restore_plan.md).
 *
 * The @cloudflare/sandbox SDK (0.12.3, localBucket mode) writes each backup as
 * two objects in the BACKUP_BUCKET:
 *
 *   backups/<uuid>/data.sqsh   the squashfs archive
 *   backups/<uuid>/meta.json   { id, dir, name, sizeBytes, ttl, createdAt }
 *
 * `name` is set by the caller to the FULL session id (persistWorkspaceBackup,
 * backend-b/src/backups.ts), which makes the bucket self-describing: every
 * consumer here joins backup -> session through meta.name, never through a
 * separate index. The SDK has NO list/delete API and NO auto-GC — expired
 * backups stay in R2 until we delete them — so listing, deletion, and the
 * orphan sweep live here, over a minimal structural R2 shape.
 *
 * This file is pure logic over R2Like/KvLike; the Cloudflare bindings are
 * injected by backend-b (app.ts adminDeps, backups.ts, the cron handler).
 *
 * @typedef {Object} R2Like  the slice of an R2 bucket binding we use
 * @property {(options?: { prefix?: string, cursor?: string }) => Promise<{ objects: Array<{ key: string, size?: number, uploaded?: Date | string }>, truncated: boolean, cursor?: string }>} list
 * @property {(key: string) => Promise<{ text(): Promise<string> } | null>} get
 * @property {(key: string) => Promise<void>} delete
 */

export const BACKUP_PREFIX = 'backups/';

/**
 * mksquashfs wildcard patterns (NOT globs — `**` is unsupported) excluded from
 * every workspace backup, relative to /workspace:
 *  - `.agents`     skills are bundle-sourced (KV) and re-provisioned on boot;
 *                  backing them up would break provisionAgentSkills' absent→
 *                  write sentinel semantics.
 *  - `.tmp_admin`, `.tmp_deploy`   the semantius agents' documented scratch
 *                  dirs — ephemeral by design.
 *  - `.restored`   the restore marker (see backend-b/src/backups.ts); it must
 *                  never travel inside an archive or a restored workspace
 *                  would look already-reconciled on the NEXT cold boot.
 */
export const BACKUP_EXCLUDES = ['.agents', '.tmp_admin', '.tmp_deploy', '.restored'];

/**
 * SDK-side ttl (checked only at restore time — no auto-GC). Generous on
 * purpose: the real lifetime is governed by the session lifecycle (supersede
 * delete + DELETE route + sweep), and a session's 24 h KV TTL refreshes on
 * every merge, so a long-lived active session must never find its own backup
 * refused at restore.
 */
export const BACKUP_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * Sweep grace: backups younger than this are never touched, whatever their
 * state — it covers the createBackup → session-record-merge window of an
 * in-flight persist (seconds-to-minutes at the control channel's ~0.6 MB/s).
 */
export const BACKUP_SWEEP_GRACE_MS = 60 * 60 * 1000;

/**
 * Same cycle-avoidance duplication as admin.js's container-pointer prefix:
 * admin.js imports THIS module for the backups collection, so importing
 * SESSION_KEY_PREFIX back from admin.js would make the core graph circular.
 */
const SESSION_KEY_PREFIX = 'session:';

/** The two R2 keys of one backup. */
export function backupKeys(id) {
  return {
    archive: `${BACKUP_PREFIX}${id}/data.sqsh`,
    meta: `${BACKUP_PREFIX}${id}/meta.json`,
  };
}

/** Delete both objects of one backup (R2 deletes are free and idempotent). */
export async function deleteBackup(r2, id) {
  const keys = backupKeys(id);
  await r2.delete(keys.archive);
  await r2.delete(keys.meta);
}

/**
 * Enumerate every backup in the bucket, newest first.
 *
 * One paginated list over `backups/`, then one meta.json read per backup —
 * the same accepted N-reads cost as listSessions (admin.js). Rows are
 * tolerant: a backup whose meta.json is missing (half-written or
 * half-deleted) or unparseable still appears, flagged, with the archive's
 * object size and upload time standing in — the sweep and the admin browser
 * must SEE strays, not skip them.
 *
 * @param {R2Like} r2
 * @returns {Promise<Array<{ id: string, name: string | null, dir: string | null,
 *   sizeBytes: number | null, ttl: number | null, createdAt: string | null,
 *   uploaded: string | null, metaMissing?: boolean, malformed?: boolean }>>}
 */
export async function listBackups(r2) {
  /** @type {Map<string, { hasMeta: boolean, archiveSize: number | null, uploaded: string | null }>} */
  const seen = new Map();
  let cursor;
  // Bounded pagination guard, mirroring listKvEntries.
  for (let page = 0; page < 1000; page++) {
    const res = await r2.list({ prefix: BACKUP_PREFIX, ...(cursor ? { cursor } : {}) });
    for (const obj of res.objects ?? []) {
      const rest = obj.key.slice(BACKUP_PREFIX.length);
      const slash = rest.indexOf('/');
      if (slash <= 0) continue; // not backups/<id>/<object>
      const id = rest.slice(0, slash);
      const leaf = rest.slice(slash + 1);
      const entry = seen.get(id) ?? { hasMeta: false, archiveSize: null, uploaded: null };
      if (leaf === 'meta.json') entry.hasMeta = true;
      if (leaf === 'data.sqsh') {
        entry.archiveSize = typeof obj.size === 'number' ? obj.size : null;
        entry.uploaded = obj.uploaded ? new Date(obj.uploaded).toISOString() : null;
      }
      seen.set(id, entry);
    }
    if (!res.truncated || !res.cursor) break;
    cursor = res.cursor;
  }

  const rows = [];
  for (const [id, entry] of seen) {
    if (!entry.hasMeta) {
      rows.push({
        id, name: null, dir: null, sizeBytes: entry.archiveSize, ttl: null,
        createdAt: null, uploaded: entry.uploaded, metaMissing: true,
      });
      continue;
    }
    const metaObj = await r2.get(backupKeys(id).meta);
    let meta = null;
    try {
      meta = metaObj ? JSON.parse(await metaObj.text()) : null;
    } catch {
      meta = null;
    }
    if (!meta || typeof meta !== 'object') {
      rows.push({
        id, name: null, dir: null, sizeBytes: entry.archiveSize, ttl: null,
        createdAt: null, uploaded: entry.uploaded, malformed: true,
      });
      continue;
    }
    rows.push({
      id,
      name: typeof meta.name === 'string' && meta.name ? meta.name : null,
      dir: typeof meta.dir === 'string' ? meta.dir : null,
      sizeBytes: typeof meta.sizeBytes === 'number' ? meta.sizeBytes : entry.archiveSize,
      ttl: typeof meta.ttl === 'number' ? meta.ttl : null,
      createdAt: typeof meta.createdAt === 'string' ? meta.createdAt : null,
      uploaded: entry.uploaded,
    });
  }

  // Newest first by createdAt (upload time as fallback), undated last, then id
  // — the same ordering contract the sessions collection follows.
  rows.sort((a, b) => {
    const ta = a.createdAt ?? a.uploaded ?? '';
    const tb = b.createdAt ?? b.uploaded ?? '';
    if (ta && tb && ta !== tb) return tb.localeCompare(ta);
    if (ta && !tb) return -1;
    if (!ta && tb) return 1;
    return a.id.localeCompare(b.id);
  });
  return rows;
}

/**
 * Garbage-collect backups whose session is over — requirement (2)'s net.
 * Explicit deletes (supersede + the DELETE route) are the first line; this
 * sweep is what ties R2 lifetime to the 24 h session TTL, which expires
 * silently with no event to hook.
 *
 * Every rule is gated on the backup being older than `graceMs` (by
 * meta.createdAt, falling back to the archive's upload time), so an in-flight
 * persist is never raced. Rules, in order:
 *  (a) session record for meta.name absent  -> delete (session expired or a
 *      DELETE whose R2 half failed). Deliberately NO isValidSessionId
 *      pre-gate: channel conversation ids fail the minted-id RE but have
 *      real session records.
 *  (b) record exists but its session_backup.backup_id names a DIFFERENT
 *      backup -> delete (superseded orphan: a failed supersede-delete or a
 *      persist whose record merge never landed). An unreadable record keeps
 *      its backups (conservative).
 *  (c) meta.json missing/unparseable, no name, or SDK ttl elapsed -> delete
 *      (strays in a bucket only this system writes).
 *
 * @param {R2Like} r2
 * @param {{ get(k: string): Promise<string | null> }} kv
 * @param {{ graceMs?: number, now?: number }} [options] `now` injectable for tests
 * @returns {Promise<{ scanned: number, deleted: number, kept: number }>}
 */
export async function sweepOrphanedBackups(r2, kv, options = {}) {
  const graceMs = options.graceMs ?? BACKUP_SWEEP_GRACE_MS;
  const now = options.now ?? Date.now();
  const rows = await listBackups(r2);

  let deleted = 0;
  let kept = 0;
  for (const row of rows) {
    const born = Date.parse(row.createdAt ?? row.uploaded ?? '');
    // Undatable rows (no meta, no upload time — only possible with a fake R2
    // that omits `uploaded`) count as old: only this system writes here.
    const oldEnough = !Number.isFinite(born) || born + graceMs < now;
    if (!oldEnough) {
      kept++;
      continue;
    }

    let remove = false;
    if (row.metaMissing || row.malformed || !row.name) {
      remove = true; // rule (c): stray
    } else {
      const raw = await kv.get(SESSION_KEY_PREFIX + row.name);
      if (raw === null || raw === undefined) {
        remove = true; // rule (a): session gone
      } else {
        let record = null;
        try {
          record = JSON.parse(raw);
        } catch {
          record = null; // unreadable record: keep (conservative)
        }
        const currentId = record?.session_backup?.backup_id;
        if (record && currentId !== row.id) remove = true; // rule (b): superseded
      }
    }
    // rule (c) continued: SDK ttl elapsed — a restore would refuse it anyway.
    if (!remove && typeof row.ttl === 'number' && row.createdAt) {
      const expiresAt = Date.parse(row.createdAt) + row.ttl * 1000;
      if (Number.isFinite(expiresAt) && expiresAt < now) remove = true;
    }

    if (remove) {
      await deleteBackup(r2, row.id);
      deleted++;
    } else {
      kept++;
    }
  }
  return { scanned: rows.length, deleted, kept };
}
