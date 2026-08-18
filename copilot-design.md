# Semantius Copilot (formerly Hoth Trip-Planner POC) — Design (rev. 5, consolidated)

> This is the project's DESIGN document (goal, seams, security model, acceptance criteria) —
> the "why" behind the code; the README is the operational "how it works today". Formerly
> `semantius-copilot-plan.md`; code comments and the README cite its sections as `design §N`.

## 1. Goal & thesis

Prove that **two skill-delivery mechanisms yield identical agent behavior**:

- **Hard-coded skill** — the OOTB Flue way: the skill lives on the sandbox filesystem (baked into the
  container image). Backend A.
- **Dynamic skill bundle** — the whole skill (**all `.md` references + `.ts/.js` scripts**) serialized
  as **one JSON string**, delivered at runtime and reconstructed into the sandbox. Backend B. This is
  the multi-tenant path (bundle later lives in a database).

If both produce the same result — skill instructions, dynamically-loaded references, and an executable
script that runs in the sandbox and makes an authenticated outbound call — the dynamic-bundle path is
validated as the multi-tenant foundation.

**Secondary properties proven along the way:**
- **Request isolation** (the spine): two concurrent sessions with different bundles/secrets never see
  each other's files, env, or credentials.
- **Zero-trust secrets:** the per-tenant bearer is injected at egress (outbound handler) and **never
  enters the sandbox** — demonstrated by an authenticated call to an HTTP echo endpoint.
- **Portability:** Cloudflare is not a hard dependency; the core runs behind pluggable seams.

## 2. Architecture — Flue core + three pluggable seams

Flue is the framework. Cloudflare is the **first implementation** of each seam, not the architecture.

```
Flue core (host-agnostic):  bundle → provision skill → discovery → run → authenticated egress
   ├─ Sandbox seam        → Flue SandboxApi/Factory   → CF Sandbox (microVM)  | Docker | E2B | local
   ├─ State seam          → Flue persistence adapters  → DO-SQLite (CF)        | Postgres/SQLite
   └─ Egress/Secret seam  → OUR interface (app-owned)  → outbound handlers (CF)| proxy sidecar (Docker)
```

- **Sandbox** and **State** are Flue-native pluggable interfaces (SandboxFactory/SandboxApi;
  PersistenceAdapter/RunStore/EventStreamStore — SQL and Mongo are first-class).
- **Egress/Secret broker** is the one capability Flue does *not* abstract, because zero-trust
  secret-at-egress is Cloudflare-specific. We define a small interface; the POC ships only the **CF
  (outbound-handler) implementation**; a Docker **egress-proxy sidecar** impl is future work behind the
  same seam.
- A **Node smoke test** (virtual/local sandbox, in-memory state, no egress broker) proves the core runs
  with zero Cloudflare present — portability demonstrated, not just asserted.

## 3. Three projects (separate deployables)

```
c:\dev\semantius-copilot\             pnpm workspace; conventional package names
├─ agents/      SOURCE OF TRUTH for every agent: agents/<name>/{agent.jsonc (REQUIRED),
│               INSTRUCTIONS.md (optional, appended), skills/<skill>/…}. Schema:
│               core/agent.schema.json. Folders without agent.jsonc are skipped.
├─ backend-a/   Flue+CF Worker — the FIXED hoth-trip-planner agent; skills BAKED INTO the
│               container image (hard-coded / OOTB).
├─ backend-b/   Flue+CF Worker — MULTI-AGENT: the whole agent (instructions + model +
│               skills) is INJECTED at runtime from the one-JSON-string agent bundle.
└─ frontend/    React + Vite — one chat, New-session button, A/B backend dropdown, agent
                dropdown when B is selected.
```

- pnpm; React + Vite. Both backends deploy to Cloudflare Workers (Workers Paid — Containers enabled).
- The bundler CLI is top-level (`scripts/bundle.mjs`, root `pnpm bundle`) — not backend-specific.
- Both backends are `--target cloudflare`; both use **Cloudflare Sandbox** (microVM backend) via
  `getSandbox(env.Sandbox, id)` + `cloudflareSandbox(...)` from `@flue/runtime/cloudflare`.

### agents/ folder & agent.jsonc

Each agent is one folder under `agents/`. `agent.jsonc` is REQUIRED (JSONC — comments and
trailing commas allowed; parsed by `jsonc-parser` in `@semantius-copilot/core/node`); a folder without it
is skipped by the bundler with a warning. Properties (schema `core/agent.schema.json` —
kept OUT of agents/ so the folder holds only agents; unknown keys rejected — future keys
are added to schema + `validateAgentConfig` together):

- `instructions` — optional string; an optional `INSTRUCTIONS.md` next to the config is
  **appended**; at least one of the two must yield non-empty text.
- `model` — optional; prefix rule: first path segment ∈ {openrouter, custom, cloudflare} →
  as-is, else `openrouter/` is prepended. Missing → the backend's env default (§ LLM).
- `model_base_url` — optional http(s) URL; per-agent transport override (auth stays the
  worker-wide `LLM_API_KEY`).
- `proxy_whitelist` — optional array of egress globs: a hostname or a URL, `*` allowed
  anywhere (`abc.com`, `*.suffix`, `api.*.acme.io`, `https://x/abc/*`), ≤32 entries.
  **DENY-ALL WHEN ABSENT**: an agent without it can make no outbound request from its
  sandbox at all (§7), *unless its org contributes one* — since the copilot-settings
  endpoint landed, this list is unioned at egress with the ORG's own allow list
  (`POST /session/copilot` → the session record's `org_whitelist`; an org running with its
  copilot firewall off contributes `*`). There is no global whitelist anymore — the former
  `DOMAIN_WHITELIST` constant is gone.

Skills live in `agents/<name>/skills/<skill>/` (0..16; each needs a `SKILL.md` whose
frontmatter `name` matches the skill dir name). `hoth-trip-planner` has one skill,
`planner`; `semantius-admin` has zero (valid).

## 4. The skill: `hoth-trip-planner`

Fictional (planet Hoth) so the model cannot use training knowledge and must read the references + run
the script.

```
agents/hoth-trip-planner/skills/planner/
├─ SKILL.md
├─ references/{echo-basin.md, north-ridge.md}   # sites + operator + region per region
└─ scripts/opening-times.js                       # calls the (mock) Hoth tourism API, returns times
```

- Sites = ski resorts & spas of two fictional operators: **Rebel Alliance Leisure**, **Imperial
  Wellness**. E.g. *Echo Base Thermal Springs*, *Wampa Ridge Spa*, *North Ridge Piste Lodge*.
- `SKILL.md`: frontmatter `name: planner` (lowercase/hyphens, ≤64, **matches dir name**),
  non-empty `description` (≤1024). Body: read the region reference for candidate sites, then run the
  script for opening times — with the exact `node … 2>&1` command baked in (adapter/exec surfaces no
  stderr otherwise). Script referenced by real cwd-relative path
  (`.agents/skills/planner/scripts/opening-times.js`); Flue has no `${CLAUDE_SKILL_DIR}`.
- `opening-times.js`: input site names + `from`/`to`. It **calls the mock Hoth tourism API** (an HTTP
  echo endpoint) with the request details and **no Authorization header**; the outbound handler injects
  the per-tenant bearer (§7). The echo response returns what the upstream received (proving the bearer
  arrived). The script then returns synthetic per-date data: `{ site_name, site_id: snake_case(name),
  opening_times:[{date,open,close}…] }`. Runs on `node`. (If a skill ships `.ts` scripts, the base
  image needs a TS runner such as `tsx`; POC uses `.js`.)

## 5. Agent-bundle format & bundler (backend B)

The dynamic **agent bundle** is **one JSON string** carrying the whole agent — merged
instructions, optional model overrides, and every file of every skill:

```jsonc
{ "agentName":"hoth-trip-planner", "version":"<content-hash>", "baseImage":"node",
  "instructions":"…agent.jsonc instructions + INSTRUCTIONS.md…",
  "model":"openrouter/…",            // optional, pre-normalized (prefix rule, §3)
  "modelBaseUrl":"https://…",        // optional
  "proxyWhitelist":["postman-echo.com"],  // optional — DENY-ALL egress when absent (§7)
  "skills": { "planner": { "SKILL.md":"…", "references/echo-basin.md":"…",
                           "references/north-ridge.md":"…", "scripts/opening-times.js":"…" } } }
```

- **Bundler** (top-level `scripts/bundle.mjs`, root `pnpm bundle`): scans `agents/`, builds one bundle
  per agent folder that has `agent.jsonc`. **Same skills folder** A bakes into its image → **agent
  defined once**, all consumers derive from it (B's bundles, A's Dockerfile COPY + generated meta,
  the frontend agent list).
- **`baseImage`** names the toolchain the agent needs; it selects the Sandbox binding at runtime (§16).
  The POC defaults it to one value — the field exists now so 3-4 images later is a config change, not a
  rewrite.
- Round-trip assert: each bundled skill → reconstruct → byte-identical to its source folder.
- Limits (`core/src/agent.js`): ≤16 skills; per skill ≤64 files / ≤256 KiB file / ≤1 MiB; ≤4 MiB per
  agent; instructions ≤64 KiB; tar entry names (`<skill>/<relPath>`) ≤100 bytes (ustar). **Zero skills
  is valid** — the bundle still carries instructions/model; nothing is provisioned.
- **A bundle is immutable per session `id`** — a changed agent is a new `id` (§6), so reconstruction is
  always absent→write, never overwrite.

## 6. Backends

**Shared init contract (load-bearing — verified in Flue source).** All per-session provisioning happens
**inside the awaited `defineAgent(async ({ id, env }) => {…})` initializer**, which Flue awaits
(`client.ts:247`) **before** it scans `.agents/skills` for discovery (`discoverSessionContext`,
`client.ts:269`; the harness is rebuilt and this re-runs **every message**, `agent-submissions.ts:842`,
`client.ts:294`). So anything the initializer writes to the sandbox is present before discovery, and B
self-heals on every cold container. The ingest route (B) only **stores** the bundle — it must **not** be
the reconstruction site (a cold container at prompt time would then have no skill). Pin a single absolute
**cwd = `/workspace`**; reconstruct into and discover from exactly
`/workspace/.agents/skills/<skill>` (one dir per skill in the bundle, e.g. `planner`).

**Identity (in scope — isolation depends on it).** `id` must be **server-minted, globally unique, and
never reused**. **As built:** the ingest route mints `<org>-<sub>-<32 hex>` from the identity the user
guard verified — tenant-prefixed so `session:<id>` / `agent:<id>` are tenant-scoped by KV prefix, and
server-side so the prefix is a fact rather than a client's claim (`mintSessionId`, `core/src/config.js`;
README "Session ids"). The Sandbox's
`containerId = idFromName(sanitizeSandboxId(id))` is a deterministic function of `id`, so **id
uniqueness is what makes both container isolation and per-tenant secret keying safe** — a reused id
silently reuses another session's container and bearer. **A bundle is immutable per `id`**: a changed
skill ⇒ a new `id`. Reconstruction is therefore always **absent→write**, never in-place overwrite,
which removes any mixed-version window against concurrent session materialization.

**Backend A — hard-coded / OOTB (fixed agent `hoth`).** Dockerfile `FROM cloudflare/sandbox:<v>` +
`COPY agents/hoth-trip-planner/skills /workspace/.agents/skills` (dir contents → one dir per skill,
e.g. `planner`). Instructions + model come from the bundler-generated meta
(`backend-a/src/generated/agent.json`, imported at build time — `pnpm bundle` runs before build in the
root deploy). Initializer: `getSandbox(env.Sandbox, id)` (skills already in the image) → discovery.
No bundle at runtime. **A still needs the bearer-mapping write** (§7): it has no ingest route, so seed
`KV[containerId] = bearer` in a `POST …/provision` (or at session create) before the first prompt. A is
a **static agent** — one **fixed** bearer/config for all sessions (not per-tenant). "OOTB" is scoped to
**skill delivery** (baked image + discovery, no bundle/ingest); A shares the egress/secret seam with B
**by design** so the *same skills* run identically (§13 C4). This maps to the contract exactly:
A = static setting, B = per-session setting.

**Backend B — dynamic bundle, MULTI-AGENT (generic agent `main`).** One Flue agent hosts every agent:
which agent a session runs is decided by the **agent bundle** POSTed at session creation, not by code.
Base Dockerfile is **skill-free** — only the CF sandbox base + `node`; `/workspace/.agents/skills` is
**empty at boot**. This is a hard requirement, not an aside: if any skill file were baked in, B would be
discovering a baked copy instead of testing dynamic injection. Verified by the §13 clean-base test (a B
container **before** injection finds no skill). Ingest `POST …/sessions/agent` (which also **mints the
session id**, see §6 Identity) (a) **validates** the
agent bundle (§8), (b) stores it as `agent:<id>` (KV, read back by the initializer via an `env`
binding), (c) writes `KV[containerId] = bearer`. The `useAgentStart` callback reads the stored bundle,
persists the agent meta (instructions, model, modelBaseUrl, sandbox binding — `usePersistentState`),
reconstructs every skill into `/workspace/.agents/skills/<skill>` **when absent** (cold container, one
tar for all skills, still 2 RPCs) → discovery.

**First-turn identity (verified on the deployed runtime):** state written in `useAgentStart` lands only
AFTER the submission's first model turn — the submission pipeline rebuilds the system prompt *before*
the start seam runs (`rebuildCanonicalContext` → `runAgentStartHooks` in
`@flue/runtime` conversation-stream-store), and Flue then narrates "System instructions updated." and
re-renders for later turns. So the persisted meta alone would leave turn 1 on generic default
instructions. Fix: the **instance-creating send carries the agent meta as `initialData`** (read in the
render via `useInitialData()`, present from the first render on) — the frontend's B client injects it
on every `send` (Flue records it only at creation, ignores it afterwards), and the GitHub channel
passes it on `dispatch` from the stored `agent:github-default` bundle. Resolution order in the render:
persisted meta (KV-authoritative — also picks up a re-seeded github-default) → creation seed → generic
default. Per-agent model:
`agentModelSpecifier()` registers a dedicated one-model Pi provider `agent-<name>` when the bundle
overrides model/base URL; otherwise the env default applies. Immutable-per-id ⇒ "absent" is the only
case; no overwrite. The agent was renamed `hoth` → `main` (wrangler migration v4 — pre-rename
conversations were abandoned, accepted for the POC).

Both backends run the **same skills** and the **same outbound handler**. The only difference is how the
agent reached the container: image-baked + build-time meta (A) vs runtime-reconstructed bundle (B).

## 7. Zero-trust secrets & egress (the outbound handler)

- Export `ContainerProxy`; register an **`outboundByHost`** handler for the echo host that, **per
  invocation**, reads `KV.get(ctx.containerId)` and sets `Authorization: Bearer <key>`. The **sandbox
  never holds the raw token**. **No closure/module caching** of the resolved token — the handler
  registry is isolate-global, so caching bleeds across concurrent sessions; resolve from
  `ctx.containerId` every call.
- **Mapping write (both backends), before first exec:** write `KV[containerId] = bearer`, deriving
  `containerId` **identically to the SDK** — `env[binding].idFromName(sanitizeSandboxId(id)).toString()`
  with the same `normalizeId` setting, where `binding` is the Sandbox binding selected from the bundle's
  `baseImage` (§16). Use the **same selected binding** for both `getSandbox` and this KV key, or it's a
  silent miss. B writes the mapping in the ingest POST; A in its provision step. The frontend awaits 2xx
  before chatting (§10) so the mapping exists first.
- **TTL + delete-on-session-end** on `KV[containerId]` — defence-in-depth even though ids are unique.
- **Per-agent egress whitelist (dynamic):** the agent's `proxy_whitelist` (§3) rides the bundle as
  `proxyWhitelist` and gates BOTH handlers. Backend B maps `whitelist:<containerId>` in KV at ingest
  (self-healed in the initializer and the skill-check route — deleted sessions stay deny-all because
  their bundle is gone); each handler resolves it per invocation via `resolveEgressWhitelist` — **no
  mapping / empty list ⇒ deny all** (same fail-closed posture as the bearer). Backend A is the fixed
  single-agent backend, so its list is baked at build time from the generated meta into
  `cloudflare.ts`. The old global `DOMAIN_WHITELIST` is removed; `brokerEgress` takes the resolved
  per-agent list.
- **Org egress allow list (later addition):** the per-agent list is no longer the only source. At
  session creation the ingest route reads the org's copilot settings (`POST /session/copilot`, cookie
  path only) and stores them as `org_whitelist` on the session record; `resolveEgressPolicy` returns
  the UNION of that and the agent's `whitelist`. Kept as two fields because the per-message self-heal
  rewrites the agent half from the bundle and cannot re-read the org half. `copilotEnabled: false`
  refuses session creation outright (403). Because a firewall-off org contributes `*`, the
  sentinel→JWT swap gained its own narrow scope (`secretHosts` = `SEMANTIUS_HOSTS`): reachability and
  credential scope are now separate questions.
- `interceptHttps` is **default `true`** (echo host is HTTPS) — no opt-in needed.
- **Egress deny-by-default:** set **`enableInternet: false`** **and** **`allowedHosts = [echo host]`**
  (an allowlist becomes deny-by-default). `enableInternet:false` leaves only ports 80/443/DNS open and
  blocks raw sockets on other ports; the allowlist + handler govern 80/443. Test link-local/RFC-1918 on
  **ports 80/443 and via DNS**, not just "some other port" (§13) — an HTTP-only test gives a false pass.
- **Use `placement: smart`** (not `targeted`) — targeted puts `ContainerProxy` in a different colo and
  header injection silently never fires (sandbox-sdk#661).
- **Two wiring prerequisites found during implementation (both load-bearing):**
  1. **Workers AI binding** (`"ai": { "binding": "AI" }` in `wrangler.jsonc`) is required for any
     `cloudflare/*` model, else the agent fails with *"Cloudflare AI binding not available."*
  2. **HTTPS interception needs per-process CA trust — SUPERSEDED finding, kept for history.** The
     original spike (pre-`interceptHttps`, `allowedHosts` era) measured **port 443 hanging** and read
     it as "CA not provisioned by the base image". The semantius work corrected this: with
     `interceptHttps = true` the sandbox runtime DOES provision the interceptor CA at
     `/etc/cloudflare/certs/cloudflare-containers-ca.crt`, and HTTPS egress works for processes that
     trust it — semantius and node scripts do via `NODE_EXTRA_CA_CERTS` (both Dockerfiles set it);
     verified by the live semantius CLI calls to `<org>.semantius.ai`. CLOSED — handled OOTB by the
     platform: the in-container sandbox runtime (`/container-server/sandbox`, inspected in the
     `0.12.3` image) sets `NODE_EXTRA_CA_CERTS` at boot and merges the interceptor CA into the
     system bundle, exporting `SSL_CERT_FILE` / `CURL_CA_BUNDLE` / `REQUESTS_CA_BUNDLE` /
     `GIT_SSL_CAINFO` to every exec'd process — node, bun/semantius, curl, python, and git all get
     working trust with no per-image wiring (proved by the `curl-check` skill-check op in
     acceptance). The spike-era hang happened because interception was off: no CA existed at all.
     `opening-times.js` calls the echo host over HTTPS.
- **Egress deny-by-default measured (HISTORICAL — spike-era config):** non-allowlisted hosts returned
  **no successful response** — port 443 hard-blocked (curl `000`) for link-local `169.254.169.254`,
  RFC-1918, and arbitrary public hosts; port 80 denials returned **`520`** from the proxy. Measured
  BEFORE the catch-all `outbound` handler and `interceptHttps` existed: today all outbound HTTP(S) is
  intercepted and denials for CA-trusting processes come from the handlers as **403** per the agent's
  proxy_whitelist (curl-style tools still die in the 443 handshake). The invariant that mattered —
  no unauthorized egress succeeds — holds in both eras.
- The **echo endpoint** reflects the request back so the POC can *see* the injected bearer and confirm
  the container sent none. (beeceptor `http-echo` / `httpbin.org/anything`; must echo request headers;
  avoid HEAD — sandbox-sdk#660.)

## 8. Sandbox lifecycle, state & bundle validation

- **Per-id container is native**: `getSandbox(env.Sandbox, id)` returns the same DO-backed sandbox for a
  given `id` → warm reuse across turns is free; different ids never share a container (structural request
  isolation). `containerId = idFromName(id)` is **stable across sleep/wake/eviction**, so the bearer
  mapping keyed by it survives cold starts. No manual acquire/reuse machinery (unlike the Daytona design).
- **Container disk is ephemeral** — reset to the image on sleep (~10 min idle) or eviction. A's baked
  skill returns for free (image re-pull). B's initializer re-materializes when the skill dir is
  **absent** — immutable-per-id (§6) means there is no stale/overwrite case, so no in-place rewrite and
  no mixed-version window. Same-id submissions are head-of-line serialized (`sql-agent-execution-store.ts`),
  so there is no concurrent-reconstruction race on the run path.
- **State seam** = Flue persistence; the per-id bundle + `containerId→bearer` live in KV keyed by `id`.
- **Reconstruct in 2 RPCs, not N:** write the bundle as one base64-tar blob (`writeFile`, 1 RPC) then
  `env.exec('base64 -d … | tar -xz -C /workspace/.agents/skills')` (1 RPC). Flue/SDK have **no batch
  write**, so per-file writes are N round-trips on every cold container (§15 P2).
- **Lazy boot (supersedes the §15 P1 pre-warm):** ingest is storage-only, and the frontend defers it to
  the first message — so there is no typing window left to overlap a boot with. Instead the agent wraps
  its SessionEnv (`backend-b/src/lazy-env.ts`): discovery + skills-tree reads are answered from the KV
  bundle (byte-identical to the disk extraction), and the first op that needs a live machine
  (exec/write/out-of-tree read) boots the container and reconstructs right there. Chat-only turns never
  start a container; the 1-3 s boot lands inside the first shell-using tool call.
- **Bundle validation (untrusted input)**, server-side before reconstruction: reject `..`, absolute,
  backslashes, symlinks, resolve-outside-dir; size/count caps. Flue/adapters validate nothing.
- Any dir cleanup uses **`env.exec('rm -rf …')`** (the CF SandboxApi `rm()` throws on `recursive`/`force`,
  `cf-sandbox.ts:134-146`) — but immutable-per-id means destructive cleanup is normally unneeded.

## 9. Multi-tenant security model

The sandbox runs arbitrary skill code (`bash`/`node`). The boundary must hold across concurrent
sessions. Request isolation is the POC's proven property; tenant authz is the layer above it.

1. **Isolation:** each CF Sandbox runs in its **own VM** — Cloudflare's choice of gVisor / Firecracker /
   QEMU, **not developer-selectable**. Stronger than shared-kernel containers (the earlier concern), but
   **not a guaranteed hardware-hypervisor boundary** — if that is a hard requirement for tenant code it
   stays a recorded residual risk, not something the spike can pin.
2. **Request isolation (spine):** different `id` ⇒ different DO ⇒ structural file/env isolation; Flue's
   CF runtime is AsyncLocalStorage-scoped (`cloudflare/context.ts`), so no per-request bleed by default.
   Two named footguns: **(a)** the isolate-global `outboundByHost` handler must resolve the bearer from
   `ctx.containerId` **per invocation** with no closure/module caching; **(b)** do not register a Flue
   `observe()` sink that retains per-session data (it is a module-global fanned out to every session).
   Keep all per-request state in request/DO scope.
3. **Secrets never in the sandbox:** injected at egress by `containerId` (§7); a script cannot leak a
   token it never holds. Only non-sensitive config may go in container env.
4. **Egress:** deny-by-default + host allowlist (§7).
5. **Bundle validation:** §8.
6. **Session-id uniqueness (IN scope — isolation depends on it):** `id` must be server-minted, globally
   unique, and never reused, because `containerId = idFromName(id)` derives both container and bearer
   identity from it — a reused id reuses another session's container and secret. **Tenant authz
   (deferred):** Flue does **no** authz on the URL `id` (`flue-app.ts:420`, `errors.ts:1378-1390`);
   production binds a verified token → tenant → allowed sessions and keys all state by server-derived
   `hash(tenant+session)`, enforced on **GET/stream and POST**.
7. **Quotas/DoS:** per-tenant concurrent-container + creation-rate caps (app-enforced); spend alerting.

## 10. Frontend (React + Vite)

`@flue/react` + `@flue/sdk`. **Three fixed pages plus one dynamic family, one Worker, split by
credential** (backend A is gone; everything is the `/agents/main` mount on backend B). The agent
registry is RUNTIME, not build time: no agent name, list, welcome, or seed is baked into the
frontend — the dropdown lists `GET /agents` and `AgentChat` loads welcome + turn-1 seed from
`GET /agents/:name/meta` (both user-guarded reads of KV `agentdef:<name>`), so
`pnpm deploy:agent <name>` makes an agent appear on every page with no frontend rebuild.

- **`/chat` — chat (`chat.html` → `ChatApp.tsx`).** Authenticated by the user's own Semantius token
  (`<org>:<jwt>`, also acceptable in the URL fragment `#jwt=…&session=…`). A conversation-scoped
  `FlueClient` per session (`useConversationClient`), plus an agent dropdown listing the runtime
  registry. **New session** opens a zero-cost draft (no request); the FIRST message sent fires
  `POST /sessions/agent` with the selected agent NAME — the backend mints the `sessionId` (the page
  generates no id of its own) — and the message is then delivered to the new session. Render
  `messages[].parts`.
- **`/copilot` — the same page (`copilot.html` → `CopilotApp.tsx`).** Authenticated by a
  better-auth session cookie value instead (fragment `#cookie=…&session=…`), sent in the
  `x-better-auth-cookie` header because a browser cannot set `Cookie` cross-origin.
- **`/agent/<name>` — the INPUT-FREE per-agent page (`agent-shell.html` → `AgentApp.tsx`).** One
  shared shell served for every well-formed name by the only Worker code in the frontend
  (`worker/index.ts`, reached via `run_worker_first: ["/agent", "/agent/*"]`). No controls at all:
  the agent is fixed by the URL, the credential comes from `#cookie=`/`#jwt=` fragments or
  localStorage — or from NEITHER: with no explicit credential the page runs in AMBIENT mode
  (`credentials: 'include'`, the browser's own better-auth cookie; needs the backend same-site +
  in ALLOWED_ORIGINS), and a 401 renders as a signed-out notice. A draft opens by itself.
  Ill-formed names fall through to the real 404; a well-formed name that names no deployed agent
  renders an in-page error (the registry decides existence, not the asset layout).
- **`/admin` — operator console (`admin.html` → `App.tsx`).** Authenticated by the deployment API
  key. Data browser (`/admin/collections*`, plus the read-only `/admin/agents/main/*` conversation
  mount) and a Costs tab (`/admin/costs` — today's Cloudflare container spend per session). The
  only link between the pages is one-way, admin → chat.

The conversation (draft, session create, key-flip handoff, streaming) is the reusable
`AgentChatContainer` in `components/ai-elements/` — a folder with ZERO workspace imports,
copyable into other apps (README "Reusable chat surface" documents the props, the three auth
modes incl. ambient cookies, and the full copy set). `/chat` and `/copilot` share
`ChatPage.tsx` as chrome around it; `/agent/<name>` renders it bare. Separate Vite entries
so the user bundles never ship the admin code. No fixed path is declared in code beyond
`CHAT_PAGE`/`AGENT_PAGE_PREFIX` in `frontend/src/pages.ts` (the app's page map + credential
bootstrap, deliberately outside the copyable folder);
Workers assets resolves the fixed pages from the filenames. There is no `index.html`, and
`not_found_handling: "404-page"` means `/` and every mistyped path answer a real 404 rather than
falling back to a page.

## 11. Build order

0. **Spike (gate):** deployed Worker, **`placement: smart`**, **`enableInternet: false`** +
   **`allowedHosts=[echo host]`**. Exercise `getSandbox` → write files → `exec node` → an
   **`outboundByHost`** handler injecting a bearer. Confirm ALL of:
   - injected bearer appears at the echo and is **absent** from container `env`;
   - the app's `idFromName(sanitizeSandboxId(id))` derivation **equals** the handler's `ctx.containerId`
     (no silent KV miss);
   - two **concurrently interleaved** sessions each get **their own** bearer (no isolate-cache bleed);
   - egress to `169.254.169.254`/RFC-1918 fails on **ports 80/443 and via DNS** (not just other ports);
   - after **>10 min idle**, a new turn re-materializes B's skill (absent-dir path) and the bearer still
     resolves.
   (Do **not** gate on "microVM" — the runtime is not developer-selectable.)
1. **Skill** folder; run `opening-times.js` against the echo endpoint locally.
2. **Bundler** → one JSON string; round-trip assert.
3. **Backend A** — Worker + Dockerfile baking the skill; discovery; outbound handler; verify.
4. **Shared core** — `provisionSkill(bundle)` (validate + write + version stamp) + the egress/secret
   broker interface (CF impl).
5. **Backend B** — ingest route + DO store; initializer reconstruct; discovery.
6. **Frontend** — two pages (`/` chat, `/admin` console), new-session, agent dropdown.
7. **Node smoke test** — core runs on `--target node` with virtual/local sandbox, no CF.
8. **All C1–C5 acceptance tests (§13)** — incl. the C4 byte-equal direct-exec oracle and the C3
   triple-hash single-source check; deploy both + host frontend; repeat against deployed URLs.

## 12. From B to production multi-tenant (future)

Bundle → Postgres `tenant_skill_files(tenant_id, skill_name, rel_path, content, version)` + per-tenant
secret refs. Tenant from **verified** identity → Flue `id`. Bundler server-side (tenant uploads a folder
→ rows; client no longer the origin). Docker egress-proxy impl of the secret/egress seam for private
hosting. Tenant authz (§9.6), quotas, reaping become production controls.

## 13. Acceptance criteria

Each test names a concrete **oracle**, not prose. LLM nondeterminism is isolated from the skill-delivery
comparison by driving the deterministic core directly. Grouped by the five contract criteria.

**C1 — A is OOTB / static (skill delivery vanilla).**
- A's skills are served **purely from the image**: `POST <backend-a>/sessions/:id/agent` returns 404/405
  (no ingest), and an exec/fs trace of an A turn shows **zero writes** under `/workspace/.agents/skills`.
- Recorded scope: A keeps the egress/secret seam but with a **single static** bearer/config ("static
  agent"); "OOTB" = skill delivery only (§6). Not a violation — required so the same skill runs on both.

**C2 — B per-tenant, differs per session.**
- Two concurrent B sessions carry **different bearers**, and each echo also reflects the tenant the
  session acts on (`x-semantius-org`); neither container `env` holds the raw bearer — proving
  per-session runtime injection drives behavior, not a baked/shared value.
- Amended after the identity work (see README "User identity"): the tenant marker is no longer a
  client-chosen `tenantTag` on the record but `session_context.semantius_org`, the org half of the
  **verified** token. Two sessions of one user therefore share the org (correctly) and are still
  distinguished by their credentials; a client-supplied tenant string was security theater, since
  anyone could pick any value.
- Also amended: "the bearer" is no longer a single record field. Downstream credentials live in
  `egress_secrets` — a map of **host glob → credential** (README "`egress_secrets`") — so a session
  can hold several, each injected zero-knowledge for its own host, and
  fail-closed (403) where a host has no entry. The user's Semantius JWT stays out of the map: it is
  both the token the backend authenticates with and an egress secret, so it lives with the identity
  in `session_context` and uses the sentinel swap that the vendored CLI requires.
- Amended 2026-08-03: the server-side **minting** of `egress_secrets` stand-ins
  (`hoth-tourism-key-…`, generated in Worker code at ingest and by the GitHub-channel
  initializer) is **removed** — a server must never generate or hardcode a credential value.
  The map is now written only by a future **secret-retrieval layer** that resolves the
  tenant's secret *references* (vault/secrets store) at session creation — plug-in point:
  the `TODO(secret-retrieval)` in `backend-b/src/app.ts`'s ingest route. Until it exists,
  credential-required hosts fail closed for every session, and the C2/C4 acceptance
  assertions about injected credentials are replaced by fail-closed assertions (they return
  with the retrieval layer).

**C3 — Single source of truth (A-image == bundle == B-reconstructed, byte-identical).**
- **Triple-hash:** `find . -type f | sort | xargs sha256sum` inside **A's built image**, == per-file
  SHA-256 of the **bundle** values (same rel-paths), == the same `find|sha256sum` in **B's live sandbox
  after injection**. Guards CRLF / `.dockerignore` / stale-image drift the §5 build-host round-trip can't
  see (three different byte paths: Windows `fs` read, Docker `COPY`, `base64 -d | tar -xz`).

**C4 — Same result A vs B (the thesis).**
- **Deterministic oracle (load-bearing):** run the *same fixed-arg* invocation of `opening-times.js` in
  A's and B's sandbox — `env.exec('node .../opening-times.js --sites="Echo Base Thermal Springs"
  --from=2026-08-01 --to=2026-08-03 2>&1')` — and assert **A's stdout JSON == B's stdout JSON byte-for-
  byte** (`site_name`, `site_id`, `opening_times[]`). Zero LLM variance.
- **Egress trace:** in both, the echo upstream received `Authorization: Bearer <that session's key>` and
  the container itself sent none.
- **LLM trace (corroboration, seeded harness — fixed model, temp 0, fixed user turn):** same skill
  activated (`planner`), same reference read (`references/echo-basin.md`), same script path,
  matching `site_id` surfaced. Prose text is **not** compared. The direct-exec byte-compare is the real
  oracle; the trace is soft corroboration (temp-0 is not hard determinism). One unseeded chat is **not**
  a test.

**C5 — Nothing shared but the bundle.**
- **B↔B:** two concurrent sessions get their own bearer/container/files (isolate-cache bleed); a reused
  id is rejected (uniqueness guard); a delayed `KV[containerId]` write makes egress **fail closed**.
- **A↔B disjointness:** a config-diff over both `wrangler.jsonc` asserts A and B share **no** KV namespace
  id, Sandbox/DO binding/namespace, or secret name. Combined with C3's clean-base, this proves the
  **bundle JSON is the only artifact crossing A→B**. The base image name is shared but read-only /
  state-free.

**Lifecycle / robustness (cross-cutting).**
- **B clean base:** on a **fresh, never-injected id**, `env.exec('find /workspace/.agents/skills -type f
  | wc -l')` returns **0** — a *file* count, not a discovery check (discovery skips malformed copies,
  `context.ts:88-94`). Positive control: after injection the same `find` shows the expected file set.
- **Reuse & cold-recovery:** turn-2 within `sleepAfter` reuses the warm container; after a cold container
  (>10 min idle / eviction) B **re-materializes** and still works.
- **Hostile bundle:** `..` / symlink / resolve-outside-dir / oversize / missing per-skill SKILL.md /
  missing instructions / too many skills rejected before reconstruction (`validateAgentBundle`).
- **Zero-skill agent:** a bundle with `skills: {}` (e.g. semantius-admin) ingests OK, provisions
  nothing (`reconstructed === false`, sandbox file count 0), and the agent still answers from its
  bundled instructions.
- **Egress (`enableInternet:false` + `allowedHosts`):** echo host reachable via the handler; raw-socket
  **and** HTTP(S) to `169.254.169.254`, an arbitrary public IP, and RFC-1918 fail on **ports 80/443 and
  via DNS**, not just other ports (an HTTP-only test gives a false pass).
- **Portability:** the Node smoke test runs the core skill flow with no Cloudflare present.

## 14. Open items (none blocking the spike)

- **Concrete echo endpoint** (beeceptor `http-echo` vs `httpbin.org/anything`) — pick at build.
- **Frontend hosting** — Cloudflare Pages vs a dedicated Worker.
- **Tenant authz source** — deferred to the tenant layer (§9.6), not needed for the POC spine.
- **Isolation runtime** (gVisor vs Firecracker vs QEMU) is Cloudflare's choice, not selectable —
  recorded as residual risk, not a decision (§9.1).
- **Arbitrary per-tenant custom images** are out of scope — static bindings cover a bounded set only;
  arbitrary images would need Workers for Platforms (§16 ceiling).

## 15. Performance & cost

- **P1 — Cold start (first-SKILL latency), resolved by lazy boot (§8).** The original mitigation —
  pre-warm inside the awaited ingest POST so boot overlaps typing — died with lazy session creation
  (§10: ingest now fires at first-message time, no typing window). Superseding decision (2026-08-02):
  boot only when a turn actually needs the machine. The lazy SessionEnv wrapper serves discovery and
  SKILL.md reads from the KV bundle, so chat-only turns pay zero container time; the ~1-3 s boot (+2-RPC
  reconstruction) happens inside the first exec/write, under the chat UI's busy indicator. Sessions
  idle >10 min re-pay it on their next exec — same absent→write path.
- **P2 — Reconstruction:** 2 RPCs via base64-tar + `exec` unpack (§8), not N per-file writes — there is
  no batch-write API.
- **P3 — Per-turn discovery tax: eliminated.** Flue still re-runs discovery every message
  (unconditional per submission), but the lazy wrapper answers it from the KV bundle — 0 container
  round-trips, warm or cold (was ~8, 3 of them `exec` spawns). The upstream memoization idea is moot
  for this app.
- **P4 — Outbound KV read:** `KV.get(containerId)` fires once per script egress, off the chat critical
  path. Keep the token in KV/DO, never in container env.
- **P5 — Concurrency/cost:** account limits are generous (6 TiB mem / 1,500 vCPU / 30 TB disk
  concurrent); billing is provisioned-memory × awake-time, so **`sleepAfter` is the main cost lever**.
  Use the smallest instance type that runs the skill, enforce per-tenant concurrent-container caps
  (§9.7), and alert on spend.

## 16. Multi-image future (3-4 base images) — bounded set

- CF Sandbox supports multiple base images as **one Container class + Durable Object binding per image**,
  declared statically in `wrangler.jsonc`. 3-4 toolchain images is squarely supported. "Few base images
  + inject skill files at runtime" is the right pattern — per-skill images don't scale (image sprawl,
  50 GB image-storage cap), and one fat image bloats every cold start.
- **Design hook (cheap, in the POC):** the bundle carries a `baseImage` field (§5, defaulted); a
  `baseImage → bindingName` resolver selects the Sandbox binding; **both** `getSandbox(env[binding], id)`
  and the bearer KV key derive from that **same** selected binding (§7). Adding an image later is a
  wrangler entry + a resolver row, not a rewrite. Each binding is its own DO namespace, so
  `idFromName(id)` stays globally unique across images — provided the key always uses the selected binding.
- **Ceiling (design within it):** static DO-class bindings cover only a **bounded, deploy-time** set.
  **Arbitrary per-tenant custom images are NOT supported** — that needs Workers for Platforms / dynamic
  dispatch, and whether per-tenant *containers* are supported there is an open question to validate with
  Cloudflare, not assume. Keep per-tenant variation in the injected skill **data**; keep base images a
  small fixed set.

## 17. Task tracking (TaskCreate / TaskUpdate / TaskList / TaskGet)

**Goal.** Give every agent a durable checklist for multi-step work and give the UI a structured
progress signal. Without it, a plan lives only in the model's context — gone at compaction, at a
paused turn (AskUserQuestion), at a container reset or a session restart — and the chat can only
show "Working…". Two requirements: (1) the list lives on the file system, as JSON, in the
session's workspace, so a restart/crash/pause never loses it; (2) every change is an explicit,
structured tool call, so a UI can render an active checklist and a progress bar from the
tool_use stream instead of scraping prose.

**Contract = Claude Code's Task tools, verbatim.** Claude Code replaced `TodoWrite` (one call
rewriting the whole list) with four tools — `TaskCreate` (`{subject, description, activeForm?,
metadata?}` → `{task:{id, subject}}`), `TaskUpdate` (`{taskId, status?, subject?, description?,
activeForm?, owner?, metadata?, addBlocks?, addBlockedBy?}` → `{success, taskId, updatedFields,
error?, statusChange?}`; `status:"deleted"` removes), `TaskList` (`{}` → `{tasks:[{id, subject,
status, owner?, blockedBy}]}`) and `TaskGet` (`{taskId}` → `{task:{…}|null}`). We ship exactly
those names, schemas and result shapes (extracted from the Claude Code 2.1.92 bundle, incl. the
semantics: sequential string ids from a high-watermark that never reuses a deleted id, two-sided
`blocks`/`blockedBy`, metadata merge with `null` deleting a key, `updatedFields` only on change,
`TaskList` hiding `metadata._internal` and listing only still-open blockers) so any UI wrapper
written for Claude Code's stream renders ours unchanged. `TodoWrite` is deliberately absent. The
always-present Flue built-in `task` tool (subagent delegation) is unrelated; the descriptions say
so. Descriptions are condensed from Claude Code's prompts and ride every request of every agent —
kept tight on purpose. A static instructions paragraph (`TASK_TRACKING_INSTRUCTIONS`, appended on
every channel, literal text so the cached prefix stays byte-identical) is the usage nudge Claude
Code delivers through periodic reminders.

**Storage: one index document, `/workspace/.tasks/tasks.json`** (`{version, highwatermark,
tasks[]}`, pretty-printed). Not Claude Code's one-file-per-task layout, for a reason specific to
this backend: the lazy sandbox wrapper (§15 successor, `lazy-env.ts`) answers
`exists`/`readdir`/`stat` outside the skills tree from the KV bundle view — "not there" — until the
container is provisioned; only `readFile`, `exec` and writes boot + restore. A `readdir` of a task
directory at the start of a submission would therefore report zero tasks without ever restoring
the backup. One `readFile` boots, restores, then reads (and any read failure is disambiguated
with a now-live `exists`, so a real failure is never mistaken for "no tasks"). It also costs 1
RPC per read and 2 per write instead of N+1. Location rules: not under `.agents` (excluded from
archives) and not at the workspace top level (user-downloadable). Persistence needs no code of
its own — the tools reach the sandbox via `harness.sandbox`, which is the very lazy env
`useSandbox` created, so each write fires `onMutation → requestWorkspacePersist` (§ Workspace
backup) and the file comes back with the next restore. Corrupt content (a squashfs taken
mid-write) is set aside as `tasks.json.corrupt-<iso>` and the list restarts empty rather than
wedging the tools.

**Concurrency.** Flue executes a tool batch in parallel; a model creating three tasks in one
message would race the read-modify-write and mint duplicate ids. `defineTool` exposes no
sequential-execution flag, so every task op runs under a per-session promise-chain mutex (one
conversation = one Durable Object = one isolate; pi starts the parallel executions in call order,
so ids come out in message order). The pure semantics live in `task-store.ts` (no I/O) and the
I/O + mutex in `tasks.ts`, so the contract is unit-testable without a sandbox.

**UI.** The chat surface folds the conversation's settled task tool parts (`task-fold.ts`:
TaskCreate results and TaskUpdate inputs accumulate into a map keyed by id; TaskList/TaskGet
results merge and prune — the docs-recommended consumption pattern) into a checklist + progress
bar pinned above the composer (`task-progress.tsx`). Durable truth is history, so a reload, the
key-flip remount or model-context compaction re-derive the same panel; failed calls
(`output-error`, `success:false`) never phantom-update it. No answer channel is needed — unlike
AskUserQuestion these tools are fire-and-forget. Individual calls stay collapsed in the tool-call
group.

**Mounting.** All agents, all channels (GitHub-issue conversations have session records too, so
their file persists the same way); no per-agent flag — the tools are opt-in by the model, and an
agent that never plans multi-step work never pays more than the four schemas.

**Acceptance.** Offline: `scripts/tasks.test.mjs` (in `pnpm test`) drives the store through the
reference semantics and the fold through a synthetic conversation, plus a parity check that
folding the events the store emitted reproduces the store's own list. Live:
`scripts/task-tools-probe.mjs` — three creates in one turn get ids 1..3 (mutex), updates report
`statusChange`, `TaskList` reflects them, the session record gains a `session_backup`, and a
second submission lists the same state and `TaskGet`s a full record.
