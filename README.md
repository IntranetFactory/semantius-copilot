# Hoth Trip-Planner POC

**Multi-agent, multi-tenant dynamic skill delivery** on Flue + Cloudflare Sandbox: a
whole agent (instructions + model overrides + ALL its skills) is serialized as **one
JSON string** — the *agent bundle* — deployed by NAME into Cloudflare KV
(`pnpm deploy:agent <name>` → `agentdef:<name>`, no TTL). Session creation submits just
`{ agentName }`; the route resolves the named definition, snapshots it per session, and
reconstructs it into the sandbox. Which agent a session runs is data, not code.

(The POC originally ran a second backend — "A", the same agent hard-baked into a
container image — to prove image-baked and dynamically-delivered skills behave
identically. That thesis was proven — see [`hoth-poc-plan.md`](./hoth-poc-plan.md) and
git history — and backend A has since been removed; "backend B" naming survives in the
worker/package names.)

See [`hoth-poc-plan.md`](./hoth-poc-plan.md) for the original design and acceptance criteria.

## Deployed

| Deployable | URL |
| ---------- | --- |
| Frontend — chat (users, Semantius token) | https://hoth-poc-frontend.ma532.workers.dev/chat |
| Frontend — copilot (users, better-auth cookie) | https://hoth-poc-frontend.ma532.workers.dev/copilot |
| Frontend — admin console | https://hoth-poc-frontend.ma532.workers.dev/admin |
| Backend — dynamic bundle (multi-agent) | https://hoth-poc-backend-b.ma532.workers.dev |

Both run on Cloudflare Workers (account `Ma@adenin.com`). The backend owns a container
app (Containers) and a private KV namespace; the frontend is three static pages served from
Workers assets with the backend URL baked in at build time.

**Three pages, three builds, one Worker.** `/chat` is the user chat page (`chat.html` →
`src/chat-main.tsx` → `ChatApp.tsx`, authenticated by the user's own Semantius token);
`/copilot` is the same workbench authenticated by a better-auth session cookie instead
(`copilot.html` → `src/copilot-main.tsx` → `CopilotApp.tsx`); `/admin` is the operator
console (`admin.html` → `src/admin-main.tsx` → `App.tsx`, authenticated by the deployment
API key). Separate Vite entries so the user bundles never carry the admin code. The two
user pages share `ChatWorkbench.tsx` and differ only in the credential they collect, so
they cannot drift apart.

No path is declared anywhere: Workers assets serves each `<name>.html` at `/<name>` via its
default `auto-trailing-slash` html_handling, and the one place the paths are written down in
code is `CHAT_PAGE`/`COPILOT_PAGE`/`ADMIN_PAGE` in `frontend/src/lib/session.ts`. There is
deliberately **no `index.html`**, so `/` matches no asset; `not_found_handling` is
`404-page` (`public/404.html`), **not** `single-page-application`, so `/` and every typo
answer a real 404 instead of silently rendering a page that looks like it worked. That 404
page names **no path**, not even in an HTML comment — it is what an unauthenticated prober
sees, and `/admin`'s existence is not something to advertise.

## Layout

```
agents/      SOURCE OF TRUTH for every agent. One folder per agent:
             agents/<name>/agent.jsonc      REQUIRED config (folders without it are
                                            skipped) — schema: core/agent.schema.json
             agents/<name>/INSTRUCTIONS.md  optional, appended to the config instructions
             agents/<name>/skills/<skill>/  0..16 skills (each needs a SKILL.md)
core/        Host-agnostic Flue-core seams (no Cloudflare imports):
             agent-bundle format + validation, tar reconstruction (2-RPC),
             provisionAgentSkills, egress/secret broker interface, API-key guard,
             Semantius user identity (identity.js — `<org>:<jwt>` → userinfo, and
             better-auth session cookie → /session + /session/token),
             deterministic skill-check, container-cost query + pricing (cost.js).
             `@hoth/core/node` adds the bundler library (fs walk, JSONC parse via
             jsonc-parser).
backend-b/   Flue+CF Worker — the MULTI-AGENT backend: one generic `main` Flue agent;
             the named agent definition a session references (`{ agentName }` at ingest,
             resolved from KV `agentdef:<name>`) decides instructions, model, skills.
             First-turn identity rides the creating send's `initialData` (see plan §6).
frontend/    React + Vite, three pages — `/chat` and `/copilot` (the shared
             ChatWorkbench: New-session button, agent dropdown fed by the bundler
             output; token vs. session-cookie auth) and `/admin` (Data browser +
             Costs tab). `/` is a real 404.
scripts/     bundle.mjs (agent bundler CLI) · deploy-agent.mjs (bundle one agents/
             folder and PUT it to the backend as a named KV definition) ·
             node-smoke.mjs (portability, zero Cloudflare) · acceptance.mjs (C2–C5) ·
             admin.test.mjs · chat-probe.mjs (one real LLM turn against the deployed
             backend — the observability verification driver) · mint-token.mjs
             (`pnpm mint-token` — a Semantius user token for the chat gate) ·
             session-costs.mjs (`pnpm sessions` — LLM cost per session, from
             Braintrust) · cf-costs.mjs (`pnpm costs` — Cloudflare container cost
             per session, same query as the admin Costs tab) ·
             lib/semantius.mjs (the .env-driven token exchange those share).
```

## Agents & the agent bundle

`pnpm bundle` (scripts/bundle.mjs) scans `agents/`, skips folders without `agent.jsonc`
(with a warning), and per agent emits ONE JSON — the **agent bundle**:

```jsonc
{
  "agentName": "hoth-trip-planner",   // = folder name
  "version": "<sha256-16>",           // content hash over config + all skill files
  "baseImage": "node",                // selects the Sandbox binding
  "instructions": "…",                // agent.jsonc instructions + INSTRUCTIONS.md (appended)
  "model": "openrouter/…",            // optional, pre-normalized (see LLM configuration)
  "modelBaseUrl": "https://…",        // optional, from model_base_url
  "proxyWhitelist": ["postman-echo.com"],  // optional — DENY-ALL egress when absent
  "skills": { "planner": { "SKILL.md": "…", "references/…": "…" } }  // 0..16 skills
}
```

Artifacts per run: `dist-bundle/<name>.agent.json` (canonical, used by acceptance and
chat-probe) and `frontend/src/generated/agents/<name>.json` (glob-imported by the UI —
a NEW agents/ folder shows up in the frontend agent dropdown after re-running `pnpm bundle`,
no code change). Limits: ≤16 skills, ≤64 files & ≤1 MiB per skill, ≤4 MiB per agent,
instructions ≤64 KiB (`core/src/agent.js`). Zero-skill agents (no `skills/` folder) are
valid — nothing is provisioned, the bundle still carries instructions/model.

**Deploying an agent** (`pnpm deploy:agent`, scripts/deploy-agent.mjs):
builds `agents/<name>/` fresh with the same loader and `PUT`s it to the backend's
authenticated `/agents/:name` route, which validates the bundle (the trust boundary —
hostile bundles are rejected 422 here) and stores it as KV `agentdef:<name>` — **no TTL,
overwritten on every deploy**. Sessions then ingest with
`POST /sessions/agent {"agentName":"<name>"}` → `{ "sessionId": "<org>-<sub>-<32 hex>", … }`;
the route **mints the session id** (see "Session ids" below — the caller supplies none)
and snapshots the definition to
`agent:<sessionId>` (24 h TTL), so redeploying a definition never mutates in-flight
sessions, and an undeployed name is a 404. The body also accepts an optional
`sessionContext` object (see "Per-session data channels" below). The KV key name is authoritative — `--as`
deploys a folder under a different key (generic alias mechanism; nothing in the app
depends on one — the GitHub channel reads `agentdef:hoth-trip-planner` directly):

```bash
pnpm deploy:agent hoth-trip-planner                     # agents/<name> -> agentdef:<name>
pnpm deploy:agent --all                                 # every agents/ folder
```

## Skill delivery to the model

Skill delivery has TWO legs, and both are required:

- **Files on disk** — `provisionAgentSkills` extracts the bundle into
  `/workspace/.agents/skills/` (eagerly at ingest, self-healed on every delivered
  message). This makes skill resources actually runnable (bun/node scripts, reference
  files) and feeds Flue's workspace-skill discovery when that works.
- **Explicit catalog** — the bundle's SKILL.md frontmatter is parsed into
  `{name, description}` entries (`skillCatalogFromBundle`, `core/src/skill-catalog.js`)
  that ride the creation seed (frontend `AGENT_SEEDS`) and the stored agent meta;
  `backend-b/src/agents/main.ts` mounts each entry with `useSkill()`, whose
  instructions point at the on-disk SKILL.md. This is what guarantees the model SEES
  the skills in its system-prompt "Available Skills" section.

Why the second leg exists: Flue discovers workspace skills once at session init and
caches the catalog for the conversation. Fully provisioned sessions still
composed system prompts with an EMPTY catalog (verified 2026-07-23 on the
2.x nightly: the Braintrust-logged system prompt had no skills section while the
deterministic skill-check proved the same container held all 70 files, and the SDK
`exists()` probe — surfaced as `sdkExists` in the skill-check response — returned
true when tested moments later). Catalog
descriptions are truncated to 1024 chars (Flue's SkillDefinition cap). When
workspace discovery does find the disk copy, the discovered skill wins the
name-merge over the mounted definition — same content either way. That
discovered-wins merge is restored by our `@flue/runtime` patch (see
Prerequisites): the stock nightly THROWS on the name conflict instead, and
because the ingest pre-warm provisions the files before the first send,
discovery often does see them — every submission of such a session then
failed with a generic `internal_error` (root-caused via `wrangler tail`
2026-07-26; backend B was undriveable until the patch).

Observability: the backend logs every llm span to Braintrust (exact system
prompt in span metadata `flue.system_prompt`, messages as the span input) and
exports OTel GenAI traces to Arize AX. Check there first when the model behaves
as if instructions or skills are missing.

## Prerequisites

- Node **>= 22.18** (Flue requirement; `nvm use 22.22.0`).
- pnpm, Docker (for building the sandbox container image), a Cloudflare account with
  **Workers Paid + Containers** and **Workers AI** enabled.
- Three dependency patches under `patches/` (applied automatically by `pnpm install`):
  - `@earendil-works/pi-ai` — OpenRouter **billed** cost: adds the
    OpenRouter-only `usage: { include: true }` request field (usage
    accounting) and prefers the returned inline `usage.cost` over the
    model-catalog estimate for `cost.total` in `parseChunkUsage`
    (`dist/api/openai-completions.js`). Stock pi-ai never requests
    accounting and discards the field, so every downstream cost —
    conversation metadata, Braintrust, `pnpm sessions`, Arize `llm.cost.*` —
    was a catalog estimate. No-op for non-OpenRouter providers and when
    OpenRouter omits the field. Keyed to the exact pi-ai version — on a
    bump, re-create (same two edits) or drop if upstream keeps the field.
  - `@flue/runtime` — `mergeSkillCatalog` again lets a workspace-discovered
    skill silently override a same-name `useSkill()` definition instead of
    throwing. Backend B delivers every bundle skill on BOTH legs by design
    (files on disk + explicit mount, see "Skill delivery to the model"), and
    whether init-time discovery sees the disk copy is a race — on sessions
    where it does, the stock nightly failed every submission with
    `[flue] Skill name "planner" appears in both agent definition and
    workspace discovery`. The upstream throw guards against a real risk —
    the workspace is runtime-writable, so a silently-winning discovered
    skill could shadow a vetted code-defined one (injection) — but here
    both legs are the same bytes from the same validated bundle (the mount
    is built from the very SKILL.md that is provisioned to disk), so the
    collision is deliberate redundancy, not ambiguity, and discovered-wins
    is safe (it even carries the untruncated description). Residual
    exposure: a same-named SKILL.md from any OTHER source (e.g. an agent
    writing its own) would now silently shadow a mounted definition.
    **On every Flue bump:** the patch is keyed to the exact nightly
    version — re-create it (`pnpm patch @flue/runtime@<new-version>`, remove
    the conflict `throw` in `mergeSkillCatalog`, `pnpm patch-commit`) unless
    upstream made the merge tolerant, or B stops double-delivering skills.
  - `@durable-streams/client` — opens the held **SSE** connection on the first `updates`
    request in `live:'sse'` mode. The stock 0.2.6 client (still pinned by @flue/sdk v2) only
    opens SSE after reaching up-to-date, so while an agent is actively generating (never
    up-to-date) it busy-polls catch-up reads at network speed — a request flood.
    `node scripts/verify-patch.mjs` proves the first request now carries `live=sse`.
  - (The beta-era `@flue/cli` patch is gone: Flue v2 replaced the `flue` CLI with Vite —
    `@flue/vite` + `@cloudflare/vite-plugin`.)

## Build & run

```bash
pnpm install
pnpm bundle            # scan agents/ -> one agent bundle per folder; round-trip assert; emit
pnpm smoke             # Node smoke test — core agent-bundle flow with zero Cloudflare present

pnpm dev:frontend      # http://localhost:5173  (talks to localhost:3584 in dev)
                       # Vite serves the FILENAMES: /chat.html, /copilot.html, /admin.html.
                       # The extension-less /chat, /copilot, /admin paths are Workers assets
                       # html_handling, so they exist only on a deployed build.
```

## Deploy

```bash
pnpm deploy            # bundle + deploy worker + all named agent defs + frontend, in order
pnpm deploy:agents     # bundle + deploy:agent --all + deploy:frontend — ships agents/
                       # content changes (named KV definitions for ingest, frontend-built
                       # bundles for the dropdown + turn-1 seed; the worker is the generic
                       # host and needs no redeploy). NEW sessions only; the GitHub
                       # channel reads agentdef:hoth-trip-planner, so --all covers it.
# or individually:
pnpm deploy:b          # vite build + wrangler deploy the backend worker
pnpm deploy:agent <n>  # bundle agents/<n>/ and PUT it to KV as agentdef:<n> (see above)
pnpm deploy:frontend   # vite build (URL from frontend/.env.production) + wrangler deploy
```

First deploy of the backend creates its Cloudflare Container application and prompts to
confirm. It needs **Workers AI** and **Containers** enabled on the account. The frontend
build reads the backend URL from [`frontend/.env.production`](./frontend/.env.production).

The frontend deploy publishes all three pages: `/chat`, `/copilot` and `/admin`, plus
`404.html` for `/` and everything else.

## Authentication

The backend has **two auth surfaces** (`core/src/auth.js`), and they take different
credentials:

- **admin / CLI** — `/admin/*`, agent deploys, skill-checks, session deletes. One shared
  deployment secret, `Authorization: Bearer <API_TOKEN>` (`apiKeyGuard`), failing closed
  (503) when `API_TOKEN` is unset.
- **user chat** — creating a session and talking in it. The caller's own credential
  (`userTokenGuard`): a Semantius token, or a better-auth session cookie. No API key is
  accepted here, so a chat client can never browse data or deploy.

Set the admin key as a Cloudflare secret, and locally via `.dev.vars`:

```bash
node -e "console.log('hoth_'+require('crypto').randomBytes(24).toString('base64url'))" > .api-token
cd backend-b && printf 'API_TOKEN="%s"\n' "$(cat ../.api-token)" > .dev.vars   # local dev
wrangler secret put API_TOKEN --config backend-b/wrangler.jsonc                 # deployed (paste the value)
```

The **frontend never bakes the key in** — you type it into the API-key field on the *admin*
page (persisted to `localStorage`), and it rides every admin request. The API key says
*this is our operator console*; **who** is chatting is the separate Semantius identity
below.

### User identity — no chat without a verified Semantius user

Chat is only open to a real Semantius user, proven by one of two credentials. **The bearer
always wins**; the cookie is consulted only when there is no `Authorization` header:

| credential | sent as | verified by |
| --- | --- | --- |
| Semantius token | `Authorization: Bearer <org>:<jwt>` | `<org>`'s OIDC userinfo endpoint |
| better-auth session cookie | `x-better-auth-cookie: <value>`, or a normal `Cookie` header | `GET /session` + `POST /session/token` on the shared better-auth host |

Both end at the **same verdict object** — `{ org, jwt, user }` — so everything downstream
(session-id minting, the ownership gate, the sandbox's `SEMANTIUS_ORG`, egress injection)
is credential-blind. Only the guard knows which one arrived.

#### Semantius token

The transport form is **`<org>:<jwt>`** because the JWT alone doesn't say who issued it, and
the org is what selects the tenant host (every org has its own subdomain).

The guard splits the value on the first colon and verifies it live
(`core/src/identity.js`), by calling that org's OIDC userinfo endpoint with the JWT as a
bearer:

```
GET https://<org>.semantius.cloud/api/auth/oauth2/userinfo
Authorization: Bearer <jwt>
→ 200 {"sub":"user3","name":"Wei Chen","email":"admin@test.com","email_verified":true}
```

The issuer decides — no key material, JWKS fetch, or clock handling lives in this repo;
an expired, malformed, foreign, or unknown-org token gets a non-2xx there and a **401**
here, with no session written.

#### Session cookie (better-auth)

A user who signed in to the Semantius app already holds a better-auth session cookie, and
that is the only credential a copilot embed can present — so when no bearer is sent, the
gate takes the cookie instead. Two server-to-server calls against
`SEMANTIUS_SESSION_BASE_URL` (default `https://api.semantius.cloud`) turn it into the same
verdict:

```
GET  /session                          ← AUTHENTICATION, every request
Cookie: __Secure-better-auth.session_token=<value>
→ 200 {"session":{…},"user":{"org":"tests","sub":"user3","name":"Wei Chen","email":"admin@test.com"}}

POST /session/token                    ← the sandbox's credential, CACHED
x-jwt-exchange-api-key: <JWT_EXCHANGE_API_KEY>
{"sessionCookie":"<value>","expiresIn":86400}
→ 200 {"token":"<jwt>"}
```

Notes that matter:

- **`user` already is the projected claim set** this repo keeps (`org`, `sub`, `name`,
  `email`), so the org needs no guessing and no second identity lookup. Any org's host
  validates a session created by any app sharing the same `BETTER_AUTH_SECRET` and
  database, so one host serves every tenant — the tenant comes from the session's active
  organization, not from the URL.
- **The exchange is what the sandbox needs.** A cookie is useless at egress; the minted JWT
  is what gets injected in place of the `__sak__` sentinel, exactly as on the bearer path.
- **The exchange is cached in KV** under `authjwt:<sha256 of the cookie>` for 1 h (the JWT
  itself lasts 24 h). Without it, every chat request would mint a fresh token *and* rewrite
  it onto the session record. Only the cookie's **hash** is ever stored, never the cookie.
- **Two transports, one credential.** Browsers cannot set `Cookie` from `fetch`, and this
  backend is a different origin from the frontend Worker with wildcard-origin CORS and no
  credentials — so a real cookie can never ride cross-site. The `x-better-auth-cookie`
  header carries the value instead, and the backend rebuilds a proper `Cookie` header for
  the upstream hop. Custom request headers need no CORS change (Hono's `cors()` echoes
  `Access-Control-Request-Headers` when `allowHeaders` is unset).
- **The exchanged JWT is not re-verified** against userinfo: the cookie was just validated
  by the issuer, and the JWT came from the issuer authenticated with our own exchange key.
  This does assume `/session`'s `user.sub` is what userinfo reports as `sub` — the
  ownership gate compares `{ org, sub }`, so if those diverged, a `/chat` session could not
  be opened from `/copilot`.
- `JWT_EXCHANGE_API_KEY` is a **secret** (`.dev.vars` locally,
  `wrangler secret put JWT_EXCHANGE_API_KEY` when deployed). Unset → the cookie path
  answers **503** rather than a misleading 401; bearers keep working.

#### What gets pinned to the session

On success the verified identity's three facts are pinned to `session_context` on THE
session record — and nowhere else:

| field | value | read by |
| --- | --- | --- |
| `user` | the projected claims (`sub`, `name`, `email`, `email_verified`, `org`, `verifiedAt`) | the chat gate, to prove ownership on every later request |
| `semantius_org` | the verified org (the token's `<org>` half, or the session's active organization) — **which tenant** the session acts on | `provisionSemantiusEnv` (`SEMANTIUS_ORG` in the container), and the echo egress header `x-semantius-org` |
| `semantius_user` | the verified `sub` — **as whom** it acts | the record's own audit surface (data browser, session listing) |

`semantius_jwt` (the bare credential — the presented one on the bearer path, the exchanged
one on the cookie path) sits beside them; see "Egress" below. **Nothing identity- or
tenant-shaped is ever taken from the request body**: those four keys are stripped from
whatever `sessionContext` the client sends and rewritten from the verified identity, so no
caller can hand itself an org, a `sub`, or a user. The ingest response echoes `user` (what
the frontend's status line shows) — there is no separate tenant field on the record,
because the tenant *is* `semantius_org`.

The **chat gate** (`app.use('/agents/main/*', …)` in `backend-b/src/app.ts`) then admits
a conversation only when its session record carries such a `user` — send, history read,
and stream alike answer **401** otherwise, so a session created with no token can be
provisioned and skill-checked but never chatted with. Consequences worth knowing:

- The credential is verified **per request** on the chat surface (`userTokenGuard` runs with
  the gate), not pinned at creation: tokens live ~1 h while a session lives 24 h, so the
  client re-presents a fresh one and the gate re-checks it against the record's `user`. When
  the verified JWT differs from the stored one, the whole identity trio
  (`semantius_jwt`/`semantius_org`/`semantius_user`) is re-stamped in one merge — that is
  how a long conversation's sandbox credential stays live. Write-on-change only, which is
  also why the cookie path caches its exchange: a freshly minted JWT every request would
  rewrite the record every request.
- GitHub-issue conversations reach the same agent through **in-process dispatch**
  (`channels/github.ts`), never through this HTTP route, so the webhook path is unaffected.
- Both user pages require the credential box before **New session** is enabled, and print
  the resolved user (`Wei Chen <admin@test.com> @tests`) in the status line.

`pnpm mint-token` (`scripts/mint-token.mjs`) mints a token to paste there: it exchanges a
Semantius API key for a user JWT via the `client_credentials` grant against
`https://<org>.semantius.cloud/token` and prints `<org>:<jwt>`. Credentials come from a
gitignored `.env` at the repo root (`SEMANTIUS_API_KEY`, `SEMANTIUS_ORG`), loaded via
Node's built-in `process.loadEnvFile` — no dotenv wrapper; already-set environment
variables win when there is no `.env`. The exchange lives in `scripts/lib/semantius.mjs`,
shared with `chat-probe.mjs` (which mints per run, since the gate would reject it
otherwise) and the acceptance suite. Tokens are short-lived (~1 h), so mint per session.

## LLM configuration

Two layers:

- **Env default** (`configureLlm()` in `core/src/config.js`, wired per backend in
  `src/llm.ts`): `LLM_PROVIDER` (`cloudflare` | `openrouter` | `custom`), `LLM_MODEL`, and
  optional `LLM_BASE_URL` (required for `custom`) are plain wrangler `vars`; only
  `LLM_API_KEY` is a secret (`.dev.vars` locally, `wrangler secret put` deployed). Default:
  OpenRouter + `deepseek/deepseek-v4-flash`. Keep the vars/secret split — the key is the
  only secret value.
- **Per-agent override** (`agent.jsonc`): optional `model` and `model_base_url`. The
  bundler normalizes `model` with a prefix rule — a first path segment that is a known
  provider (`openrouter`, `custom`, `cloudflare`) is kept as-is, anything else gets
  `openrouter/` prepended (so `"tencent/hy3"` means `openrouter/tencent/hy3`). At runtime
  `agentModelSpecifier()` (`src/llm.ts`) resolves the override **metadata-preservingly**,
  because Flue trusts a provider's catalog metadata blindly (`reasoning` gates thinking,
  `contextWindow` sets the compaction threshold, `maxTokens` caps output): an openrouter
  model that Pi's catalog knows keeps its `openrouter/...` specifier and full catalog
  entry (e.g. `tencent/hy3` 256k context, `xiaomi/mimo-v2.5-pro` 1M context — differing
  per-agent context windows come straight from the catalog); with `model_base_url` set,
  a dedicated one-model provider `agent-<name>` reuses the catalog entry with only the
  transport swapped; only a catalog miss falls back to a conservative placeholder entry
  (no reasoning, 128k window). `model_base_url` overrides transport only — auth is always
  the worker-wide `LLM_API_KEY` secret. The override is applied per session from the
  agent's bundle.

## Egress (per-agent proxy_whitelist)

Egress from an agent's sandbox is governed by the agent's own `proxy_whitelist` in
`agent.jsonc` — an array of host globs (`"www.semantius.com"` exact, `"*.semantius.ai"`
subdomains only). **Deny-all when absent**: an agent without the property (or with an
empty list) can make no outbound request at all. There is no global whitelist anymore.
The list rides the agent bundle as `proxyWhitelist`; the ingest route writes it into
**THE session record** — `session:<sessionId>`, the single mutable per-session document
(browse meta, `egress_secrets`, `whitelist`, and the four data channels) — plus the
`container:<containerId> → sessionId` pointer, the only containerId-keyed KV entry
(outbound handlers receive only `ctx.containerId`, and `idFromName` is one-way; every
other code path *computes* the container id — the record's `containerId` field is
stored for visibility, not read by code). Both
outbound handlers in `backend-b/src/cloudflare.ts` resolve pointer → session record per
invocation; the agent initializer self-heals the egress fields each message
(write-on-change only — a deleted session stays deny-all). The sentinel→credential swap
(`brokerEgress`) and the zero-knowledge `egress_secrets` injection both sit behind the
whitelist gate; a request to a non-whitelisted host is rejected with 403 even when it
carries the credential sentinel.

### `egress_secrets` — per-session downstream credentials

A session's downstream credentials live on the record as a **map of host glob →
credential**, matched with the same globber as the whitelist:

```json
"egress_secrets": { "postman-echo.com": "hoth-tourism-key-671e2acf-5fac94ed-…" }
```

The container is given **nothing** for these hosts — not the value, not a placeholder, not
the knowledge that auth happens. The skill fetches the host with no `Authorization` header;
[`injectAndForward`](core/src/egress.js#L246) looks the host up in the map and *adds* the
header on the way out. Zero-knowledge injection: the sandbox cannot leak, misdirect, or
even name a credential it has never seen.

Rules, all covered by `pnpm test`:

- **Registering a host as credential-required is what makes absence fatal.** A host handled
  by this path with no matching map entry gets **403** — never an unauthenticated forward.
  That's the fail-closed rule behind plan §13 C5: a chat session's credentials are never
  re-minted, so an expired session whose policy self-heals recovers its whitelist but not
  its ability to call the downstream API.
- **Mint-if-absent, per host.** A warm entry never rotates; a new host can be added to a
  live session without touching existing ones.
- **Per session, keyed by the container→session pointer**, so tenant A's key can never
  surface in tenant B's container. C2 proves it: two concurrent sessions present different
  credentials to the same upstream.

The POC's only entry is the fictional **Hoth Tourism API** — the trip-planner skill's
partner API, played by `postman-echo.com` because it reflects the headers it received, which
is what makes the injection assertable. There's no vault here, so ingest mints a per-session
stand-in for what production would store as a secret *reference* (plan §12). Adding another
downstream credential is a map entry, not a code change at egress.

**Not in this map: the session user's Semantius JWT** (`session_context.semantius_jwt`).
It's the one credential with two jobs — the backend verifies it to authenticate the user
*and* egress forwards it — so it belongs with the identity, and it needs the sentinel swap
rather than zero-knowledge injection because the vendored `semantius` CLI insists on a
credential in its env. Also not in this map: `SEMANTIUS_API_KEY`, which is a Worker secret
guarding *inbound* admin routes and never enters a session record or a container.

**The sandbox acts as the session's user (Semantius).** There is no shared org API key
in this path any more — the credential is the JWT of the user who opened the session.
Three pieces make that work:

1. **The image bakes no credential and no org.** `backend-b/Dockerfile` sets only
   `ENV SEMANTIUS_JWT=__sak__` — the sentinel (`SEMANTIUS_JWT_SENTINEL`,
   `core/src/config.js`). `SEMANTIUS_ORG` is deliberately *not* baked: a hardcoded org
   would point every session at one tenant.
2. **Per-session container environment.** `provisionSemantiusEnv`
   (`core/src/sandbox-env.js`) calls the sandbox SDK's `setEnvVars` with
   `SEMANTIUS_ORG=<the token's org>` and `SEMANTIUS_JWT=<sentinel>`. Applied at ingest
   (pre-warm) and re-applied by the agent's start callback on every message, because a
   cold container comes back with only the image's environment — the same absent→write
   self-heal shape as skill provisioning. A session with no verified user gets no
   Semantius environment at all, so its CLI is unconfigured rather than pointed at
   someone else's tenant.
3. **The swap at egress.** The catch-all outbound handler resolves
   `session_context.semantius_jwt` per invocation and hands it to `brokerEgress` as the
   secret: every outbound header containing the sentinel gets it replaced with that JWT,
   and requests to `SEMANTIUS_HOSTS` (`*.semantius.ai`, `www.semantius.com`)
   additionally have `Authorization` overwritten with `Bearer <jwt>` **before** the
   sentinel scan, so the swap never re-touches the injected header. **No fallback:** a
   session without a JWT has no credential to lend, so a sentinel-bearing request fails
   closed (503) instead of silently borrowing org-wide access. The whitelist 403 gate
   stays first — a credential is never attached to a denied request.

The token arrives as the request's own `Authorization: Bearer <org>:<jwt>` on
`POST /sessions/agent` (and on every chat request), which the user guard verifies (see
"User identity"). Ingest stores it split into its halves — the **bare** `semantius_jwt`
beside `semantius_org` and `semantius_user` — in the `session_context` field of THE
session record (24 h TTL, deleted with the session; the self-heal preserves it but can
never reconstruct it — only a live token can). The `<org>:` prefix is a transport
convention for getting the token to the backend, never part of the credential.

Proven live by the acceptance `credentials` checks: inside the container
`SEMANTIUS_JWT=__sak__` and `SEMANTIUS_ORG=<org>` are set with **no `SEMANTIUS_API_KEY`
at all**, and `semantius whoami` comes back as the session's user (`admin@test.com` /
Wei Chen / org `tests` against `https://tests.semantius.ai`). The semantius-admin agent's
instructions tell it the workspace is already authenticated as that user, so it never
asks for an API key the way the vendored skill docs otherwise would.

**HTTPS transport note:** with `interceptHttps = true` the sandbox runtime provisions the
interceptor CA at `/etc/cloudflare/certs/cloudflare-containers-ca.crt`, MITMs port 443,
and handles CA trust **out of the box**: at container boot the in-container runtime sets
`NODE_EXTRA_CA_CERTS` to the CA and merges it into the system bundle, pointing
`SSL_CERT_FILE`, `CURL_CA_BUNDLE`, `REQUESTS_CA_BUNDLE`, and `GIT_SSL_CAINFO` at the
merged bundle — every exec'd process (node, bun/semantius, curl, python, git) inherits
working trust, so **a whitelisted host works from every tool** with no per-image wiring
(verified by inspecting `/container-server/sandbox` in the `0.12.3` image; proved live
by the `curl-check` skill-check op in acceptance). Plan §7's early "port 443 hangs"
measurement predates `interceptHttps` — with interception off, no CA exists and TLS
against the proxy cannot validate. ALL sandbox egress is HTTPS now — `opening-times.js`
calls the echo host over 443 and the injected credential rides inside TLS.

### Session ids — server-minted and tenant-prefixed

A chat session id is `<org>-<sub>-<32 hex>` — e.g.
`tests-user3-1ea1a17e8e68456ab587986db90a4fc9` — minted by the ingest route from the
identity the user guard just verified (`mintSessionId`, `core/src/config.js`). The route
takes **no id from the caller**: the browser used to generate one with
`crypto.randomUUID()`, which made "server-minted, globally unique, never reused"
(plan §6) a promise nobody enforced and would have let a client stamp any tenant it liked
on its own KV keys.

Why the tenant rides the id: it is the only place that puts it in every key derived from
the session (`session:<id>`, `agent:<id>`). Before this, the tenant lived only *inside*
the record (`session_context.semantius_org`), so "every session of org X" meant reading
every value, and a cross-tenant mistake was invisible in a key listing. It goes INSIDE
the id rather than in front of the group prefix (`session:tests-user3-…`, never
`tests:user3:session:…`) because `kvGroupOf` splits on the first colon and every KV
prefix listing is left-anchored — the other order would create one browser group per org
and break `session:`/`agentdef:` listing.

Shape constraints, all enforced by `mintSessionId` and asserted in `pnpm test`:

- **Hyphens, not colons.** `:` would survive the SDK's `sanitizeSandboxId` (0.12.3
  validates, it does not rewrite), but the id is also spliced into `sandbox-<id>` and
  into container preview hostnames, which are DNS labels.
- **≤63 characters**, because `sanitizeSandboxId` rejects longer ids — a violation would
  surface as a broken container at the end of provisioning, not as a validation error.
  Hence the segment caps (org ≤16, sub ≤12) and the dash-stripped UUID tail: 62 worst case.
- **Injective segments.** An identity value that does not survive slugging (too long,
  uppercase, punctuation — a UUID-shaped `sub`) is truncated *and* suffixed with a short
  FNV-1a hash of the original, so two identities can never collapse onto one prefix and
  quietly break tenant scoping.

Not every conversation id has this shape: **channel conversations** are keyed by their
channel's own instance id (`github:v1:owner:<o>:repo:<r>:issue:<n>`, minted by
`@flue/github`) and have no Semantius user at all. `isValidSessionId` stays the shape
gate on the routes that still take an id (`/sessions/:id/skill-check`,
`DELETE /sessions/:id` — both admin-key surfaces). Ownership is enforced by the chat gate
against `session_context.user`, never by the id's prefix: the prefix is for operators
reading the key space, not an access-control decision.

**Session substrate expires 24 h after last activity (fail-closed by design):** the
bundle snapshot (`agent:<id>`), THE session record (`session:<id>`), and the container
pointer (`container:<containerId>`) all carry a 24 h TTL; every merge into the session
record (e.g. the per-response `session_state` mirror) refreshes its TTL, so an idle
session expires 24 h after its last response. A chat session's `egress_secrets` are never
re-minted after expiry (plan §13 C5) — an expired chat session loses egress and, on a cold
container, its skills; start a new one. Named agent definitions (`agentdef:<name>`)
deliberately have NO TTL: they are deployable artifacts, overwritten by the next
`pnpm deploy:agent`, not session state. (Historical: the per-concern keys
`bearer:`/`tag:`/`whitelist:`/`context:<containerId>` and the interim
`egress:<sessionId>` record are gone — everything mutable merged into the session
record; orphaned keys drained via TTL. The record's own single-credential `bearer` field
became the `egress_secrets` map, and the client-chosen `tenantTag` was replaced by the
verified token's `semantius_org`; both drain the same way.)

## Data browser

The admin console's (`/admin`) **Data browser** tab navigates all Cloudflare-stored data as a generic
collection → record → detail tree, backed by the read-only `/admin/collections` routes
(behind the API-key guard; host-agnostic logic in `core/src/admin.js`, tests
in `scripts/admin.test.mjs`, `pnpm test`).

The raw **KV** collection is dated and ordered newest-first, not alphabetical. Three of the
four prefixes are session-scoped and all three resolve from the session records the browser
already reads: `session:<id>` and `agent:<id>` share the session id, and
`container:<containerId>` joins on the record's own `containerId` (`idFromName` is one-way,
so the key itself cannot be reversed). `agentdef:<name>` is a deployed definition, not
session-scoped — it gets no date and sorts last. The frontend does not reorder within a
group, so this ordering is entirely `listCollectionRecords`'.

Non-obvious constraint: Cloudflare cannot list Durable Object instances, so conversations
are enumerable only via the `session:<id>` KV records (THE session record, written at
ingest and merged into thereafter) — sessions whose record expired or predates the index
don't appear. Conversation *content* is streamed by the frontend via the Flue
conversation client, not an admin endpoint.

Token/cost usage in the Raw JSON view: Flue v2 dropped the beta's per-message
`metadata.usage` from the conversation read, so the agent re-attaches response metadata
via `useResponseFinish`. Every response carries `session_state` (the running
per-session totals, see "Per-session data channels"); the per-response `usage`/`model`
fields remain openrouter-specifiers-only — which includes catalog-known model
overrides, since `llm.ts` keeps their `openrouter/...` specifier; the
placeholder/custom catalogs register zero rates and would report $0.
`cost.total` is OpenRouter's **billed** amount: the `@earendil-works/pi-ai` patch (see
Prerequisites) requests usage accounting (`usage: { include: true }`, OpenRouter-only)
and prefers the inline `usage.cost` from the last SSE chunk over the catalog estimate.
Component costs (input/output/cache) remain pi-ai's model-catalog computation —
OpenRouter reports only the total — so components may not sum exactly to the total.
THE session record carries the mirrored `session_state` (and `payload`/`session_data`),
so the sessions collection shows all of it without opening the conversation.

## Container costs (the Costs tab)

The admin console's **Costs** tab shows today's Cloudflare **container** spend broken down
by session id: `GET /admin/costs` (behind the API-key guard) → `backend-b/src/costs.ts` →
Cloudflare's GraphQL Analytics API. The query and the pricing live in `core/src/cost.js`,
which `scripts/cf-costs.mjs` (`pnpm costs`) imports too, so the CLI and the UI cannot
disagree about the math. Unit tests in `scripts/admin.test.mjs` (`pnpm test`).

**The join is a container label, and it has to be.** Each session owns exactly one sandbox
(`getSandbox(ns, sessionId)` — the sandbox id *is* the session id), but Cloudflare's
`containersUsageAdaptiveGroups` dataset exposes no dimension carrying a name we choose.
Its dimensions are `instanceId` (platform-assigned, **not** derivable from the Durable
Object id), `applicationId`, `placementId`, `location`, `region`, `label(name: "…")` and
the time buckets; `sum` has `cpuTimeSec`, `allocatedMemory`, `allocatedDisk`, `txBytes`.
There is **no `containerName` dimension** — example queries that use one are wrong. So
`HothSandbox` (`backend-b/src/cloudflare.ts`) stamps `session=<sessionId>` on every
container it starts, by merging `labels` into the start options of both `start()` and
`startAndWaitForPorts()` — the two public paths into the SDK's
`startContainerIfNotRunning`, which resolves `options?.labels ?? this.labels`. It can't be
a plain `this.labels` assignment: the session id is only known once the DO has loaded
`sandboxName` from storage, which happens after field initialisation.

Only containers started **after that shipped** carry the label; anything else lands in the
view's `(unlabeled)` row rather than being dropped, so the total still adds up.

**Setup.** `CLOUDFLARE_ACCOUNT_ID` is a var in `backend-b/wrangler.jsonc` (not a secret).
`CLOUDFLARE_API_TOKEN` is a secret — create one at dash.cloudflare.com/profile/api-tokens
with **Account → Account Analytics → Read**, put it in `backend-b/.dev.vars` locally and
`wrangler secret put CLOUDFLARE_API_TOKEN --config backend-b/wrangler.jsonc` for the
deployed Worker. Without it the route answers `configured: false` **with the reason** —
never a silent $0.

**What the numbers mean.** Rates (list price, Workers Paid, per
[containers pricing](https://developers.cloudflare.com/containers/pricing/)): CPU
`$0.000020`/vCPU-s (active only), memory `$0.0000025`/GiB-s, disk `$0.00000007`/GB-s,
egress `$0.025`/GB. `allocatedMemory`/`allocatedDisk` come back as **byte-seconds**.
The monthly included allowance (375 vCPU-min, 25 GiB-h, 200 GB-h, 1 TB egress) is **not**
deducted, so an early-in-month total overstates the invoice; egress is priced at the
NA/EU rate, which is the cheapest, so that one line can understate. Analytics lags a few
minutes behind live traffic.

**Two money columns, two different windows, never summed.** `Container $ (today)` is the
UTC-day figure above; `LLM $ (session)` is `session_state.cost_total` off THE session record
— the session's running LIFETIME total. They sit side by side because adding a day figure to
a lifetime figure produces a number that means nothing. LLM cost comes from the same KV read
that supplies Agent and Started, so it shows `—` once the session record is gone.
`pnpm costs` does not show it (no KV binding from Node); `pnpm sessions` is the LLM-cost CLI.

**`session_sandbox` — the durable snapshot.** The Costs tab is a live read-through to today's
analytics, so a session's container spend disappears from it once the day rolls over. To keep
it, `HothSandbox` runs a small scheduled task that merges a `session_sandbox` node onto
`session:<id>`:

```json
"session_sandbox": { "cpu_seconds": 5.5, "memory_gib_seconds": 92.5, "disk_gb_seconds": 740,
                     "egress_bytes": 0, "cost_total": 0.0004,
                     "measured_at": "…", "window_start": "…", "window_end": "…" }
```

The task, and why it is shaped the way it is — every step here is a bug that was hit:

- **`onStart()` arms it** (a 5-minute poll, guarded by a DO-storage flag) and clears any
  stale stop time. **NOT `onStop()`.** Scheduling from `onStop` cannot work on
  `@cloudflare/containers@0.3.7`: its `alarm()` reads the schedule table *before* delivering
  stop events, then acts on that stale read — `const resultForMinTime = sql\`SELECT * FROM
  container_schedules\`` … `await this.syncPendingStoppedEvents()` (which is where `onStop`
  runs and inserts a row) … `if (resultForMinTime.length == 0) await
  this.ctx.storage.deleteAlarm()`. The row lands in SQLite and is orphaned: schedule present,
  alarm deleted, DO dormant, callback never runs. Re-arming from *inside* a scheduled
  callback is fine — that happens before the stale read.
- **`onStop()` only records `stoppedAt`.** No scheduling.
- **The callback waits 15 minutes after the stop** before reading. Cloudflare's analytics lags
  ingestion and the part still missing at stop time is exactly the container's final CPU, so
  an immediate read systematically undercounts. If `onStop` never landed, the first poll that
  sees a stopped container writes `stoppedAt` itself, so the wait always converges.
- **It retries up to 6 times when Cloudflare has nothing for the session yet**, 5 minutes
  apart. Ingestion lag is not a fixed number — 45 s in one measurement, over 15 min in another
  — and giving up after a single look is how a snapshot silently goes missing. That was the
  actual cause of the first two failed end-to-end runs.

Because the whole thing runs on a minutes-long fuse inside a Durable Object with no console,
it is observable and forceable (both behind the admin key):

```bash
GET  /admin/sessions/<id>/sandbox           # armed? tries? stoppedAt? last run + its outcome
POST /admin/sessions/<id>/sandbox           # snapshot NOW, skipping the settle wait
POST /admin/sessions/<id>/sandbox?in=30     # arm the SCHEDULED path with a short fuse
```

`?in=` exists because the production timings make a single test cycle ~30 minutes; it
exercises `schedule()` → `alarm()` → callback in under a minute. The `lastRun` breadcrumb
records every run's outcome — a swallowed error with no trace is indistinguishable from
"never fired", which is precisely the hole the first debugging round fell into.

Why it uses `mergeExistingSessionRecord` and never plain `mergeSessionRecord`: **`DELETE
/sessions/:id` does not stop the container.** It is three KV deletes; the container runs on
until `sleepAfter` (10 min) expires. So this callback routinely fires for sessions that were
deliberately deleted, and a create-when-absent merge would resurrect them *and* re-arm their
24 h TTL. No record, no write. The acceptance suite deletes every session it creates, so this
is the common path, not an edge case.

Idempotent by construction: the window is the session's whole life, so a container that
starts and stops repeatedly just recomputes a more complete total and overwrites the node.

**Worker and Durable Object cost is deliberately absent.** `workersInvocationsAdaptive`
dimensions are `scriptName`/`scriptTag`/`scriptVersion`/`environmentName`/`status`/
`usageModel`/`coloCode`/`dispatchNamespaceName`/`isDispatcher` — nothing session-shaped —
so a per-session Worker figure could only be an estimate, and this view reports what is
measured. LLM cost per session is a separate thing entirely and already tracked
(`session_state`, and `pnpm sessions` over Braintrust).

**If the label ever stops working**, `node scripts/cf-costs.mjs --introspect` dumps the
dataset's real dimensions and sum fields, and `--raw` dumps the unfolded response. The
fallback would be to group by `instanceId` and resolve instance → session out of band
(`wrangler containers instances`), which is why the label approach is preferred.

## Per-session data channels (session_context, payload, session_data, session_state)

Four per-session data channels, split by who may see and who may write them. All four
are visible on **THE session record** (`session:<id>`); the authoritative copies of the
agent-facing ones live in the conversation's Durable Object:

**`session_context` — infra-only, client-provided at creation.** Optional
`sessionContext` object on the ingest body (plain JSON object, ≤ 8 KiB serialized,
422 otherwise). Stored as the `session_context` field of THE session record
(24 h TTL, removed by `DELETE /sessions/:id`) and **never delivered to the agent, the
model, or the sandbox** — its two consumers are the identity gate at ingest and the egress
handler, both reading `semantius_jwt` (see "User identity" below and "Session-context JWT
injection" under Egress). The user pages (`/chat`, `/copilot`) have a credential textarea
(persisted in localStorage), but its value never travels in the body: it rides the request
HEADERS, and the identity fields are written from what the guard verified. Ingest is
create-only (it mints a fresh id per call and takes none from the caller), so the
credential cannot be swapped on a live session.

**`payload` — model-visible, client-provided at creation.** Optional `payload` field
on the creation seed (the `initialData` of the instance-creating send — Flue records
it exactly once; `payload` on later sends is ignored). The agent appends it verbatim
to its instructions ("Session payload …", ≤ 16 KiB serialized, silently dropped
otherwise) and mirrors it into the session record's `payload` field at each response
finish. `chat-probe.mjs --payload='{"k":"v"}'` exercises it end-to-end.

**`session_data` — model-writable, durable.** The `update_session_data` tool
(`main.ts`) persists key/value facts into `usePersistentState('agentData')` — durable
`state_write` records in the conversation's Durable Object, one instance per session.
Current values are surfaced back into the instructions ("Session data …") so later
turns (and cold containers) see what was stored, and mirrored into the session
record's `session_data` field at each response finish (including tool writes from the
same response). Flue natively provides both halves: `useInitialData` = what the
session is *about* (immutable), `usePersistentState` = what the agent has *learned*
(mutable from tool `run()`/lifecycle callbacks, never during render).

**`session_state` — infra-written runtime aggregation.** Running totals per session:
`input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`,
`total_tokens`, `cost_total` (OpenRouter billed USD, micro-dollar rounded),
`tool_calls_count`, `llm_calls_count`. Accumulated in the agent's unconditional
`useResponseFinish`: tokens/cost from `response.usage`, tool calls from
`response.toolCalls.length`, and LLM calls drained from `backend-b/src/usage.ts` — an
isolate-global `observe()` counter of Flue `turn` events (one per model call,
compaction included; isolate-local, so a mid-response eviction undercounts and an
aborted submission's turns fold into the next response). The authoritative copy lives
in `usePersistentState('sessionState')` (the DO record stream); each response also
(a) attaches `session_state` to the response metadata (visible via `?view=history`
and the Raw JSON view) and (b) fire-and-forget merges state/data/payload into THE
session record (`mergeSessionRecord` — best-effort, healed at the next response; also
refreshes the record's 24 h TTL, keeping active GitHub conversations browsable).

**`session_sandbox` — infra-written, written once per container stop.** Not a channel like
the four above: nothing in the agent, the model or the sandbox reads it. It is the durable
mirror of this session's Cloudflare CONTAINER spend (`cpu_seconds`, `memory_gib_seconds`,
`disk_gb_seconds`, `egress_bytes`, `cost_total`, plus the window it was measured over),
written by `HothSandbox.recordSandboxCost()` — a scheduled task armed at container start that
fires 15 minutes after the container stops — so the figure survives the Costs tab's
today-only window. Written with
`mergeExistingSessionRecord`, so it can never resurrect a deleted session — see "Container
costs" for why that matters.

## GitHub channel (backend B)

`backend-b/src/channels/github.ts` (`@flue/github`) connects IntranetFactory/hoth-poc to
the `main` agent: `issues.opened` and `issue_comment.created` dispatch one conversation per
issue; replies are posted via the `comment_on_github_issue` tool and carry a
`<!-- hoth-agent-reply -->` marker the webhook skips (loop guard). The agent instructions
must insist on the tool — otherwise the model answers in plain conversation text and
nothing appears on GitHub.

- Webhook endpoint: `https://hoth-poc-backend-b.ma532.workers.dev/channels/github/webhook`,
  mounted in `app.ts` **before** the API-key guard (auth is `X-Hub-Signature-256`, not the
  bearer). The explicit early mount is load-bearing.
- GitHub conversations run the trip-planner agent directly from the no-TTL KV entry
  `agentdef:hoth-trip-planner` (`GITHUB_AGENT_NAME` in `channels/github.ts`) — the same
  definition chat sessions ingest by name; a normal `pnpm deploy:agent hoth-trip-planner`
  (or `--all`) updates both. No alias key exists anymore (the former
  `agentdef:github-default` and the pre-named-definition keys are dead). The agent
  initializer mints the `egress_secrets` entry itself (tagged `github` inside the credential
  value) since these conversations never pass the ingest route. They carry no Semantius
  identity, so they get no `semantius_org` — and therefore no `x-semantius-org` header
  and no Semantius credential at egress.
- Worker secrets: `GITHUB_WEBHOOK_SECRET` (channel creation throws at module init if
  empty — deploy fails until it exists) and `GITHUB_TOKEN` (fine-grained PAT, Issues
  read/write).
- Status 2026-07-19: the repo webhook itself was **not yet created** (the PAT lacked the
  Webhooks permission, 403); the end-to-end flow was verified with manually signed
  deliveries (issue #1 answered, incl. follow-up).

## Observability (Braintrust + Arize + Langfuse)

Three independent sinks, all best-effort on Cloudflare (the observer can't
`waitUntil`, so spans ending right before the isolate idles can be lost):
Braintrust (per-message traces, `pnpm sessions` rollup), Arize AX and
Langfuse (both first-class session views — the reason they were added:
Braintrust's session transparency is a scripted reassembly, Arize/Langfuse
group traces by `session.id` natively). Arize and Langfuse share one OTel
pipeline (src/otel.ts): a common `enrichSpan()` closes each vendor's mapping
gaps, and one fetch-based OTLP exporter instance per sink POSTs the same
spans. Verify any sink by driving a real turn:
`API_TOKEN=$(cat .api-token) node scripts/chat-probe.mjs a|b ["message"]`.

### Langfuse

Both backends export to Langfuse Cloud (US region, `LANGFUSE_BASE_URL` var)
via the OTLP endpoint `/api/public/otel/v1/traces` — Basic auth from the
`LANGFUSE_PUBLIC_KEY`/`LANGFUSE_SECRET_KEY` secrets, plus
`x-langfuse-ingestion-version: 4` for real-time v4 ingestion (without it,
direct OTel data lags up to 10 min). Mapping notes (all in `enrichSpan()`):

- **Observation types**: roots are stamped `langfuse.observation.type=agent`,
  tool spans `tool`; chat spans become `generation` automatically (any span
  with a model attribute). This drives the observation tree and Agent Graph.
- **Generation input/output**: Langfuse's documented mapping reads
  `langfuse.observation.input/output` / `gen_ai.prompt` / OpenInference
  `input.value` — NOT the adapter's `gen_ai.input.messages` — so chat spans
  mirror the messages JSON into `langfuse.observation.input/output`. Payloads
  stay in Flue's native parts format (faithful data, renders as JSON there).
- **Usage/cost**: `gen_ai.usage.*` maps natively incl. the cache split
  (`input_cached_tokens` in usageDetails); `gen_ai.usage.cost` (stamped from
  the pi-ai billed total) lands as `costDetails.total` — verified end-to-end
  2026-07-26 by reading the trace back via `GET /api/public/traces/:id`.
- The `langfuse` agent skill (Langfuse docs + CLI workflows) is installed at
  `.claude/skills/langfuse` (from github.com/langfuse/skills).

### Braintrust

Both backends export traces to the Braintrust project **`hoth-poc`** via the Flue tooling
blueprint (`flue add tooling braintrust` — it prints an agent-directed blueprint, it does not
edit files). Per backend: `braintrust@3.17.0` (pinned) + `src/braintrust.ts` (the
`observe(...)` bridge, imported first in `app.ts`).

- **Key**: `BRAINTRUST_API_KEY` is a Worker secret (`wrangler secret put`) and in gitignored
  `.dev.vars` — never a wrangler `vars` value. Without the key the bridge is a no-op:
  nothing initializes, the app runs untraced.
- **Project name**: `BRAINTRUST_PROJECT_NAME=hoth-poc` in each `wrangler.jsonc` `vars`.
- **Compat bridge (do not simplify away)**: braintrust 3.17 reads the pre-v2 flat event
  fields (`model`, `input`, `output`, `usage`, `stopReason`, and `tool_call`), while current
  Flue nightlies nest turn payloads under `request`/`response` and put an agent prompt's
  output in the `agentOutput` observation detail. `compatibleEvent()` in `src/braintrust.ts`
  flattens them back; without it llm spans arrive with duration only — no tokens, cost, or
  content. Re-check on every `braintrust` or `@flue/runtime` bump.
- **Delivery is best-effort on Cloudflare**: the observer can't `waitUntil`, so final spans
  of a run can be lost when the isolate idles immediately after. Occasional missing span
  ends are the documented tradeoff, not a bug.
- **pnpm**: the `braintrust` postinstall only downloads the optional `bt` CLI; it's blocked
  via `allowBuilds: braintrust: false` in `pnpm-workspace.yaml` (an unset placeholder there
  makes every `pnpm install` exit 1).
- **Data export**: traces carry prompts, model output/reasoning, tool args/results. Fine for
  this POC; revisit (Braintrust `setMaskingFunction`) before pointing real tenant data at it.

Verify: send a chat turn, then check the project logs — llm spans should be named
`llm:<model>` and carry `prompt_tokens` / `completion_tokens` / `estimated_cost` metrics.

- **Per-session rollup**: Braintrust traces are one-per-message (the atomic-completion
  unit); the session view is a reassembly over `metadata."flue.instance_id"`, which
  every span carries. `pnpm sessions` (scripts/session-costs.mjs) prints one row per
  session — messages, llm/tool calls, tokens, cost, wall time — over the last 24h
  (`--hours N`); `--session <id>` adds that session's per-message breakdown. In the
  Logs UI, filter by `metadata.flue.instance_id` to read one session's traces in order.

### Arize AX (OpenTelemetry)

Both backends also export to the Arize AX project **`hoth-poc`** via Flue's own
OTel adapter — `@flue/opentelemetry` (pinned to the same runtime nightly) +
`src/otel.ts` per backend (imported next to `./braintrust` in `app.ts`). The
adapter projects runtime observations onto OTel **GenAI semconv** spans
(`invoke_agent` / `chat` / `execute_tool` / `flue.operation …`), and Arize
normalizes `gen_ai.*` into OpenInference at ingestion (span kind inferred from
`gen_ai.operation.name`), so kinds, messages, token counts, and tool args
render natively — no client-side mapping.

- **Keys**: `ARIZE_SPACE_ID` + `ARIZE_API_KEY` are Worker secrets
  (`wrangler secret put`, `.dev.vars` locally). No secrets = the bridge is a
  no-op. `ARIZE_PROJECT_NAME=hoth-poc` is a `wrangler.jsonc` var.
- **Custom fetch exporter (do not "simplify" to a stock one)**: the official
  OTLP exporters transport over `node:http`/XHR, neither of which exists in
  workerd. `ArizeOtlpExporter` serializes with `ProtobufTraceSerializer` and
  POSTs to `https://otlp.arize.com/v1/traces` via fetch
  (`application/x-protobuf`). It sends BOTH auth-header spellings
  (`arize-space-id`/`arize-api-key` and `space_id`/`api_key`) because Arize's
  docs disagree with themselves and warn the wrong form drops spans silently.
- **Sessions**: the exporter stamps `session.id` from
  `gen_ai.conversation.id` (fallback `flue.instance.id`) on every span —
  that's what Arize's session view groups by.
- **Root-span output enrichment (why the exporter is more than a POST)**:
  Arize's session conversation renders each trace from the ROOT
  `invoke_agent` span's input/output — but the pinned nightly emits
  conversation-prompt `operation` results that `@flue/opentelemetry` cannot
  project (`agentOutput` absent; structured `data` results dropped), so the
  root span has no `gen_ai.output.messages` and sessions showed an empty AI
  side (root-caused 2026-07-26 by dumping exported attributes via
  `wrangler tail`). The exporter therefore remembers each trace's latest
  `chat` span output (children end before their root) and stamps it on an
  output-less root, plus plain-text OpenInference `input.value` /
  `output.value` (explicit OpenInference attributes beat Arize's derived
  GenAI mapping, which had left the agent span's output empty even when
  messages were present). Re-check on every Flue bump — if the adapter
  starts projecting agent output itself, the enrichment becomes a no-op.
- **No global OTel state**: the tracer is handed straight to the
  instrumentation (parenting is explicit inside `@flue/opentelemetry`), and
  `SimpleSpanProcessor` exports per-span — batching timers may never fire
  before the isolate idles.
- **Cost**: chat spans carry OpenInference `llm.cost.*` (prompt, completion,
  cache details, total), which Arize uses as-is — no per-model cost config
  needed. The numbers come from the runtime `turn` events' `usage.cost`
  (recorded by an observe wrapper in `src/otel.ts`, keyed by turn identity,
  stamped by the exporter): billed OpenRouter total via the pi-ai patch,
  catalog-derived components.
- **Cached-token split**: the exporter also stamps OpenInference
  `llm.token_count.*` (prompt cache-inclusive, completion, total, and
  `prompt_details.cache_read`/`cache_write`) on chat spans. The Flue adapter
  emits the split as `gen_ai.usage.cache_read.input_tokens` /
  `gen_ai.usage.cache_creation.input_tokens`, but Arize's ingestion
  normalization only maps the plain input/output totals — without the
  client-side stamp Arize showed no cached-token separation while Braintrust
  (which gets the raw pi-ai `usage` object) did (verified end-to-end via
  GraphQL span readback 2026-07-26: `prompt_details.cache_read` stored).
- **Tool results on execute_tool spans**: the adapter writes string-shaped
  tool results to flue-private `flue.tool.call.result` (only object-shaped
  ones land on `gen_ai.tool.call.result`), and Arize maps neither onto the
  tool span's output — the trace view showed arguments but empty results.
  The exporter stamps `output.value` from either attribute. Note the
  storage-level ground truth (confirmed by GraphQL readback of stored spans):
  ALL spans arrive in Arize — roots, every chat turn (full input/output
  messages incl. reasoning + tool_call parts), every tool span. Arize's
  Session-Conversation TAB only renders the root span's input/output text;
  turn-by-turn inspection lives in the per-trace tree view.
- **REVERTED — turn-activity log in the session tab**: an iteration appended
  a synthesized `[thinking]`/`[tool]` timeline to the root span's
  `output.value` and `gen_ai.output.messages` so the Session-Conversation tab
  would show turn internals. Arize renders the LAST assistant message of the
  root, so the log REPLACED the final answer (and collapsed to one unreadable
  line). Message attributes must stay exactly what the model produced —
  turn-by-turn inspection lives in the per-trace tree view. Operational note:
  Arize's span readback API (`spanRecordsPublic`) lags ingestion by ~10-30 min
  and paginates lossily at large windows — use narrow time windows when
  auditing.
- **Data export**: like Braintrust, traces carry full prompts, outputs, and
  tool args/results (Flue's default content policy). Revisit with the
  instrumentation's `content: { transform }` hook before real tenant data.

Verify: `node scripts/chat-probe.mjs`, then open the Arize space →
project `hoth-poc` → the session should appear with the full
invoke_agent → chat → execute_tool tree. Export failures surface as
`arize: OTLP export …` warnings in `wrangler tail`. A direct probe of the
endpoint from Node (same serializer + headers) returned 200 on 2026-07-26.

## Acceptance

```bash
API_TOKEN=$(cat .api-token) node scripts/acceptance.mjs        # default deployed URL
API_TOKEN=... B_URL=... node scripts/acceptance.mjs

# Reading a run: keep the output, then the exit code is the verdict and the
# file has the detail. Don't judge a run by the tail of a pipe.
API_TOKEN=$(cat .api-token) node scripts/acceptance.mjs > /tmp/acc.log 2>&1; echo $?
grep -n '^FAIL' /tmp/acc.log
```

Both suites print one `PASS`/`FAIL` line per check, a `N FAILED (M checks)` summary, and
**exit non-zero on any failure** — that exit code is the authoritative result. Keep the
output in a file and `grep '^FAIL'` it (anchored and case-sensitive: an unanchored,
case-insensitive match also hits "egress **fails** closed" in a passing check's name).

Drives the **deterministic core** (the bounded `/sessions/:id/skill-check` route) so the
checks are isolated from LLM nondeterminism. Covers: auth (401 without/with wrong key),
named-definition deploys (`PUT /agents/:name` incl. overwrite + 401), name-based ingest
(pinned to the deployed version), C2 (per-session downstream credentials, distinct across
concurrent sessions, each carrying the verified token's org as `x-semantius-org`), C3
(single source of truth — reconstructed sandbox files == bundle bytes, sha256 per file),
C4 (`opening-times.js` runs deterministically, and the injected `egress_secrets` credential
reaches the echo upstream while the container sends none), C5
(repeated creates by one user mint distinct ids — immutability per id is by construction
now that the route mints them — plus fail-closed egress after teardown), session-id shape
(server-minted, tenant-prefixed, sandbox-safe), plus clean-base, zero-skill-agent,
per-agent-egress deny-all, session_context / session record (THE `session:<id>` record
carries JWT context + egress_secrets + whitelist + containerId in one document, the
`container:<containerId>` pointer maps back to the session id, 422 on
non-object/oversize bodies, record + pointer removed on DELETE),
hostile-bundle-at-deploy (422), and name-based-ingest negatives (undeployed name 404,
legacy inline-bundle body 422). (C1 — "backend A is OOTB/static" — retired with backend A.)

The **costs** checks assert `GET /admin/costs` is admin-only and answers in shape — a UTC
day window priced in USD, and either `configured: true` with rows + totals or a stated
`reason` — plus the enrichment join (a row carrying `llmCost` must carry `agentName`, since
both come from the same session-record read) and that `llmTotal` is the rows' own sum rather
than anything folded into the container total. Deliberately not asserted: the numbers.
Cloudflare's analytics lags live traffic by minutes, so a fresh account-day can legitimately
be empty.

The **identity** checks cover both directions of the chat gate. The negatives need no
Semantius account: four invalid tokens rejected at ingest (no `<org>:` prefix, a JWT the
issuer refuses, an unknown org, junk), plus 401 on send, history read, and an unknown
conversation id. The positives (org/JWT split stored separately, user resolved from
userinfo, chat admitted) need a live token, so they run only when `.env` carries
`SEMANTIUS_API_KEY`/`SEMANTIUS_ORG` and print a skip note otherwise.

The **cookie** checks cover the gate's second credential and need a live better-auth
session cookie, which nothing here can mint — pass one as `SEMANTIUS_SESSION_COOKIE=<value>`
or the block prints a skip note. They assert that both transports (`x-better-auth-cookie`
and a real `Cookie` header) create a session and resolve to one identity, that the minted id
carries the *cookie session's* tenant, that the cookie opens the conversation it created,
that an invalid cookie is a 401 — and that **the bearer wins**: a valid cookie sent beside an
invalid bearer must still 401, or the documented precedence would be a lie.

The **credentials** checks close the loop inside the sandbox, on a semantius-admin
session (its `proxy_whitelist` covers `*.semantius.ai`): the container carries
`SEMANTIUS_JWT=__sak__` plus the token's `SEMANTIUS_ORG` and **no `SEMANTIUS_API_KEY`**,
and `semantius whoami` returns the session user's own identity — proving the sentinel was
swapped for their JWT at egress. Same credential requirement as the identity positives.

## Verified results

All 72 acceptance checks pass against the deployed Workers (the `[cookie]` block skipped —
it needs a live better-auth session cookie). (The original A/B thesis —
image-baked and dynamically-delivered skills produce byte-identical sandboxes and
identical `activate_skill → read → bash` behavior — was proven while backend A still
existed; see git history.) Two wiring findings and the egress HTTP-vs-HTTPS caveat are
recorded in [`hoth-poc-plan.md`](./hoth-poc-plan.md) §7.

## The `/sessions/:id/skill-check` route

A **bounded** test affordance (behind the API-key guard): it runs one of a fixed set of
deterministic commands (`opening-times`, `hash-skill`, `count-skill-files`, `curl-check`,
`semantius-whoami`, `semantius-env`) built server-side from strictly validated structured params — **not**
arbitrary shell. It exists to drive the acceptance oracle; it is not a product route.
