# Plan: Cloudflare Artifacts — workspace persistence + per-session cost tracking

Status: **proposed** (plan only, nothing implemented). Researched 2026-08-05 against
flueframework.com docs, developers.cloudflare.com/artifacts, and this repo.

## ⚠ Blocker to know first

**Cloudflare Artifacts is in closed beta.** Access must be requested via Cloudflare's
form (developers.cloudflare.com/artifacts → "request access"), and it requires the
Workers Paid plan. Until access is granted the `artifacts` wrangler binding cannot be
used — so this plan is built **flag-gated**: it deploys safely today with the feature
off (no binding → zero behavior change), and turns on by uncommenting one wrangler
block + setting two vars once the grant lands.

## Findings (the three questions)

### 1. Do we lose all files when the sandbox stops? — Yes, verified

- No `sleepAfter` override anywhere; the `@cloudflare/sandbox` 0.12.3 default applies:
  **`sleepAfter = "10m"`**. Container disk resets to the Docker image on sleep or
  eviction (already documented in `semantius-copilot-plan.md` §8: "Container disk is
  ephemeral").
- Nothing reads files back out of the sandbox: no R2/D1, no snapshot/tarball export, no
  git push, no download route. `core/src/tar.js` is write-direction only (Worker → sandbox).
- What survives today: the KV agent bundle (skills, re-extracted on cold boot by
  `provisionWorkspace()`), the DO conversation transcript, and `session_data` — all
  expiring 24 h after last activity. What does **not** survive: everything the agent
  writes under `/workspace` — `semantius/blueprints/*.md`, `semantius/specs/*.md`,
  `semantius/<org>/customizations.yaml`, diagnostic logs.
- The shipped skills (`semantius-admin`, `semantius-analyst`, …) were authored for a
  **persistent git working tree** ("git is the audit log", "the user's design artifacts
  and their git working tree"). That assumption is currently false in the sandbox.
  Artifacts makes it true.

### 2. Does Flue support artifacts? — No

Verified across the Flue docs (ecosystem/sandboxes/cloudflare, reference/agent-api,
guide/sandboxes, reference/sandbox-api, reference/data-persistence-api): **no artifact,
overlay-FS, or workspace-persistence support**. Flue's position is explicit: the sandbox
adapter is deliberately thin — "Flue only connects to what you hand it and never
destroys provider infrastructure"; durable workspaces are the application's job inside
the sandbox factory. Flue's Data Persistence API covers conversation streams,
submissions, and attachments only.

That is not a problem: Cloudflare documents the integration one level down, exactly
where this repo already customizes provisioning —
[Sandbox SDK + Artifacts](https://developers.cloudflare.com/artifacts/examples/sandbox-sdk-artifacts/)
(`env.ARTIFACTS` Workers binding + git-over-HTTPS from inside the sandbox; template
`git-repo-per-sandbox`). Our `provisionWorkspace()` seam is the right home.

(Minor, unrelated: Flue renamed the factory method `createSessionEnv` → `createSandbox`;
ours still uses the deprecated name. Works, logs a deprecation warning.)

### 3. Cloudflare Artifacts facts (for the plan)

- Versioned file trees behind a git-compatible interface; addressable from Workers
  binding, REST API, and any git client.
- Binding API: `env.ARTIFACTS.create(name)` → `{name, remote, defaultBranch, token}`;
  `.get(name)` → repo handle with `.createToken('read'|'write', ttlSeconds)` →
  `{plaintext, expiresAt}`, `.log()`, `.readCommit()`, `.readTree()`; `.delete(name)`,
  `.list()`. Wrangler: `"artifacts": [{ "binding": "ARTIFACTS", "namespace": "<ns>" }]`.
- Naming: start with letter/digit; then letters, digits, `.`, `_`, `-`. Limits:
  10 GB/repo, 1 TB/account, 2 000 req/10 s.
- **Pricing** (Workers Paid): operations (create/push/pull/clone) — first 10 000/mo
  included, then $0.15/1 000; storage — first 1 GB-mo included, then $0.50/GB-mo
  (account-wide, averaged daily peak). Repos persist until explicitly deleted.
- **Observability**: GraphQL dataset `artifactsEventsAdaptiveGroups` — dimensions
  `repositoryNamespace`, `repositoryName`, `eventKind`, `eventType`, datetime;
  metrics `count`, `durationMs` aggregates. **No per-repo storage metric, no labels.**
- ArtifactFS (FUSE lazy-hydration mount) exists but is for big repos; Cloudflare's own
  guidance: "for smaller repos, a regular git clone is usually simpler". Our workspace
  is small markdown/yaml → plain clone.

## Design

One Artifacts **repo per session**, named `sandboxNameForSession(id)` — the same
derivation as the container name/label. That makes the GraphQL `repositoryName`
dimension join to sessions through the **existing** cost-enrichment path
(`idFromName(label)` → KV `container:` pointer → full session id, `backend-b/src/costs.ts`)
with zero new join machinery. Repo root = `/workspace`, with a committed `.gitignore`
for `.agents/`, `.tmp_admin/`, `.tmp_deploy/` (skills are provisioned from KV, never
committed).

- **Restore** (cold boot): in `provisionWorkspace()` (`backend-b/src/agents/main.ts`),
  before skill provisioning: create-or-get repo, mint ~5-min write token, exec a
  sentinel-gated script — `/workspace/.git` present → no-op; else `git init` +
  `git fetch <authenticated-remote>` + `reset --hard FETCH_HEAD` (empty repo on first
  session → seeded). Clean remote URL only in `.git/config`; tokenized URL never stored.
- **Persist** (turn end): in `useResponseFinish` (same file), fire-and-forget like the
  existing KV mirror/title calls: only if this submission actually touched the container
  (module-level touched-registry marked by `provisionWorkspace`, the `usage.ts` pattern
  — chat-only turns never boot a container just to commit), exec
  `git add -A && commit && push <fresh-token-remote>`, then merge a durable
  `session_artifacts` node onto the KV session record via `mergeExistingSessionRecord`
  (never resurrects deleted sessions):
  `{ repo, branch, push_count, last_push_at, repo_bytes, restore_status, restored_at }`.
  `onStop` is too late (filesystem already gone) — turn-end is the correct trigger.
- **Egress**: sandbox has `enableInternet=false` + intercepted HTTPS with a per-session
  host whitelist. Add the artifacts git host via one shared helper
  `withArtifactsHost(whitelist, env)` applied at **all three** whitelist-writing sites
  (ingest, `useAgentStart`, skill-check) so `ensureEgressPolicy`'s stringify-compare
  never flaps. `brokerEgress` already forwards whitelisted, sentinel-free requests
  headers-intact, so git's standard 401 → Basic-auth retry works unchanged. `git` is in
  the image and already trusts the interceptor CA (`Dockerfile` `GIT_SSL_CAINFO`).
- **Feature gate**, three states:
  - **OFF** — no `ARTIFACTS` binding (wrangler block stays commented; wrangler
    `^4.113.0` may not know the key yet). All paths no-op; `/admin/costs` reports
    `artifacts: {configured:false, reason}`.
  - **BOOTSTRAP** — binding present, `ARTIFACTS_GIT_HOST` var unset. Admin repo ops
    work (`GET /admin/artifacts` reveals the remote host to configure); restore/persist
    skip with a logged reason.
  - **ON** — binding + vars `ARTIFACTS_NAMESPACE` + `ARTIFACTS_GIT_HOST` set.
- **Channel sessions excluded in v1**: channel ids (`github:v1:...`) contain `:`, which
  the Artifacts name charset forbids; sanitizing would break the name=label join.
  Minted chat ids always qualify.

### Cost tracking (third stream, alongside container-$ and LLM-$)

- `core/src/cost.js`: `ARTIFACTS_RATES` (`operation: 0.00015`, `storageGBMonth: 0.50`),
  `ARTIFACTS_INCLUDED_MONTHLY` (10 000 ops, 1 GB-mo), `artifactsOpsQuery()` against
  `artifactsEventsAdaptiveGroups` filtered by namespace + grouped by `repositoryName`
  and `eventType`, `foldArtifactsOpsResponse()` (rows + totals + truncation, like the
  container fold), `priceArtifactsOps()`, `estimateArtifactsStorageMonthly(bytes)`.
- Storage has **no per-repo metric**, so per-session storage is a labeled run-rate
  estimate from `repo_bytes` captured at push time (`git count-objects -v`) ×
  $0.50/GB-mo. A basis string states every assumption, same style as `COST_BASIS`.
- `backend-b/src/costs.ts`: `fetchArtifactsCosts()` with the existing two-step
  label→session enrichment reused verbatim; `GET /admin/costs` gains an additive
  `artifacts` sub-object (its errors can never 502 the container view).
- Frontend Costs tab (`frontend/src/App.tsx` `CostsView`): a second table — Session |
  Agent | Ops (today) | Ops $ (today) | Pushes (session) | Repo size | Storage $/mo est.
  | Last push — keeping the repo's "two windows, never summed" honesty rule.
- `scripts/cf-costs.mjs`: `--artifacts` flag + dataset `--introspect` support (the tool
  this repo uses to settle live GraphQL schema vs docs — needed for a beta dataset).

## Implementation steps

1. `core/src/artifacts.js` (new, host-agnostic): repo-name rule + `artifactsRepoForSession()`,
   `.gitignore` content, `restoreWorkspaceScript()` / `persistWorkspaceScript()` shell
   builders (sentinel-gated, token never persisted), output parsers.
2. `core/src/cost.js` + `core/src/index.js`: rates, query, fold, pricing, storage
   estimate (all pure).
3. `scripts/admin.test.mjs`: unit tests for everything in 1–2 (runnable pre-beta),
   incl. the whitelist-union no-flap property and "token never lands in .git/config".
4. `backend-b/src/artifacts.ts` (new): structural binding types (one file to reconcile
   against the real beta SDK), touched-registry, `withArtifactsHost()`,
   `getOrCreateRepo()`, `mintAuthRemote()` (~300 s TTL, host validated, never logged),
   `restoreWorkspace()` / `persistWorkspace()` — never throw; failures degrade to
   today's ephemeral behavior.
5. `backend-b/src/agents/main.ts`: mark-touched + `restoreWorkspace()` first in
   `provisionWorkspace()`; drain + fire-and-forget `persistWorkspace()` in
   `useResponseFinish`; whitelist union in `useAgentStart`.
6. `backend-b/src/app.ts`: whitelist union at ingest + skill-check; restore replay in
   skill-check (keeps its "replays lazy provisioning exactly" contract); optional repo
   delete in `DELETE /sessions/:id` behind `ARTIFACTS_DELETE_ON_SESSION_DELETE`; new
   admin routes `GET/DELETE /admin/artifacts[/:name]`,
   `GET/POST /admin/sessions/:id/artifacts` (`{action: restore|push|status}` — the
   acceptance oracles).
7. `backend-b/src/costs.ts` + `/admin/costs` artifacts sub-object.
8. `frontend/src/App.tsx`: artifacts cost table (+ configured:false / error states).
9. `scripts/cf-costs.mjs` `--artifacts`; acceptance additions in `scripts/acceptance.mjs`.
10. Docs: README section (lifecycle, gate states, bootstrap procedure,
    `session_artifacts` schema next to `session_sandbox`); wrangler.jsonc commented
    block + vars.

## Verification (no local dev — deployed workers.dev per CLAUDE.md)

**Phase A — now, without beta access:** `pnpm test` (new pure tests);
`pnpm deploy:*`; `/admin/costs` shows `artifacts.configured:false`; Costs tab renders
the note; full existing acceptance suite green (proves feature-off changes nothing).

**Phase B — after the grant:** uncomment binding (bump wrangler if it rejects the key),
deploy; create first repo via `POST /admin/sessions/:id/artifacts {action:'restore'}`;
read host from `GET /admin/artifacts`, set the two vars, redeploy. Then: seeded →
write → forced push → `push_count:1`; repo `log()` shows the commit; whitelist contains
the git host and does not flap. Manual once: write a file, idle >10 min (real sleep),
next turn reads it back (`restore:cloned` in `pnpm logs`, note clone latency).
`cf-costs --introspect` to settle the dataset's real `eventType` values; after a day,
compare ops counts vs the billing dashboard.

## Decisions taken (defaults — say the word to change)

- **Assume no beta access yet** → everything flag-gated; requesting access is step 0.
- **Retention: keep repos indefinitely.** They ARE the durable work product (survive the
  24 h session TTL — arguably the point). Manual `DELETE /admin/artifacts/:name`; the
  session-delete flag exists but defaults off. Cost: cents at this content size.
- **Git auth: short-lived token in the remote URL** (Cloudflare's documented pattern),
  ~5-min write token scoped to the session's own repo, never in `.git/config`/env/logs.
  The zero-knowledge egress-injection variant (consistent with `egress_secrets`
  doctrine, but needs Basic-auth injection — `injectAndForward` is Bearer-only) is
  designed and deferred as hardening.

## Risks / unknowns

- Closed beta: binding API shape + wrangler key support unverified until access;
  contained in `backend-b/src/artifacts.ts` structural types + the commented block.
- Whether GraphQL `count` == billable ops, and the real `eventType` value set —
  settle via `--introspect`; basis strings state the assumptions.
- Token appears in the exec command line inside the (single-tenant) container —
  mitigated by ~300 s TTL and repo-scoped write access.
- Aborted submissions (no `useResponseFinish`) lose that turn's delta if the container
  then sleeps — accepted; next touched turn commits what survived.
- Old repos outlive the 24 h `container:` pointer → some admin rows show by repo name
  only (like today's "unlabeled" container row). Clone latency on cold boot: watch via
  boot logs.
