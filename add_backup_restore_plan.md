# Plan: Workspace backup/restore via Sandbox SDK + R2

Status: **approved, in implementation** (2026-08-05). Independent of `add_artifacts_plan.md`.

## Context

Sandbox containers lose all files at the 10-min idle sleep (`@cloudflare/sandbox` default
`sleepAfter`, never overridden here); the agent's work product under `/workspace/semantius/`
is destroyed. `@cloudflare/sandbox` **0.12.3 — the exact version already pinned — ships GA
`createBackup`/`restoreBackup`** (squashfs archives in your own R2 bucket). In
`localBucket: true` mode (verified in the SDK source: no local-dev restriction — the DO
streams bytes over its control channel and talks to R2 via a binding) this needs **no
container egress, no R2 secrets, no whitelist or Dockerfile changes** — just one R2 bucket
and a `BACKUP_BUCKET` binding.

Requirements: (1) pricing as a new per-session field, (2) R2 deleted when the session ends,
(3) /admin can browse R2.

## Design

- **One backup per session, superseded each turn.** Restore hooks into
  `provisionWorkspace()` (runs once per submission at the first container-touching op);
  persist is fire-and-forget in `useResponseFinish`, gated on a touched-registry
  (`usage.ts` pattern) so chat-only turns never boot a container. Flue has no sandbox
  lifecycle hooks — these two seams are the working equivalent.
- **Marker protocol** (prevents re-restore clobbering a warm workspace): one exec checks
  `[ -e /workspace/.restored ]`; if absent → `restoreBackup({id, dir:'/workspace',
  localBucket:true})` when the record has `session_backup.backup_id` (catch
  not-found/expired → log, continue) → **always** `touch /workspace/.restored`. Restore
  runs before skill provisioning; `unsquashfs -f` merge semantics.
- **Persist**: read record first (early-exit if session gone; learn previous id + count) →
  `createBackup({dir:'/workspace', name: sessionId, ttl: 30d, excludes:
  ['.agents','.tmp_admin','.tmp_deploy','.restored'], localBucket:true})` → read
  `backups/<id>/meta.json` via the worker-side binding for `sizeBytes` →
  `mergeExistingSessionRecord` (never resurrects; if it returns null, delete the
  just-created backup) → best-effort delete previous backup objects. Never throws;
  `backup:` log breadcrumbs.
- **Feature gate**: `env.BACKUP_BUCKET` absent → everything off, zero behavior change.

### Requirement 1 — per-session pricing field

`session_backup` node on the KV session record:
`{ backup_id, size_bytes, backup_count, last_backup_at, storage_monthly_usd }`.
Rates in `core/src/cost.js` (`R2_RATES`: storage $0.015/GB-mo, Class A $4.50/M, Class B
$0.36/M; free tier 10 GB / 1M / 10M; deletes free) + `BACKUP_COST_BASIS` honesty string
(run-rate estimate at list price, allowance not deducted). `/admin/costs` rows gain
`backup_size_bytes` / `backup_count` / `backup_monthly_usd` (rides the session-record read
the enrichment already does — no new GraphQL) + `backupMonthlyTotal`; the Costs tab gains
two columns (Backup MB, Backup $/mo), never summed with the other two money columns.

### Requirement 2 — R2 deleted when session ends

Three mechanisms: **(i) supersede-delete** — each new backup deletes the previous one
(deletes are free); **(ii) `DELETE /sessions/:id`** reads the record BEFORE its three KV
deletes, then best-effort deletes the backup objects; **(iii) hourly cron sweep** for
24h-TTL-expired sessions — `triggers.crons: ['17 * * * *']` + `export default
{ scheduled }` in `cloudflare.ts` (verified: the @flue/vite entry spreads cloudflare.ts's
default export into the worker handlers; `flueWorkerConfig` passes `triggers`/`r2_buckets`
through untouched). Sweep rules, each gated on `meta.createdAt` older than a 1 h grace:
(a) session record for `meta.name` absent → delete (no `isValidSessionId` pre-gate —
channel ids fail the RE but have real records); (b) record exists but
`session_backup.backup_id !== meta.id` → delete (superseded orphan, e.g. a failed
supersede-delete); (c) TTL elapsed, or null/unparseable meta → delete; (d) archives with
no sibling meta.json, older than grace by R2 upload time → delete. Returns
`{scanned, deleted, kept}`.

### Requirement 3 — /admin browses R2

Third collection `backups` in the existing generic data browser: `adminCollections()`
entry + `listCollectionRecords`/`readCollectionRecord` branches over a minimal structural
`R2Like` dep (core stays Cloudflare-type-free); `adminDeps` in app.ts becomes `{kv, r2}` —
the three collection routes and the frontend list views need zero further changes. Detail
view kind `'backup'` (meta + sessionExists + cost estimate) + authenticated-fetch Download
of `data.sqsh`. Plus REST routes: `GET /admin/backups`, `DELETE /admin/backups/:id`,
`GET /admin/backups/:id/archive`, `POST /admin/backups/sweep` (manual oracle),
`POST /admin/sessions/:id/backup {action: backup|restore|status}` (the restore action
`rm -f`s the marker first so the replay is deterministic).

## Implementation steps

1. `core/src/backup.js` (new): `R2Like` typedef, `BACKUP_PREFIX='backups/'`,
   `BACKUP_EXCLUDES`, `BACKUP_TTL_SECONDS=30d`, `backupKeys(id)`, `listBackups(r2)`
   (paginated list → meta.json reads, newest-first, malformed-tolerant),
   `deleteBackup(r2,id)`, `sweepOrphanedBackups(r2,kv,{graceMs,now})` rules (a)–(d).
2. `core/src/cost.js`: `R2_RATES`, `R2_INCLUDED_MONTHLY`, `BACKUP_COST_BASIS`,
   `backupStorageMonthlyUsd`, `backupOpsUsd` (~2 Class A + 2 Class B per backup, stated
   as estimate).
3. `core/src/admin.js`: `backups` collection entry + record/detail branches
   (unconfigured → `{records:[], note}`).
4. `core/src/index.js`: export the new symbols.
5. `scripts/admin.test.mjs`: `fakeR2`; the `'kv,sessions'` descriptor assertion becomes
   `'kv,sessions,backups'`; sections for collection list/read, sweep scenarios
   (live-kept, young-orphan-kept; session-gone / superseded / ttl / null-name / meta-less
   archive deleted; malformed meta tolerated), cost math. `pnpm test` green before
   backend work.
6. `backend-b/src/backups.ts` (new): touched-registry
   (`markWorkspaceTouched`/`drainWorkspaceTouched`), `restoreWorkspaceBackup(sandbox,
   record)` (marker protocol; sandbox typed as a minimal structural interface),
   `persistWorkspaceBackup({env, namespace, sessionId, store})`,
   `sweepExpiredBackups(env)`; own `BackupEnv = { STORE, BACKUP_BUCKET? }`.
7. `backend-b/src/cloudflare.ts`: `Env = CostEnv & { BACKUP_BUCKET?: R2Bucket }`;
   `export default { scheduled }` (no existing default export; must not define fetch).
8. `backend-b/src/agents/main.ts`: hoist `namespace` above `useResponseFinish`; drain +
   fire-and-forget persist after `maybeGenerateTitle`; in `provisionWorkspace` hoist the
   existing `readSession`, mark touched, restore before `provisionAgentSkills` (update
   the order-matters comment — the marker exec now creates the container session).
9. `backend-b/src/app.ts`: Env + `adminDeps {kv, r2}`; DELETE /sessions/:id
   read-record-first + best-effort backup delete (KV delete order preserved: pointer
   first); the five new admin routes (under the existing `/admin/*` guard; UUID-check
   backup ids).
10. `backend-b/src/costs.ts`: row enrichment from `record.session_backup` +
    `backupMonthlyTotal`; `/admin/costs` response gains `r2Rates`/`backupBasis`.
11. `frontend/src/App.tsx`: CostRow/Costs types, two new columns
    (thead/tbody/unlabeled/tfoot, colSpan 9→11), basis note; `Detail` union + `'backup'`
    branch with authenticated-fetch → blob Download.
12. `backend-b/wrangler.jsonc`: `r2_buckets: [{binding:'BACKUP_BUCKET',
    bucket_name:'semantius-copilot-backups'}]` + `triggers: {crons:['17 * * * *']}`.
13. `scripts/acceptance.mjs`: backup block (skip-with-NOTE when unconfigured): 401s;
    forced backup → `session_backup` node; second backup → old id gone (supersede
    oracle); restore replay; archive 200; DELETE session → id absent from list
    (requirement-2 oracle); sweep returns counts.
14. `README.md`: "Workspace backup & restore" section; `session_backup` channel block;
    Costs-tab columns; Data-browser collection; update the DELETE sentence.
15. One-time infra + deploy + verification below.

## Verification (deployed workers.dev; no local dev per CLAUDE.md)

1. `pnpm test` green.
2. `wrangler r2 bucket create semantius-copilot-backups` **before** deploy (deploy
   validates the binding).
3. `pnpm deploy:b && pnpm deploy:frontend`.
4. Deployed checks: 401 without key; empty list; create session →
   `POST /admin/sessions/:id/backup {action:'backup'}` → record shows `session_backup`;
   list shows it; archive downloads; restore replay ok; second backup supersedes;
   `DELETE /sessions/:id` → list empty; sweep returns counts.
5. `pnpm acceptance` full suite green.
6. End-to-end: agent writes a file, wait >10 min (real sleep), new message reads it back
   (watch `backup:` breadcrumbs in `pnpm logs`).
7. Cron visible in dashboard Triggers; sweep breadcrumb in logs after the next :17.
8. Costs tab renders 11 columns; data browser shows backups; Download works.

## Risks (accepted, documented)

- Restore on the non-rpc transport buffers the archive ~×2.33 in DO memory → soft ceiling
  ~50 MB/archive; excludes keep workspaces KB–MB; `size_bytes` is surfaced everywhere so
  growth is visible. Create throughput ~0.6 MB/s over the control channel
  (fire-and-forget — users never wait on it).
- Aborted turns (no response finish) lose that turn's delta if the container then sleeps —
  best-effort posture, same as every mirror in this codebase; the next touched turn backs
  up whatever survived.
- KV has no CAS: a rare persist/mirror interleave self-heals at the next response finish;
  R2 orphans from any interleaving are bounded by sweep rules (a)/(b).
- `localBucket` is comment-labeled "local-dev" in the SDK but verified to run identically
  in production; the SDK version is exact-pinned at 0.12.3.
- First deploy must positively confirm the cron fires (new surface through the flue-vite
  entry).
