# Semantius Copilot

> **Renamed 2026-08-04:** formerly `IntranetFactory/hoth-poc` ("Hoth Trip-Planner POC"),
> now [`IntranetFactory/semantius-copilot`](https://github.com/IntranetFactory/semantius-copilot).
> Every project identifier was renamed with it: the workers (now
> `semantius-copilot-frontend` / `semantius-copilot-backend-b`, new workers.dev URLs — the
> old `hoth-poc-*` workers are deleted and their Durable-Object session history is gone),
> the Braintrust/Arize project (`semantius-copilot`; pre-rename traces remain in the old
> `hoth-poc` projects), the `@semantius-copilot/core` workspace package, and the GitHub
> webhook endpoint. KV survived the rename (bound by namespace id), so deployed agent
> definitions carried over. Only Hoth-the-planet demo content keeps the name: the
> `hoth-trip-planner` agent and its mock "Hoth Tourism API".

**Multi-agent, multi-tenant dynamic skill delivery** on Flue + Cloudflare Sandbox: a
whole agent (instructions + model overrides + ALL its skills) is serialized as **one
JSON string** — the *agent bundle* — deployed by NAME into Cloudflare KV
(`pnpm deploy:agent <name>` → `agentdef:<name>`, no TTL). Session creation submits just
`{ agentName }`; the route resolves the named definition, snapshots it per session, and
reconstructs it into the sandbox. Which agent a session runs is data, not code.

(The POC originally ran a second backend — "A", the same agent hard-baked into a
container image — to prove image-baked and dynamically-delivered skills behave
identically. That thesis was proven — see [`copilot-design.md`](./copilot-design.md) and
git history — and backend A has since been removed; "backend B" naming survives in the
worker/package names.)

See [`copilot-design.md`](./copilot-design.md) for the original design and acceptance criteria.

## Deployed

| Deployable | URL |
| ---------- | --- |
| Frontend — chat (users, Semantius token) | https://semantius-copilot-frontend.ma532.workers.dev/chat |
| Frontend — copilot (users, better-auth cookie) | https://semantius-copilot-frontend.ma532.workers.dev/copilot |
| Frontend — per-agent page, input-free (users, cookie or `#jwt=`) | https://semantius-copilot-frontend.ma532.workers.dev/agent/\<name\> — one URL per KV-deployed agent, today [/agent/hoth-trip-planner](https://semantius-copilot-frontend.ma532.workers.dev/agent/hoth-trip-planner) and [/agent/semantius-admin](https://semantius-copilot-frontend.ma532.workers.dev/agent/semantius-admin) |
| Frontend — admin console | https://semantius-copilot-frontend.ma532.workers.dev/admin |
| Backend — dynamic bundle (multi-agent) | https://semantius-copilot-backend-b.ma532.workers.dev |

**Credential-in-URL handover.** Every user page also accepts its credential in the URL
*fragment* (`#…`, never a query string — the fragment is not sent to any server), so a
link can open a page ready to chat:

```
/chat#jwt=<org>:<jwt>                          Semantius token (mint one: pnpm mint-token)
/copilot#cookie=<value>                        better-auth session cookie VALUE (<token>.<signature>)
/agent/<name>#jwt=<org>:<jwt>                  either key works here; jwt wins over cookie
/agent/<name>#cookie=<value>
…any of the above with &session=<id>           also open that session (deep link)
```

The fragment is consumed once at page load and stripped from the address bar; the
credential is persisted to this browser's localStorage, so the next visit needs no
fragment at all (it does remain in browser history for that one entry — link-borne
credentials are a POC/automation convenience, not a way to keep one secret). On
`/agent/<name>` a fragment handover also EVICTS the competing stored credential (a
`#jwt=` removes the stored cookie and vice versa): the page prefers a stored cookie
over a stored jwt, so leaving both behind made a later plain reload silently flip to
the other identity — chatting and listing sessions as somebody else with no visible
sign. The sidebar also names the identity the backend scoped its listing to ("signed
in as `<sub>@<org>`"). With no fragment and nothing stored, `/agent/<name>` falls back
to ambient mode (see "Reusable chat surface"); `/chat` and `/copilot` show their paste
box. Parsing lives in `frontend/src/pages.ts` (`consumeCredentialFragment`).

Both run on Cloudflare Workers (account `Ma@adenin.com`). The backend owns a container
app (Containers) and a private KV namespace; the frontend is three static pages plus one
dynamic page family served from Workers assets with the backend URL baked in at build time.

**Three fixed pages, one dynamic family, one Worker.** `/chat` is the user chat page
(`chat.html` → `src/chat-main.tsx` → `ChatApp.tsx`, authenticated by the user's own
Semantius token); `/copilot` is the same page authenticated by a better-auth session cookie
instead (`copilot.html` → `src/copilot-main.tsx` → `CopilotApp.tsx`); `/admin` is the
operator console (`admin.html` → `src/admin-main.tsx` → `App.tsx`, authenticated by the
deployment API key); and `/agent/<name>` is the INPUT-FREE per-agent chat (one shared shell,
`agent-shell.html` → `src/agent-main.tsx` → `AgentApp.tsx` — no credential textarea, no
agent dropdown, no session-id row; cookie or `#cookie=`/`#jwt=` fragment auth only).
Separate Vite entries so the user bundles never carry the admin code. The conversation —
draft, session creation, key-flip handoff, streaming — is `AgentChatContainer` (see
"Reusable chat surface" below); `/chat` and `/copilot` share `ChatPage.tsx` as the chrome
around it (credential textarea, agent dropdown, session-id row, status line) and differ
only in the credential they collect, so they cannot drift apart. `/agent/<name>` renders
the container directly, with no chrome at all — and with NO credential present it runs in
ambient mode (the browser's own better-auth cookie rides on `credentials: 'include'`
requests; a 401 renders as a signed-out notice).

**The agent registry is RUNTIME, not build time.** No agent name, list, welcome card, or
seed is baked into the frontend: the dropdown lists `GET /agents`, and `AgentChat` loads
each agent's welcome + turn-1 seed from `GET /agents/:name/meta` — both read the live KV
registry (`agentdef:<name>`), both behind the user-chat guard. Deploying an agent
(`pnpm deploy:agent <name>`) makes it appear on every page, `/agent/<name>` included,
with no frontend rebuild.

No fixed path is declared anywhere: Workers assets serves each `<name>.html` at `/<name>`
via its default `auto-trailing-slash` html_handling, and the one place paths are written
down in code is `CHAT_PAGE`/`AGENT_PAGE_PREFIX` in `frontend/src/pages.ts` (the app's page
map + credential bootstrap — deliberately OUTSIDE the copyable ai-elements folder).
`/agent/<name>` is the one path a Worker script serves:
agents exist at runtime, so those URLs cannot be assets — `frontend/worker/index.ts` (the
only Worker code, reached only via `run_worker_first: ["/agent", "/agent/*"]`) rewrites
well-formed names to the built shell and lets everything else fall through to assets. There
is deliberately **no `index.html`**, so `/` matches no asset; `not_found_handling` is
`404-page` (`public/404.html`), **not** `single-page-application`, so `/`, every typo, bare
`/agent`, and ill-formed `/agent/<junk>` answer a real 404 instead of silently rendering a
page that looks like it worked. (A well-formed `/agent/<name>` whose agent is not deployed
renders an in-page "agent unavailable" state — whether a name is real is the registry's
call, not the asset layout's.) That 404 page names **no path**, not even in an HTML
comment — it is what an unauthenticated prober sees, and `/admin`'s existence is not
something to advertise.

## Reusable chat surface (`frontend/src/components/ai-elements/`)

The chat surface is designed to be **copied into other apps**. The folder has zero
workspace imports (the one protocol constant, `x-better-auth-cookie`, is inlined in
`session.ts`, mirroring `core/src/identity.js`); everything app-specific — page paths,
localStorage keys, `#jwt=`/`#cookie=` fragment handover — lives in `frontend/src/pages.ts`
and `App.tsx`, which are NOT part of the copy.

**Entry point: `AgentChatContainer`** (`agent-chat-container.tsx`). Props:

| Prop | Meaning |
|---|---|
| `agentName` (required) | which deployed agent to talk to |
| `bearer?` | Semantius token `<org>:<jwt>` → `Authorization: Bearer` |
| `authCookie?` | better-auth session cookie VALUE → `x-better-auth-cookie` header |
| `baseUrl?` | backend origin (default: build-time `VITE_AGENTBACKEND_URL`) |
| `sessionId?` | attach to an existing session instead of starting a draft |
| `onSessionCreated?` | `(id, info)` — the server-minted id, for status lines/deep links |
| `onError?` | session-create failure (also rendered inline by the container) |
| `className?`, `placeholder?` | frame styling override / composer placeholder |

`agentName`/`sessionId` are fixed per instance — hosts navigate by changing the
container's `key` (see the key contract in the component header). Never feed
`onSessionCreated`'s id back into the key: that remounts mid-handoff and races the first
message.

**Three auth modes** (server-side precedence: bearer, then the custom header, then the
browser's cookie jar): `bearer`; `authCookie`; and **ambient** — BOTH empty. In ambient
mode every request (including the SSE stream) goes out with `credentials: 'include'` and
the browser attaches its own better-auth cookie; a 401 renders as the container's
signed-out notice. Ambient requires: (1) the page's origin listed in the backend's
`ALLOWED_ORIGINS` var (credentialed CORS + CSRF origin check, `backend-b/wrangler.jsonc`);
(2) the backend **same-site** with the page — `workers.dev` is on the Public Suffix List,
so two workers.dev hosts are cross-site and the cookie never rides; ambient needs
backend-b on a custom domain under the embedding app's zone, and the better-auth cookie
issued with `Domain=.<zone>` (better-auth `crossSubDomainCookies`). The custom-header
mode works cross-site today and is what `/copilot` uses.

**The copy set** (what another app must take):

- `src/components/ai-elements/` (the surface), `src/components/ui/` (all shadcn
  primitives — the transitive closure is the whole folder), `src/lib/utils.ts` (`cn`),
  and the `@` alias (vite + tsconfig `paths`).
- The theme layer: `src/index.css` — Tailwind v4 entry with the shadcn CSS variables,
  `@custom-variant dark`, `@import "shadcn/tailwind.css"`, `@import "tw-animate-css"`,
  the Geist font, and the `@source "../node_modules/streamdown/dist"` directive (without
  it Streamdown's markdown classes get purged).
- Runtime deps: `@flue/sdk`, `@flue/react` (React 18 peer), `ai`, `streamdown` +
  `@streamdown/{cjk,code,math,mermaid}`, `shiki`, `motion`, `use-stick-to-bottom`,
  `lucide-react`, `radix-ui`, `@radix-ui/react-use-controllable-state`, `cmdk`, `nanoid`,
  `clsx`, `tailwind-merge`, `class-variance-authority`, `shadcn`, `tw-animate-css`,
  `@fontsource-variable/geist`. Build deps: `tailwindcss` + `@tailwindcss/vite` (or an
  equivalent Tailwind-4 setup scanning the copied folder).
- The `@durable-streams/client` patch from `patches/` + its `patchedDependencies` entry
  in the target's pnpm workspace config (the held SSE stream needs it).

The backend contract the surface speaks (any backend-b-shaped Worker, addressed via
`baseUrl`): `GET /agents`, `GET /agents/:name/meta`, `GET /sessions` (the caller's own
sessions, whitelisted meta), `POST /sessions/agent`, `/agents/main/:sessionId` (flue v2
+ SSE).

Failed / stopped runs, failed sends, and connection errors are surfaced by the transcript
itself, with a Retry — see "Failed runs, stopped runs, retry" below.

**Tool calls** (`tool.tsx`). A run of consecutive tool calls collapses to one line ("Ran 10
tool calls ✓", or "Running bash  Checking the workspace…" while one is in flight); expanding
shows a slim row per call, and each row opens into the call's Parameters and Result panels.
The transcript's most recent group keeps naming its last call once it settles — "Ran bash
Downloading the blueprint  and 3 more" (the live line, tense flipped) — so the line still says
where the agent got to; older groups show the bare count (`latest` prop, decided in
`agent-chat.tsx` across the whole visible transcript, so a user send that appends a bubble
doesn't flip the line above it back). A group with a failed call keeps "N tool calls · k
failed" + red icon and auto-opens, latest or not.
The text on a row/line is `summarizeInput`: `#id → status` for task ops, else the call's
`subject` (TaskCreate), else its `description`, else its first string argument (a path, a
pattern). `description` is what makes a `bash` row read as plain language rather than a
600-character shell one-liner: Claude sends one with every `bash` call on its own — the field
Claude Code's Bash tool taught it; Flue's `bash` schema declares only `command`/`timeout` but
tolerates the extra key — and the row prefers it, keeping the command itself one click away
in the Parameters panel (a call without a description falls back to the command).

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
             `@semantius-copilot/core/node` adds the bundler library (fs walk, JSONC parse via
             jsonc-parser).
backend-b/   Flue+CF Worker — the MULTI-AGENT backend: one generic `main` Flue agent;
             the named agent definition a session references (`{ agentName }` at ingest,
             resolved from KV `agentdef:<name>`) decides instructions, model, skills.
             First-turn identity rides the creating send's `initialData` (see design §6).
frontend/    React + Vite — `/chat` and `/copilot` (the shared ChatPage:
             New-session button, agent dropdown from GET /agents; token vs.
             session-cookie auth), `/agent/<name>` (the input-free per-agent
             page; worker/index.ts rewrites those paths to the shared shell;
             a session sidebar — New request + the user's sessions for that
             agent via GET /sessions) and `/admin` (Data browser + Costs
             tab). `/` is a real 404.
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
             `pnpm logs` streams the deployed backend's Workers Logs
             (wrangler tail; observability.enabled in backend-b/wrangler.jsonc —
             this is where lazy-env's "container boot triggered by …" line lands).
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
  "openRouterRouting": { "sort": "throughput" },  // optional, from openrouter_routing — forwarded verbatim as OpenRouter's `provider` object
  "proxyWhitelist": ["postman-echo.com"],  // optional — hosts/URLs, `*` anywhere; unioned with the org's list at egress
  "welcome": { "title": "…", "subtitle": "…", "sections": [] },  // optional — see "Welcome card"
  "skills": { "planner": { "SKILL.md": "…", "references/…": "…" } }  // 0..16 skills
}
```

Artifact per run: `dist-bundle/<name>.agent.json` (canonical, used by acceptance and
chat-probe). The frontend consumes NO bundler output — the UI reads the agent registry at
runtime (`GET /agents` for the dropdown, `GET /agents/:name/meta` for welcome + seed), so a
NEW agent shows up on every page after `pnpm deploy:agent <name>`, with no frontend
rebuild. Limits: ≤16 skills, ≤64 files & ≤1 MiB per skill, ≤4 MiB per agent,
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

- **Files "on disk"** — served by the lazy SessionEnv wrapper
  (`backend-b/src/lazy-env.ts`): until the container has booted, every read
  under `/workspace/.agents/skills/` (Flue's workspace discovery, the model's
  SKILL.md `read`s) is answered **from the KV bundle** — byte-identical to what
  `provisionAgentSkills` extracts, at zero container cost. The first operation
  that genuinely needs a live machine (`bash`/`grep`/`glob` exec, a write, a
  read outside the skills tree) boots the container, extracts the bundle onto
  the real disk and applies the Semantius env, then forwards; from then on the
  same paths are served from disk. This makes skill resources actually runnable
  (bun/node scripts, reference files) while chat-only turns never start a
  container.
- **Explicit catalog** — the bundle's SKILL.md frontmatter is parsed into
  `{name, description}` entries (`skillCatalogFromBundle`, `core/src/skill-catalog.js`)
  that ride the creation seed (served to the UI by `GET /agents/:name/meta`,
  attached to sends by `AgentChat` via `withAgentSeed`) and the stored agent meta;
  `backend-b/src/agents/main.ts` mounts each entry with `useSkill()`, whose
  instructions point at the on-disk SKILL.md. This is what guarantees the model SEES
  the skills in its system-prompt "Available Skills" section.

Why the second leg exists: Flue discovers workspace skills once at session init and
caches the catalog for the conversation. Fully provisioned sessions still
composed system prompts with an EMPTY catalog (verified 2026-07-23 on the
2.x nightly: the Braintrust-logged system prompt had no skills section while the
deterministic skill-check proved the same container held all 70 files, and the SDK
`exists()` probe — surfaced as `sdkExists` in the skill-check response — returned
true when tested moments later; the bundle view now removes the container from
that discovery path entirely). Catalog
descriptions are truncated to 1024 chars (Flue's SkillDefinition cap). When
workspace discovery finds the skills (it reads the same bundle view), the
discovered skill wins the name-merge over the mounted definition — same
content either way. That
discovered-wins merge is restored by our `@flue/runtime` patch (see
Prerequisites): the stock runtime (unchanged through 2.0.3) THROWS on the name
conflict instead, and
when discovery sees the files — which with the bundle view it reliably does —
every submission of such a session then
failed with a generic `internal_error` (root-caused via `wrangler tail`
2026-07-26; backend B was undriveable until the patch).

**Keep SKILL.md descriptions under 1024 chars.** The mounted definition carries
the sliced text, and Flue's `resources` narration signal (below) prints THAT
copy — a longer description shows up chopped mid-word wherever the mount is
what the model reads. Check with
`parseSkillFrontmatter(...).description.length` per skill; as of 2026-08-08
`semantius-admin`, `-analyst`, `-architect`, `-modeler` and `-optimizer` still
exceed it (1049–1499).

**Framework narration is not chat.** When a render's declared skill/tool/agent
set differs from the last-narrated one — e.g. deploying a definition with a new
skill mid-session — Flue appends a `resources` signal ("New skill available: …
All available skills: …", `renderResourceSignalBody` in the runtime). It is
written for the MODEL (delivered as a `<signal>` block in a user turn) and is
classified `role:'system'`, `purpose:'advisory'`, `display:'diagnostic'`. The
chat surface therefore renders only `display: 'visible'` messages
(`agent-chat.tsx`); the admin data browser's `ConversationView` deliberately
shows all of them — that IS the diagnostics panel.

Observability: the backend logs every llm span to Braintrust (exact system
prompt in span metadata `flue.system_prompt`, messages as the span input) and
exports OTel GenAI traces to Arize AX. Check there first when the model behaves
as if instructions or skills are missing.

## Prerequisites

- Node **>= 22.18** (Flue requirement; `nvm use 22.22.0`).
- Flue **2.0.3** (released 2026-08-04; upgraded 2026-08-11 from 2.0.1, which
  came from the 2.0 nightly `202607230552` on 2026-08-03). The 2.0.3 bump is
  not drop-in: it renames the sandbox seam (`SessionEnv` → `Sandbox`,
  `SandboxApi` → `SandboxDriver`, `createSandboxSessionEnv()` →
  `sandboxFromDriver()`). The types keep deprecated aliases, and the
  `SandboxFactory.createSessionEnv` method we PASS still works (with a
  `console.warn`), but the method `cloudflareSandbox()` RETURNS was renamed
  outright — `createSessionEnv` is gone from it, so `agents/main.ts` had to
  move to `createSandbox` or every container-needing op would have thrown
  `is not a function`. 2.0.3 also makes the Cloudflare `agents` SDK a
  dependency of `@flue/vite` (`^0.20.1`, up from the ^0.14 we resolved
  before — backend B's own pin was raised to match so only one copy is
  installed) and force-closes orphaned Cloudflare trace spans.
- pnpm, Docker (for building the sandbox container image), a Cloudflare account with
  **Workers Paid + Containers** and **Workers AI** enabled.
- Four dependency patches under `patches/` (applied automatically by `pnpm install`):
  - `@earendil-works/pi-ai` (0.83.0 — backend B depends on `^0.83.0`
    explicitly so it shares the SAME pi-ai copy and catalog as
    `@flue/runtime`; the 0.81.1 copy it used before shipped a stale catalog
    whose `deepseek/deepseek-v4-flash` entry capped output at 4096 tokens,
    see fix_model_limits_plan.md). Four hunks:
    - OpenRouter **billed** cost: adds the OpenRouter-only
      `usage: { include: true }` request field (usage accounting) and
      prefers the returned inline `usage.cost` over the model-catalog
      estimate for `cost.total` in `parseChunkUsage`
      (`dist/api/openai-completions.js`). Stock pi-ai never requests
      accounting and discards the field, so every downstream cost —
      conversation metadata, Braintrust, `pnpm sessions`, Arize `llm.cost.*` —
      was a catalog estimate. No-op for non-OpenRouter providers and when
      OpenRouter omits the field.
    - Context overflow is **loud** (`dist/api/simple-options.js`): stock
      `clampMaxTokensToContext` silently floors the output budget at
      `max_tokens: 1` once the conversation exceeds the model's context
      window — a uselessly truncated request whose output the loop then
      acts on. The patch throws a "Context overflow" error instead, which
      surfaces as an error stop reason in the session.
    - Truncated tool-call detection (`dist/api/openai-completions.js`
      `finishBlock`): providers do not reliably report `finish_reason:
      "length"` when they cut output (the 2026-08-12 incident), and the
      streaming salvage parser silently turned a truncated argument buffer
      into an executable (incomplete) call. The patch complete-parses first
      (`parseJsonWithRepair`, so complete-but-quirky JSON stays unflagged)
      and sets `argumentsTruncated` on the block when only the partial-JSON
      salvage could parse it — consumed by the pi-agent-core patch below.
    Keyed to the exact pi-ai version — on a bump, re-create (same four
    edits, dropping any that upstream fixed).
  - `@earendil-works/pi-agent-core` (0.83.0) — the agent loop's truncation
    guard (`dist/agent-loop.js`) stock keys ONLY on `stopReason ===
    "length"`, i.e. on the provider's honesty; the patch extends it to also
    fail the tool batch when any call carries `argumentsTruncated` (set by
    the pi-ai patch above), routing into the existing
    `failToolCallsFromTruncatedMessage` — the model gets a "re-issue with
    complete arguments" tool error instead of a silently corrupt artifact.
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
    **On every Flue bump:** the patch is keyed to the exact runtime
    version — re-create it (`pnpm patch @flue/runtime@<new-version>`, remove
    the conflict `throw` in `mergeSkillCatalog`, `pnpm patch-commit`) unless
    upstream made the merge tolerant, or B stops double-delivering skills.
    (Done for 2.0.3: stock 2.0.3 still throws — same one-line removal, now
    in `dist/conversation-stream-store-CXwRWonS.mjs`. The chunk hash moves
    every release, so the patch is a rename + one path edit, not a rewrite.)
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
                       # html_handling, so they exist only on a deployed build. /agent/<name>
                       # DOES work in dev: a tiny middleware in vite.config.ts mirrors the
                       # deployed Worker rewrite and serves agent-shell.html there.
```

## Deploy

```bash
pnpm deploy            # deploy worker + all named agent defs + frontend, in order
pnpm deploy:agents     # deploy:agent --all — ships agents/ content changes as named KV
                       # definitions, and NOTHING else: deploy-agent.mjs builds each
                       # bundle fresh from agents/<name>/ in memory (no pnpm bundle
                       # needed — dist-bundle/ is only for acceptance/chat-probe), the
                       # server validates at PUT, and the UI reads the registry at
                       # runtime (dropdown, welcome, turn-1 seed) — no frontend or
                       # worker redeploy. NEW sessions only; the GitHub channel reads
                       # agentdef:hoth-trip-planner, so --all covers it.
# or individually:
pnpm deploy:b          # vite build + wrangler deploy the backend worker
pnpm deploy:agent <n>  # bundle agents/<n>/ and PUT it to KV as agentdef:<n> (see above)
pnpm deploy:frontend   # vite build (URL from frontend/.env.production) + wrangler deploy
```

First deploy of the backend creates its Cloudflare Container application and prompts to
confirm. It needs **Workers AI** and **Containers** enabled on the account. The frontend
build reads the backend URL from [`frontend/.env.production`](./frontend/.env.production).

The frontend deploy publishes the three fixed pages (`/chat`, `/copilot`, `/admin`), the
`/agent/<name>` shell + its rewrite Worker, and `404.html` for `/` and everything else.

## Authentication

The backend has **two auth surfaces** (`core/src/auth.js`), and they take different
credentials:

- **admin / CLI** — `/admin/*`, agent deploys, skill-checks, session deletes. One shared
  deployment secret, `Authorization: Bearer <API_TOKEN>` (`apiKeyGuard`), failing closed
  (503) when `API_TOKEN` is unset.
- **user chat** — creating a session, talking in it, reading the agent registry
  (`GET /agents` — the deployed names; `GET /agents/:name/meta` — one agent's welcome card
  + turn-1 seed, skill files excluded), and listing their own sessions (`GET /sessions` —
  tenant-prefix KV listing plus a per-record ownership re-check; the answer is whitelisted
  meta only: id, agentName, version, createdAt — never the record, which also carries
  `session_context.semantius_jwt` (and `egress_secrets`, once the secret-retrieval
  layer populates it) — plus `user`, the verified
  identity the listing was scoped to, same shape as the session-create response). The
  caller's own credential
  (`userTokenGuard`): a Semantius token, or a better-auth session cookie. No API key is
  accepted here, so a chat client can never browse data or deploy.

Set the admin key as a Cloudflare secret, and locally via `.dev.vars`:

```bash
node -e "console.log('semantius_'+require('crypto').randomBytes(24).toString('base64url'))" > .api-token
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

A **third** call on the same host is not part of authentication and runs only when a
session is created (`POST /sessions/agent`, not on the auth path):

```
POST /session/copilot                  ← the ORG's copilot settings, once per session
x-jwt-exchange-api-key: <JWT_EXCHANGE_API_KEY>
{"sessionCookie":"<value>"}
→ 200 {"copilotEnabled":true,"copilotFirewallEnabled":true,"copilotFirewallAllowlist":["example.com"]}
```

`copilotEnabled: false` makes session creation answer **403**; the firewall fields become
the session's `org_whitelist`, unioned with the agent's list at egress. Full semantics in
[Egress](#egress-agent-proxy_whitelist--org-allow-list) below.

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
  answers **503** rather than a misleading 401; bearers keep working. The value is the
  SAME shared secret the api.semantius.cloud side validates — its source of truth is
  `JWT_EXCHANGE_API_KEY` in `semantius-auth/packages/server/.dev.vars` (and that
  worker's deployed secret). Keep `.dev.vars` here filled with it: deployed secrets
  cannot be read back, and a worker rename re-seeds secrets from `.dev.vars`, so an
  empty local value becomes an empty deployed secret (exactly the 503 above).

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
- **New session is a zero-cost draft**: the button makes no request. The
  `POST /sessions/agent` fires when the user sends their first message (the draft submit
  creates the session, then delivers that message to it), so a session that is opened but
  never typed into creates no KV records and no container. Session ids therefore appear
  in the status line only after the first send.

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
- **Per-agent override** (`agent.jsonc`): optional `model`, `model_base_url`,
  `max_tokens`/`context_window`, and `openrouter_routing` (next subsection). The
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

**Catalog misses are detected, not silent.** A placeholder-path model caps output at 8k
tokens, and that cap truncates long single-pass writes mid-response (`stop_reason:
"length"`) — the turn still settles as *completed*, so the UI shows the agent announcing
work and then going silent (root-caused 2026-08-12: `deepseek/deepseek-v4-flash-0731`, a
dated slug the catalog doesn't know — only the undated `deepseek/deepseek-v4-flash` is an
exact catalog id). Three seams surface the condition (`modelCatalogWarning`,
`backend-b/src/llm.ts` — the deploy check and the runtime resolution share the one
predicate, so they cannot drift):

- **deploy time** — `PUT /agents/:name` answers a `modelWarning` when the bundle's model
  would resolve through the placeholder path, checked against the *deployed worker's own*
  pi-ai catalog (a local check could drift from the worker's bundled copy);
  `pnpm deploy:agent` prints it as `⚠ MODEL WARNING`. Non-fatal: a model newer than the
  pinned catalog is legitimately deployable, just degraded.
- **runtime** — `agentModelSpecifier` logs one `[llm]` warning per specifier per isolate
  when it synthesizes the placeholder, and a truncation watchdog (`src/braintrust.ts`,
  registered even without a Braintrust key) logs every `finishReason: "length"` turn with
  its session id. Both land in Workers Logs (`pnpm logs`).
- **after the fact** — `pnpm sessions` has a `len-stops` column (per session, and per
  message with `--session <id>`) counting truncated responses from the Braintrust spans
  (`flue.stop_reason`).

### OpenRouter provider routing (per-agent `openrouter_routing`)

`agent.jsonc` may carry an `openrouter_routing` object — OpenRouter's
[provider-routing preferences](https://openrouter.ai/docs/features/provider-routing) —
which the bundler ships as `openRouterRouting` and the backend forwards **verbatim** as the
request-body `provider` object on every model turn *and* the session-title side call.
There is no key whitelist: `validateAgentConfig` only checks "plain object, ≤4 KiB
serialized" (`AGENT_LIMITS.maxRoutingBytes`) — OpenRouter validates its own fields, so a
new OpenRouter routing field needs no code change here, and an unknown/ill-typed one fails
the turn with OpenRouter's error. The schema (`core/agent.schema.json`) lists the known
fields for editor completion: `sort` (`"price"` = the `:floor` shortcut, `"throughput"` =
`:nitro`, `"latency"`, or `{ by, partition }`), `order`, `only`, `ignore`,
`allow_fallbacks`, `require_parameters`, `data_collection`, `zdr`,
`enforce_distillable_text`, `quantizations`, `max_price` (USD **per million tokens, per
direction** — `prompt` = input and `completion` = output are independent ceilings, plus
per-unit `request`/`image`/`audio`), `preferred_min_throughput`, `preferred_max_latency`.
Setting `sort` or `order` disables OpenRouter's default price-based load balancing.

Mechanics (`backend-b/src/llm.ts`): the routing rides on the per-agent `agent-<name>`
provider entry as pi-ai's `compat.openRouterRouting`, which its openai-completions API
sends as `params.provider` unchanged — so it works for catalog-known models (full catalog
metadata kept, only the routing added), dated slugs and catalog misses alike, for the
`openrouter` and `custom` providers (an OpenRouter-compatible proxy is the agent author's
call), and is silently ignored for `cloudflare` (AI binding, no HTTP body). The title call
(`src/title.ts`) sends the same object, so an agent pinned to e.g. `zdr`/`data_collection:
"deny"` hosts never leaks its transcript to another host for a title. Prefer this over the
`:nitro`/`:floor` model-id suffixes: those are not Pi catalog ids, so they would resolve
through the placeholder path (see above) and lose the model's metadata.
`scripts/openrouter-routing.test.mjs` (in `pnpm test`) covers validation, bundler
plumbing, and drives the installed pi-ai dist against a canned fetch to assert the request
body's `provider` is the routing object byte-for-byte. `semantius-admin` runs with
`{ "sort": "throughput", "max_price": { "prompt": 0.14, "completion": 0.28 },
"quantizations": ["fp8", "bf16", "fp16", "fp32"] }` — fastest FP8-or-better host at or
under the model's catalog list rate (filters apply *before* the throughput ranking; without
the cap the sort landed on a 2×-priced host). Per-host prices, quantization and output caps
for a model: `GET https://openrouter.ai/api/v1/models/<slug>/endpoints` (public).

Verified against the deployed worker (2026-08-18, hand-crafted turn-1 seeds via
`chat-probe`): a `quantizations` allow-list excludes hosts with *undisclosed* quant
(OpenRouter: "No endpoints found for the request with quantization: …"); minimum
context/output is NOT a routing field but OpenRouter routes only to hosts whose output cap
covers the request's `max_tokens` (a price sort over `{baidu (131k out), novita}` served
from Novita) — pi-ai requests the catalog entry's `maxTokens`, so sub-300k hosts are
skipped per request; a single-host `only` pinned to an incapable host is still tried and
fails mid-stream.

## Welcome card (per-agent `welcome`)

The chat UI shows a per-agent welcome card while a conversation is empty, configured by
the optional `welcome` key in `agent.jsonc` (validated in `core/src/agent.js`
`validateWelcome`, mirrored in `core/agent.schema.json`): a `title`, optional
`subtitle`, and `sections[]` (each with `title`, optional `subtitle`, and `prompts[]`).
Each prompt has a `display` label, an optional fuller `prompt`, an optional `prefill`
flag, and an optional `hint`. Semantics, implemented in ONE place —
`frontend/src/components/ai-elements/welcome.tsx` (`WelcomeCard`), rendered by the
shared `AgentChat` so `/chat`, `/copilot` and `/agent/<name>` cannot drift:

- Clicking a prompt uses `prompt ?? display` as the text.
- `prefill` absent/`false`: the text is **sent immediately** as the user's message.
- `prefill: true`: the text only **fills the composer** for editing before sending.
- `hint` set: clicking also shows that text in a **dismissible amber tip above the
  composer** (`HintTip`, `hint.tsx`). The tip outlives the welcome card — it stays
  through the conversation until the user closes it with the ✕.

**Where a closed tip is remembered.** The ✕ persists a dismissal under the id
`` `<agentName>:<display>` `` — the prompt's required, user-visible `display` is its
natural key, so there is no extra config field and no hash to maintain (re-wording a
`display` therefore gives its tip one more airing, and two prompts sharing a `display`
share one dismissal). Storage is deliberately **injected**, not chosen by the chat
surface: `ai-elements/hint.tsx` exports only the two-method `HintStore` interface, and
this app passes `localHintStore` (`frontend/src/hint-dismissal.ts`, a JSON string array
under `semantius-copilot-dismissed-hints`) into `AgentChatContainer` from `AgentApp` and
`ChatPage`. That keeps the folder's app-agnostic contract (no localStorage keys travel
with it — see `session.ts`/`pages.ts`) and makes **moving dismissals to a server-side API
a rewrite of `hint-dismissal.ts` alone** — no component or prop changes. Without a
`hintStore` the tips still work, closing only for the life of the mount.

The tip's state lives in `AgentChatContainer`, not `AgentChat`: a draft's non-`prefill`
welcome click both raises the tip and sends, and that send flips the `'draft'` → session
id key that **remounts** `AgentChat` — state held there would die on the click that set it.

Layout: sections in a 2-column grid (1 column on narrow screens) with **no cap on the
number of sections or prompts** — the UI never truncates; only string lengths are
validated (title/display ≤200 chars, subtitle ≤500, hint ≤500, prompt ≤4096,
`WELCOME_LIMITS`).
The field is UI-only: it rides the bundle (and its version hash) and reaches the UI via
`GET /agents/:name/meta`, but never reaches the model — `AgentChat` strips it before
attaching the seed to a send (`seedFromMeta`), so it is deliberately NOT part of the
`AgentSeed`. An agent without `welcome` gets the generic empty state.

## Egress (agent `proxy_whitelist` ∪ org allow list)

Egress from an agent's sandbox is governed by **two allow lists, unioned**:

| source | where it comes from | record field | lifetime |
| --- | --- | --- | --- |
| the **agent's** `proxy_whitelist` | `agent.jsonc` → bundle `proxyWhitelist` | `whitelist` | rewritten from the bundle every message (self-heal) |
| the **org's** copilot allow list | `POST /session/copilot` at session creation | `org_whitelist` | written once, never touched again |

**Deny-all when both are absent**: an agent without the property (or with an empty list)
whose org contributes nothing can make no outbound request at all. There is no global
whitelist anymore.

The agent's list rides the bundle as `proxyWhitelist`; the ingest route writes it into
**THE session record** — `session:<sessionId>`, the single mutable per-session document
(browse meta, `egress_secrets`, `whitelist`, `org_whitelist`, `copilot`, and the four data
channels) — plus the `container:<containerId> → sessionId` pointer, the only
containerId-keyed KV entry (outbound handlers receive only `ctx.containerId`, and
`idFromName` is one-way; every other code path *computes* the container id — the record's
`containerId` field is stored for visibility, not read by code). Both outbound handlers in
`backend-b/src/cloudflare.ts` resolve pointer → session record per invocation; the agent
initializer self-heals the egress fields each message (write-on-change only — a deleted
session stays deny-all). The sentinel→credential swap (`brokerEgress`) and the
zero-knowledge `egress_secrets` injection both sit behind the whitelist gate; a request to
a non-allowed host is rejected with 403 even when it carries the credential sentinel.

**Why two fields and not one merged list.** The self-heal rewrites the agent half from the
bundle on every message, and it has no session cookie to re-read the org half with. A
pre-merged field would therefore lose the org's entries on turn two. The union happens at
*read* time instead, in [`resolveEgressPolicy`](core/src/egress.js) — one merge point,
no write-site coordination, nothing to flap.

### Entry format

One grammar for both lists, so an author never has to know which list an entry came from
([`matchesEgressPattern`](core/src/egress.js)). An entry is a **hostname or a URL**, and
`*` may appear **any number of times, anywhere**:

| entry | matched against | matches | does not match |
| --- | --- | --- | --- |
| `abc.com` | hostname (port and path ignored) | `https://abc.com/any/path` | `https://evil.com` |
| `*.semantius.ai` | hostname | `tests.semantius.ai` | the apex `semantius.ai`, `evil-semantius.ai`, `tests.semantius.ai.evil.com` |
| `api.*.acme.io` | hostname | `api.eu.acme.io` | `api.acme.io.evil.com` |
| `https://xxx/abc.com/*` | request URL | `https://xxx/abc.com/deep` | `http://xxx/abc.com/deep` (scheme is pinned) |
| `x.com/abc/*` | request URL, either scheme | `https://x.com/abc/1`, `http://x.com/abc/1` | `https://x.com/other` |
| `*` | everything | anything | — |

Hostname entries ignore the port; URL entries have their default port normalized away and
their **paths compared case-sensitively** (an allow list must not over-match). A URL entry
matches with or without the request's query string, so `https://api.acme.io/v1/*` covers
`…/v1/x?q=1`, while `https://api.acme.io/s?q=*` can pin one.

The org's list is sanitized on arrival (`sanitizeAllowlist`): non-strings, blanks,
whitespace-bearing entries, values over 255 chars, and anything past 64 entries are
**dropped, not fatal** — a malformed row upstream can only ever narrow egress, never widen
it and never fail a session. The agent's list is validated at bundle time instead
(`core/src/agent.js`, max 32 entries) so a bad glob is a deploy error.

### The org's copilot settings

`POST /session/copilot` is the same server-to-server shape as the token exchange —
`x-jwt-exchange-api-key` plus the cookie in the body — and answers the copilot columns of
the session's **active organization**:

```bash
curl -X POST https://<slug>.semantius.cloud/session/copilot \
  -H "x-jwt-exchange-api-key: $JWT_EXCHANGE_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"sessionCookie": "<token>.<signature>"}'
# {"copilotEnabled":true,"copilotFirewallEnabled":true,"copilotFirewallAllowlist":["example.com","api.acme.io"]}
```

- **`copilotEnabled: false` → `POST /sessions/agent` answers 403** and no session is
  created. This is the org-level switch, checked at creation only: existing conversations
  run out their 24 h TTL.
- **`copilotFirewallEnabled: false`** means the org runs unfirewalled, which is stored as
  the single entry `["*"]`. Note the ceiling: `enableInternet = false` on the Sandbox class
  still stands, so `*` means *all HTTP/HTTPS through the interceptor*, not raw sockets or
  other ports.
- **`copilotFirewallEnabled: true`** stores the sanitized `copilotFirewallAllowlist`.

Both booleans **default to the restrictive reading** — a body that omits or mistypes
`copilotEnabled` is not enabled, one that omits `copilotFirewallEnabled` is firewalled. A
malformed answer must never be the thing that opens egress up.

Read **once, at session creation**, and persisted (`fetchCopilotSettings`, called from the
ingest route). Not per request and not cached: unlike the exchanged JWT this is not a
credential that expires, and a second upstream round-trip on every chat message would buy
nothing but latency.

**Only the cookie path can ask.** `/session/copilot` authenticates the user by their
session cookie, and a bearer caller (`Authorization: Bearer <org>:<jwt>` — `pnpm
mint-token`, the acceptance suite) has none to send. Bearer-created sessions therefore get
`org_whitelist: []` and no org gate: the agent's `proxy_whitelist` stands alone, exactly as
before this endpoint existed. The `if (cookie)` branch in the ingest route is the single
seam if the endpoint ever accepts a JWT.

### Reachability is not credential scope

`brokerEgress` takes a **`secretHosts`** scope (`SEMANTIUS_HOSTS`) that bounds the
sentinel→JWT swap independently of the allow list, and that separation is load-bearing now
that an allow list can legitimately be `["*"]`. An org may widen *where the sandbox can
talk*; it must never widen *where the user's live Semantius JWT can travel*. A
sentinel-bearing request to a host that is merely reachable is **403** — never forwarded
with the placeholder, never with the real key. The same host without a sentinel is fine.

### `egress_secrets` — per-session downstream credentials

A session's downstream credentials live on the record as a **map of host glob →
credential**, matched with the same globber as the whitelist:

```json
"egress_secrets": { "postman-echo.com": "<resolved downstream credential>" }
```

The container is given **nothing** for these hosts — not the value, not a placeholder, not
the knowledge that auth happens. The skill fetches the host with no `Authorization` header;
[`injectAndForward`](core/src/egress.js#L246) looks the host up in the map and *adds* the
header on the way out. Zero-knowledge injection: the sandbox cannot leak, misdirect, or
even name a credential it has never seen.

**Nothing writes this map today — secret retrieval is TODO.** The server must never
generate or hardcode a credential value (the POC's original per-session
`hoth-tourism-key-…` stand-ins, minted in Worker code, were removed for exactly that
reason). The map is reserved for a **secret-retrieval layer**: at session creation the
ingest route resolves the tenant's secret *references* (vault / secrets store) into
per-session entries — see the `TODO(secret-retrieval)` comment in
`backend-b/src/app.ts`'s ingest route, the one place it plugs in. Until that layer
exists, every credential-required host **fails closed (403)** for every session,
including the trip-planner's Hoth Tourism API demo host (`postman-echo.com`).

Rules, all covered by `pnpm test`:

- **Registering a host as credential-required is what makes absence fatal.** A host handled
  by this path with no matching map entry gets **403** — never an unauthenticated forward.
  That's the fail-closed rule behind design §13 C5: the self-heal never creates credentials,
  so an expired session whose policy self-heals recovers its whitelist but not
  its ability to call the downstream API.
- **The self-heal preserves the map verbatim** — a retrieval-populated entry is never
  rotated or dropped under a live conversation.
- **Per session, keyed by the container→session pointer**, so tenant A's key can never
  surface in tenant B's container.

Adding another downstream credential is a map entry, not a code change at egress.

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
   `SEMANTIUS_ORG=<the token's org>` and `SEMANTIUS_JWT=<sentinel>`. Applied by the lazy
   SessionEnv wrapper right after skill extraction whenever a container boots
   (`backend-b/src/lazy-env.ts` → `provisionWorkspace` in `agents/main.ts`), and by the
   admin skill-check route's replay — a cold container comes back with only the image's
   environment, so provisioning always travels with the boot. A session with no verified
   user gets no Semantius environment at all, so its CLI is unconfigured rather than
   pointed at someone else's tenant.
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
`tests-user3-1ea1a17e8e68456ab587986db90a4fc9`, or for a UUID-shaped sub
`tests-019d78248034755eb95e88f46bb2c8dc-1ea1a17e8e68456ab587986db90a4fc9` — minted by
the ingest route from the identity the user guard just verified (`mintSessionId`,
`core/src/config.js`). The identity segments ride **verbatim** (lowercased, separators
stripped) — a user id is never truncated or hashed into the id. The route takes **no id
from the caller**: the browser used to generate one with `crypto.randomUUID()`, which
made "server-minted, globally unique, never reused" (design §6) a promise nobody enforced
and would have let a client stamp any tenant it liked on its own KV keys.

Why the tenant rides the id: it is the only place that puts it in every key derived from
the session (`session:<id>`, `agent:<id>`). Before this, the tenant lived only *inside*
the record (`session_context.semantius_org`), so "every session of org X" meant reading
every value, and a cross-tenant mistake was invisible in a key listing. It goes INSIDE
the id rather than in front of the group prefix (`session:tests-user3-…`, never
`tests:user3:session:…`) because `kvGroupOf` splits on the first colon and every KV
prefix listing is left-anchored — the other order would create one browser group per org
and break `session:`/`agentdef:` listing.

Shape constraints, all enforced by `mintSessionId` and asserted in `pnpm test`:

- **Hyphens, not colons**, and hyphen-free segments: `:` would break `kvGroupOf` (split
  on the first colon), and compaction strips separators from the identity values, so a
  minted id is always exactly three `-`-separated parts — `<org>-<sub>-<tail>`.
- **The SANDBOX name is `<org>-<tail>` — the USER segment is dropped**
  (`sandboxNameForSession`, the single derivation every `getSandbox()`/`idFromName()`
  call and the `container:` pointer go through). The container name is the only consumer
  bound by the sandbox SDK's 63-char `sanitizeSandboxId` DNS-label ceiling; the session
  id itself is just a KV key suffix (512-byte budget) and a DO name (unbounded), so the
  full sub never has to be squeezed into a DNS label. Caps: org ≤30 (so org + 32-hex
  tail fits 63), sub ≤64, id ≤128 (`SESSION_ID_MAX`). Channel ids (no hyphen) pass
  through `sandboxNameForSession` whole.
- **Pathological values only** (alphanumeric content beyond a cap) fall back to
  truncation plus a short FNV-1a hash of the original — a guard for the key budgets,
  not identity policy; no real IdP sub hits it.

Not every conversation id has this shape: **channel conversations** are keyed by their
channel's own instance id (`github:v1:owner:<o>:repo:<r>:issue:<n>`, minted by
`@flue/github`) and have no Semantius user at all. `isValidSessionId` stays the shape
gate on the routes that still take an id (`/sessions/:id/skill-check`,
`DELETE /sessions/:id` — both admin-key surfaces). Ownership is enforced by the chat gate
against `session_context.user`, never by the id's prefix: the prefix is for operators
reading the key space, not an access-control decision. `GET /sessions` (the per-agent
page's session sidebar) is the tenant-prefix listing in action — the caller's prefix
narrows the KV read, and ownership is still re-checked per record against
`session_context.user` before an entry is returned.

**Session substrate expires 24 h after last activity (fail-closed by design):** the
bundle snapshot (`agent:<id>`), THE session record (`session:<id>`), and the container
pointer (`container:<containerId>`) all carry a 24 h TTL; every merge into the session
record (e.g. the per-response `session_state` mirror) refreshes its TTL, so an idle
session expires 24 h after its last response. A session's `egress_secrets` are never
recreated by the self-heal (design §13 C5) — an expired chat session loses egress and, on a cold
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

The **R2 backups** collection lists the workspace backup archives (one per session — see
"Workspace backup & restore"): rows are labeled with the full session id from each
archive's `meta.json` (strays without one are grouped separately), dated by `createdAt`.
The detail view shows the meta facts, whether the owning session is still alive, the
storage run rate, and a Download button for the squashfs archive (an authenticated fetch —
a plain link would lack the Authorization header). No `BACKUP_BUCKET` binding = an empty
collection with a note, never an error.

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
(`getSandbox(ns, sandboxNameForSession(sessionId))`), but Cloudflare's
`containersUsageAdaptiveGroups` dataset exposes no dimension carrying a name we choose.
Its dimensions are `instanceId` (platform-assigned, **not** derivable from the Durable
Object id), `applicationId`, `placementId`, `location`, `region`, `label(name: "…")` and
the time buckets; `sum` has `cpuTimeSec`, `allocatedMemory`, `allocatedDisk`, `txBytes`.
There is **no `containerName` dimension** — example queries that use one are wrong. So
`SemantiusCopilotSandbox` (`backend-b/src/cloudflare.ts`) stamps `session=<sandboxName>` on every
container it starts, by merging `labels` into the start options of both `start()` and
`startAndWaitForPorts()` — the two public paths into the SDK's
`startContainerIfNotRunning`, which resolves `options?.labels ?? this.labels`. It can't be
a plain `this.labels` assignment: the name is only known once the DO has loaded
`sandboxName` from storage, which happens after field initialisation.

**The label is the sandbox name, and the sandbox name is NOT the session id.** Since
tenant-prefixed ids shipped, a minted id is `<org>-<sub>-<tail>` but its container is named
`<org>-<tail>` (`sandboxNameForSession`, the user segment dropped to fit the SDK's 63-char
DNS-label ceiling) — so a cost row's label cannot be used as a KV key. Everything that needs
the full id resolves it through the `container:<containerId>` → sessionId pointer the egress
layer already maintains (`sessionIdForContainer`, `core/src/egress.js`): the Costs enrichment
computes `idFromName(label)` and follows the pointer (surfacing the result as
`fullSessionId`, which the UI links to), and the `session_sandbox` snapshot task resolves
through its own DO id. Channel conversation ids contain no hyphen, pass through
`sandboxNameForSession` unchanged, and keep working via the direct read. Getting this wrong
is what once blanked the Agent/Started/LLM columns: the enrichment read `session:<label>`,
which no longer existed.

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

**Three money columns, three different windows, never summed.** `Container $ (today)` is the
UTC-day figure above; `LLM $ (session)` is `session_state.cost_total` off THE session record
— the session's running LIFETIME total; `Backup $/mo` (with `Backup MB` beside it) is the R2
storage RUN RATE for the session's current workspace archive, off the same record's
`session_backup` node (see "Workspace backup & restore"). They sit side by side because
adding a day figure to a lifetime figure to a monthly rate produces a number that means
nothing. LLM and backup figures come from the same KV read that supplies Agent and Started,
so they show `—` once the session record is gone.
`pnpm costs` does not show them (no KV binding from Node); `pnpm sessions` is the LLM-cost CLI.

**`session_sandbox` — the durable snapshot.** The Costs tab is a live read-through to today's
analytics, so a session's container spend disappears from it once the day rolls over. To keep
it, `SemantiusCopilotSandbox` runs a small scheduled task that merges a `session_sandbox` node onto
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
/sessions/:id` does not stop the container.** It is three KV deletes plus a best-effort
delete of the session's R2 workspace backup; the container runs on until `sleepAfter`
(10 min) expires. So this callback routinely fires for sessions that were deliberately
deleted, and a create-when-absent merge would resurrect them *and* re-arm their 24 h TTL.
No record, no write. The acceptance suite deletes every session it creates, so this is the
common path, not an edge case.

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

## Workspace backup & restore (R2)

The container disk is ephemeral — reset to the image at `sleepAfter` (10 min idle) or
eviction — so everything an agent writes under `/workspace` (`semantius/specs`,
`semantius/blueprints`, `customizations.yaml`, the task list `.tasks/tasks.json`, …) used
to die with it. Backups close that
gap (design: `add_backup_restore_plan.md`):

- **Persist — every filesystem mutation** (since 2026-08-18; before, only at turn end,
  which lost anything written earlier in a turn whose container was reset mid-way).
  Three writers, all through `requestWorkspacePersist` (`backend-b/src/backups.ts`):
  - the lazy env's `onMutation` hook fires after **every** `exec` / `writeFile` / `mkdir`
    / `rm` a turn performs (`lazy-env.ts`, wired in `agents/main.ts`);
  - the agent's `useResponseFinish` fires the turn-end sweep, only when THIS submission
    touched the container (touched-registry; chat-only turns never boot a container just
    to archive it);
  - `POST /workspace/:id/files` after an upload.
  `requestWorkspacePersist` is per-session single-flight + coalescing: while one archive
  is in flight further requests only set a `pending` flag, at most ONE follow-up run
  happens (which by construction captures every coalesced mutation), and starts are
  spaced ≥1.5 s so the session-record write stays under KV's 1 write/s/key. Each run: the
  sandbox SDK builds a squashfs archive of `/workspace` (excludes `.agents`, `.tmp_admin`,
  `.tmp_deploy`, `.restored`) into the `BACKUP_BUCKET` R2 bucket, the `session_backup`
  node lands on THE session record, and the previous archive is deleted — exactly ONE
  backup per session, `meta.name` = the full session id (the join every consumer uses).
  A persist **refuses** a container without the `.restored` marker (`status:
  'unreconciled'`, log `backup: persist … skipped — container not reconciled`): that is a
  fresh disk that has not been merged with the session's archive, and archiving it would
  supersede a good backup with an empty one — the exact mechanism that once lost an
  uploaded file (container reset mid-turn, then the turn-end persist "won").
- **Restore** — on the next container-touching submission, `provisionWorkspace` restores
  the archive BEFORE skill provisioning, gated by the `/workspace/.restored` marker so a
  warm container is never re-extracted over (restore is an `unsquashfs -f` merge; the
  marker is touched even when there is nothing to restore or the R2 feature is off, and
  excluded from archives).
- **Mid-turn reset detection** — the container can be replaced UNDER a running turn
  (`sleepAfter` elapsing between two slow tool calls, eviction, a deploy); the SDK boots
  a fresh disk transparently. The lazy env therefore runs a `resetProbe` (one `exists`
  RPC on the `.restored` marker) before every container op once provisioned; a missing
  marker logs `lazy-env: container reset detected before <op>` and re-runs the full
  `provisionWorkspace` (restore + skills + env) before the op proceeds. The window that
  can still be lost is one tool call: mutations after the last completed persist and
  before the reset.
- **Mid-turn stub break (the 2026-08-19 incident)** — the reset probe's sibling self-heal,
  for the *other* thing that can die under a running turn: not the container but the
  **stub**, the client-side handle the agent DO holds on the sandbox DO (every method call
  on it is an RPC). The lazy env memoizes ONE stub per submission. workerd's contract is
  that a stub whose connection breaks stays broken: every later call on it rejects at
  once, while the DO and its container answer a NEW stub normally. Session
  `tests-user3-84351d826fa44ee1961c1439f094e58e` ("deploy <it-ops-starter URL>", Worker
  deployed 15:30:19Z, container image unchanged since 09:02): two `bash` calls fine
  (`ls`, toolchain check), then `semantius call crud getCurrentUser` failed after **28.9 s**
  with `internal error; reference = unbhcaukga1o6dadc9klavln` (workerd's opaque
  internal-failure text — the string lives in the workerd binary, not in our code, the
  Sandbox SDK, or the CLI), and the next five `bash` calls (`getCurrentUser` again,
  `semantius --help`, `env | grep`, `echo`, `true`) each failed in **9–12 ms** with a fresh
  reference id. The agent concluded "the shell is dead" and stopped cleanly (nothing
  written). Meanwhile the sandbox was healthy the whole time: the backup path builds a
  fresh stub per call (`getSandbox` → `binding.get(id)`) and landed **8** persists in
  75 s, the last at 15:34:19Z — 3 s after the turn ended — with the `.restored` marker
  present (so the container was never restarted either); `semantius whoami` on the same
  sandbox DO succeeded minutes later. The sandbox DO's own Workers Logs (read back the
  same day once `pnpm logs:query` existed — `--from 2026-08-19T15:33:00Z --to
  2026-08-19T15:35:00Z`, see Observability) settle the root cause: the CLI really ran
  (its MCP calls left `ContainerProxy … POST https://tests.semantius.ai/mcp` egress events
  at 15:33:32–39, so the command's result existed and was lost — the reason `exec` is not
  replayed below); at 15:33:43.567 the SDK's `containerFetch` (the DO's fetch to the
  container's port) failed with that very `internal error; reference = unbhcaukga1o6…`
  (`Error proxying request to container 22c64a…: at … containerFetch … CommandClient.execute
  … execWithSession`), the `exec` RPC event ended `exception` after 28 821 ms, AND the
  @cloudflare/containers keep-alive `alarm` that had been sleeping since 15:33:06 ended
  `exception` in the same millisecond, its retry was `canceled`, and the next event on the
  DO (the backup path's probe, 15:33:47.9) was served by a **fresh instance** (`Using http
  transport` = the SDK constructing a new container client) — i.e. the runtime's container
  proxy threw an internal error and the sandbox DO instance was **reset** under the
  in-flight call, while the container itself kept running. The agent's memoized stub was
  bound to the dead instance: for its next five calls the agent DO logged `lazy-env: reset
  probe failed, assuming live: Error: internal error; reference = <new id>` and the sandbox
  DO logged **nothing** — they never left the agent — while `backup:` persists #3–#8 ran
  through fresh stubs in between, all `ok`. Platform-side trigger (the proxy's internal
  error — Cloudflare's reference id); the cascade — five dead calls on a dead handle — was
  ours. Fix (`lazy-env.ts`, tests `scripts/lazy-env.test.mjs`):
  - every op that fails with a stub-break error (`isStubBreak`: `.retryable === true`,
    `internal error; reference = …`, `Durable Object reset because…`, `Network connection
    lost`) **drops the memoized stub** — the next op, whatever it is, builds a fresh one
    (`makeInner` again; the reset probe on it decides whether the container also needs
    re-provisioning); log line `lazy-env: sandbox stub broke during <op>: … — dropped`;
  - the failed op is **re-run on the fresh stub once** (`STUB_RETRY_LIMIT = 1`, a per-op
    counter — a second break in a row surfaces; never a third stub) when replaying is
    safe: reads, the reset probe itself (a probe that breaks re-probes on a fresh stub),
    and `writeFile` (idempotent by content);
  - **`exec`, `mkdir`, `rm` are never replayed**: the RPC may have failed on the way *back*,
    after the container ran the command (the 29 s call most likely did run), and a shell
    replay is at-least-once — a `semantius` write would double-apply. They fail with
    `sandbox connection dropped during this exec — it may or may not have taken effect;
    the connection is re-established, so check its effect and re-run only what is
    missing (<original error>)`, which Flue renders as the tool result: the model's own
    retry is the retry, and it lands on the fresh stub. `onMutation` still fires once.
  Replaying `exec` is a one-line flip (`REPLAY_SAFE` in `lazy-env.ts`) if at-least-once
  shell is ever preferred over the extra model round-trip; it is deliberately off.
- **Transport** — the SDK's `localBucket: true` mode: the sandbox DO streams bytes over
  its own control channel and uses the R2 binding directly. No presigned URLs, no R2
  access keys, no container egress — nothing new for the egress whitelist or the
  Dockerfile CA story. (The SDK comments label the mode "local dev"; the code path has no
  environment check and runs identically deployed — verified against the exact-pinned
  0.12.3. Re-verify on any SDK bump.) The channel is slow (~0.6 MB/s) and restore can
  buffer the archive in DO memory, so archives must stay small — the excludes keep them
  KB–MB and `size_bytes` is surfaced everywhere so growth is visible.
- **Deletion is tied to the session lifecycle three ways** (the "R2 deleted when the
  session ends" requirement): supersede-delete at each persist; `DELETE /sessions/:id`
  removes the backup with the record; and an hourly cron sweep (`triggers.crons` in
  wrangler.jsonc → the `scheduled` handler exported from `backend-b/src/cloudflare.ts`)
  deletes backups whose session record expired at its silent 24 h TTL. Sweep rules
  (`core/src/backup.js`, each gated on a 1 h grace): session record gone; superseded
  orphan (record points at a different backup id); SDK-ttl elapsed; nameless/malformed/
  meta-less strays. Channel-session backups are never RE-gated (their ids fail the
  minted-id shape but have real records).
- **Feature gate** — no `BACKUP_BUCKET` binding = everything off, zero behavior change,
  `configured: false` with a reason on the admin surfaces.

Admin oracles (API-key guard; the exec-bearing actions boot the container — that is the
point):

```bash
GET    /admin/backups                      # list archives (id, session, size, createdAt)
DELETE /admin/backups/<backupId>           # manual delete
GET    /admin/backups/<backupId>/archive   # download the squashfs
POST   /admin/backups/sweep                # run the cron body now -> {scanned, deleted, kept}
POST   /admin/sessions/<id>/backup         # body {action: "backup" | "restore" | "status"}
```

`action:"backup"` reconciles first (marker-guarded restore, a no-op on a warm container),
then runs the exact persist path inline and returns its outcome; `action:"restore"`
clears the marker first so the replay is deterministic on a warm container. One-time setup, BEFORE the first deploy with the binding:
`wrangler r2 bucket create semantius-copilot-backups`.

## Workspace files (upload & download)

Users can put files into a session's `/workspace` and get them back out. Two
user-facing routes on backend B (`backend-b/src/app.ts`, helpers in
`backend-b/src/workspace.ts`):

```bash
POST /workspace/<sessionId>/files?filename=<urlencoded>   # raw body -> {ok, name, size, renamed}
GET  /workspace/<sessionId>/<name>                        # the file bytes, as an attachment
```

Both sit behind the user credential (Semantius bearer or better-auth cookie —
same `userTokenGuard` as chat) plus the `/agents/main/*` ownership contract:
400 malformed id, 401 unknown session, 403 someone else's. The csrf guard is
mounted on `/workspace/*` too; CLI callers just need a non-form-like
Content-Type on the upload:

```bash
curl -X POST "$BASE/workspace/$SID/files?filename=report.pdf" \
  -H "authorization: Bearer $TOKEN" \
  -H "content-type: application/octet-stream" --data-binary @report.pdf
curl -OJ "$BASE/workspace/$SID/report.pdf" -H "authorization: Bearer $TOKEN"
```

Semantics:

- **Flat names only.** Path separators, `.`/`..`, control chars, >128 chars →
  422/400. Unicode is fine (URL-encoded in, RFC 5987 out).
- **Collision-safe.** `report.pdf` → `report (1).pdf` → … ; the response's
  `name` is what actually landed, and the composer inserts that.
- **Size caps.** Upload 10 MB, download 25 MB (`workspace.ts`) — transfers are
  base64 strings over the sandbox DO's control channel (~0.6 MB/s; the SDK's
  streaming file APIs throw on the default HTTP transport), so both ends
  buffer the whole file.
- **Backup interplay.** Both routes run `restoreWorkspaceBackup` first (a cold
  container's workspace lives only in R2 — without this, uploads would miss
  name collisions with archived files and downloads would 404), and the upload
  fires `persistWorkspaceBackup` afterwards via `waitUntil` (the turn-end
  backup only covers submissions that touched the container, so an
  out-of-turn upload persists itself). No `BACKUP_BUCKET` = today's ephemeral
  behavior, never an error.
- **Download posture.** Always `application/octet-stream` +
  `content-disposition: attachment` + `x-content-type-options: nosniff` —
  user/agent-controlled bytes on the backend origin must never render inline
  (uploaded HTML would otherwise be stored XSS).

In the UI, the composer's **+** button
(`frontend/src/components/ai-elements/workspace-upload.tsx`, mounted in
`agent-chat.tsx`) uploads via `uploadWorkspaceFile` (`session.ts`) and inserts
the final name into the prompt input with a leading and trailing space. In
draft mode (no session yet) the upload creates the session on the spot —
without remounting the composer — and the first message send reuses that same
session (one shared create promise in `agent-chat-container.tsx` dedupes the
two paths). `workspaceFileUrl()` in `session.ts` builds download URLs; fetch
them with `authFetchInit(auth)`.

**Agent-emitted download links.** Every chat-channel system prompt gets a
static block appended (`WORKSPACE_LINK_INSTRUCTIONS` in
`backend-b/src/agents/main.ts`) telling the agent to hand files to the user as

```
[display name](/workspace/{sessionId}/file-name)
```

with the LITERAL `{sessionId}` placeholder — static text keeps the prompt
prefix identical across sessions, so provider-side prefix caching keeps
working. The chat renderer closes the loop
(`frontend/src/components/ai-elements/workspace-link.tsx`, wired as a
streamdown `components.a` override in `agent-chat.tsx`): it substitutes the
real session id from context and downloads via authenticated fetch + blob
(a plain `<a href>` to the cross-origin backend would carry no credential).
The block is NOT appended on the GitHub channel — issue-derived conversation
ids fail the `/workspace` route's session-id check. Trade-off, accepted: the
`components.a` override replaces streamdown's built-in anchor for all links,
so external links render as plain new-tab anchors without the link-safety
confirm modal.

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
(mutable from tool `run()`/lifecycle callbacks, never during render). Note the tool
`run()` return contract under Flue 2.0.3: a plain-object return MUST be the
`{ output?, terminate? }` envelope — a bare value object (`{ ok, key }`) is rejected with
"unexpected key" and the call errors. `update_session_data` and the GitHub channel's
`comment_on_github_issue` returned bare values until 2026-08-18 (found while adding the
task tools); both now return `{ output: … }`.

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
written by `SemantiusCopilotSandbox.recordSandboxCost()` — a scheduled task armed at container start that
fires 15 minutes after the container stops — so the figure survives the Costs tab's
today-only window. Written with
`mergeExistingSessionRecord`, so it can never resurrect a deleted session — see "Container
costs" for why that matters.

**`session_backup` — infra-written, updated at each workspace-touching response.** The
durable record of the session's R2 workspace backup (see "Workspace backup & restore"):
`backup_id`, `size_bytes`, `backup_count`, `last_backup_at`, `storage_monthly_usd` (the
R2 storage run rate — the Costs tab's `Backup $/mo` column). Written by
`persistWorkspaceBackup` (`backend-b/src/backups.ts`) with `mergeExistingSessionRecord`,
so it never resurrects a deleted session; if the session vanishes mid-persist, the fresh
archive is deleted on the spot rather than orphaned.

## AskUserQuestion (structured user prompts)

The `AskUserQuestion` tool (`backend-b/src/tools/ask-user-question.ts`) lets the model ask
the user 1-4 multiple-choice questions through an interactive card — Claude Code's tool of
the same name, schema-compatible at its core (question/header/2-4 options with
label+description/multiSelect; no `preview` support). One deliberate deviation: the
`header` cap is 64 chars, not Claude Code's 12 — that limit exists for its fixed-width
TUI tab bar, while our HTML chip row wraps, so headers like "Access control" must not
fail validation (every input valid for Claude Code remains valid here). Mounted for web/chat sessions only —
the GitHub channel has no browser, and an unmounted tool cannot be called.

**Turn-boundary design.** Flue has no human-in-the-loop primitive (no approval states, no
elicitation, tool `run()` resolves server-side), so the tool does not block: it validates,
echoes the question texts, and ends the response with `terminate: true`. The chat UI
(`frontend/src/components/ai-elements/ask-user-question.tsx`, wired in `agent-chat.tsx`)
renders the card from the dynamic-tool part's `input` and sends the selections back as a
**`kind: 'signal'` delivery** on the same conversation POST:

```
{ kind: 'signal', type: 'ask_user_question.answer', tagName: 'user_answers',
  attributes: { toolCallId },
  body: JSON.stringify({ toolCallId, cancelled, answers }) }   // answers: question text → label(s)
```

A signal wakes the idle agent as its own submission and renders to the model as a
`<user_answers toolCallId="…">` block; its projection is `display: 'diagnostic'`, so the
raw JSON never shows as a chat bubble. The frontend matches answers by
`message.signal.tagName` + `attributes.toolCallId` (the delivered `type` is not projected)
and derives every card state from history alone — answered beats all; anything not on the
last visible message is stale (typing a normal reply = implicit skip); an unsettled answer
send renders "Sending…" and holds the busy strip (the hook's status stays `idle` between a
raw `client.send()` and the first streamed token). `idempotencyKey:
ask-user-question:<toolCallId>` makes double-clicks and two-tab races converge on one
admission. Multi-select answers join labels with `", "`; the auto-added "Other" option
returns the typed text verbatim; Dismiss sends `cancelled: true`.

**Batch caveat — the tool must be the only call in its response.** `terminate` is honored
only when *every* call in the model's tool batch carries it (pi-agent-core
`shouldTerminateToolBatch` is a unanimity predicate; flue mirrors it durably in
`isTerminalTrailingToolBatch`). A sibling call in the same response — an `edit`, a `bash`, a
hallucinated tool — cancels the pause: the batch settles, the loop continues, and the model
is handed another step before the user has answered. Seen live on 2026-08-17 (importer flow):
`edit` + `AskUserQuestion` in one batch → loop continued → the model "called" the
`user_answers` XML tag as a tool (`Tool user_answers not found`) → "waiting on your
decisions…" text. Nothing was auto-submitted (the card derives its state from the answer
signal alone and stayed `pending`; the user's later submit worked), but the run looked
broken. There is no mechanical seam: `useModel` exposes no parallel-tool-calls knob, flue
builds the Pi agent with `toolExecution: "parallel"` and wires neither `beforeToolCall` nor
`afterToolCall`, and pi-ai's openai-completions path has no `parallel_tool_calls` flag. The
defense is therefore the tool contract: the description forbids sibling calls ("finish edits
and commands in an earlier step, then call AskUserQuestion alone"), names `user_answers` as
an input block that is not a tool, and scopes a stop directive to *the same response* and
*this call's toolCallId* ("if handed another step before a `<user_answers>` block for this
toolCallId or a new user message arrives, end with no text and no tool calls" — scoped so a
later typed reply is still answered normally and an earlier round's answers, already in
context on the second ask of a multi-round flow, are not mistaken for the current one); the
tool output carries the same directive
as an `instruction` field, which is what the model reads if the loop continues anyway (the
frontend never reads the output; the probe checks only `output.status`). The other way the
continued loop plays out — seen live 2026-08-18 (admin flow, session
`tests-user3-99d2f5dada57466ba2d08df7b621d204`): the ledger's `TaskUpdate` + `AskUserQuestion`
in one batch → loop continued → the model, instead of ending silently, called
`AskUserQuestion` again *alone* with the same questions → that call terminated the response.
Two settled `AskUserQuestion` parts on the last visible message both derived `pending`, so the
chat showed two interactive copies of one card. The renderer now treats it as what it is: an
earlier, unanswered ask followed by a later ask in the same message is *superseded* — folded
into the tool-call group like any other settled call (`supersededQuestionCalls` in
`agent-chat.tsx`), and only the LAST ask is the live card. The last one, not the first, because
its toolCallId is the one the answer must carry: an answer addressed to the earlier call would
leave the later call's "no `<user_answers>` for THIS toolCallId → end silently" directive in
force. A superseded ask is not rendered "Skipped" (that badge means the user passed over a card
they had, not one they never got), and an earlier ask that did receive an answer (a delivery
joined into the running response) keeps its answered card. The skills under
`agents/semantius-admin/skills/` are maintained upstream and are never edited here; the
matching skill-side guidance ("call it alone, after edits; `user_answers` is an input block")
is filed as `askuserquestion-skill-change-request.md` for upstream. Rejected: a stub
`user_answers` tool (advertises the very name to avoid, costs schema tokens on every request,
and a model calling it *instead of* AskUserQuestion would end the turn with no card — today
that mistake self-heals via the tool error) and renaming the tag (duplicated in the frontend
constant, README, and probe; old sessions carry it in history).

`node scripts/ask-user-question-probe.mjs` verifies the full round-trip against the
deployed backend: ask turn settles `completed` with the tool part, the answer signal wakes
the agent and projects `system/dispatch/diagnostic`, and the reply repeats the chosen label.

## Failed runs, stopped runs, retry

Three things can go wrong with a chat turn, and until 2026-08-18 the surface showed none of them
beyond the submit button flipping to ✕ (`toChatStatus`): the run **failed** server-side (an LLM
upstream error mid-stream, a context overflow, a tool crash), the **send** never reached the
server (401 / 5xx / offline), or the **observation** dropped (history fetch / SSE). The trigger
was session `tests-user3-01f28da3ae2c4450be9db37564b40dd5`: OpenRouter's Inceptron host
crashed mid-stream (`Upstream error from Inceptron: EngineCore encountered an issue…` — vLLM's
`EngineDeadError` text), the reasoning stopped mid-sentence, and the message existed only in
the admin console's raw JSON `settlements`. Nothing retries a turn on its own: pi-ai's
`retryProviderRequest` retries only request *establishment*, a mid-stream `error` chunk becomes
`stopReason: "error"` and the loop ends; OpenRouter's fallbacks apply only before the first token.

**Failed / stopped runs render inline in the transcript** (`run-outcome.ts` +
`run-outcome-notice.tsx`, wired in `agent-chat.tsx`). Truth is `agent.settlements` joined to
the *visible* messages by `submissionId` — the user message that opened a submission and the
partial assistant reply it produced share one id — never `agent.status` / `agent.error`:

- Flue appends **no advisory message on the normal failure path** (verified live: the
  conversation held the user message, the partial assistant message — both `display:
  'visible'` — and one `failed` settlement, nothing else). Only the reconciliation and abort
  paths append a `submission_interrupted` / `submission_aborted` advisory, and that projects
  `display: 'diagnostic'`, which the transcript filter drops anyway.
- `useFlueAgent().status === 'error'` for a failed run applies only to submissions sent by
  **this tab** (`localSubmissionIds`) and is cleared only by the next hook-managed
  `sendMessage()`; after a reload a failed tail reads `idle`. So, like the AskUserQuestion
  answer state and the task fold, the notice is re-derived from history on every render and
  survives reloads and the container's key-flip remount.

`deriveRunNotices(messages, settlements)` anchors each `failed` / `aborted` settlement on the
LAST visible message carrying its id (the partial reply if any, else the user bubble) and marks
it `atTail` when nothing visible follows — the only place a Retry is offered. A settlement no
visible message carries (a signal-triggered run — its input projects `diagnostic` — that failed
before any output) renders at the end of the transcript, only when it is the newest settlement
and the transcript is at rest (no pending echo, last message settled). Joined deliveries
(`answeredBySubmissionId`) fold into their host's notice. `completed` settlements render nothing —
the reply is the marker. Mid-run there is no settlement, so no notice appears while streaming.

What the user sees: `run failed — <settlement.error.message>` in a destructive-bordered box
under the failed turn, `details` collapsed when the settlement carries any (Flue's own
`internal_error` text asks the user to quote the submission id, so it is in there), and
**Retry** at the tail; a stopped run gets a muted `Stopped.` (Flue folds an aborted partial
into the next turn on its own, so no action is offered).

**Retry sends a visible, hook-managed user message** (`retryMessageFor`): with a partial reply
in history, `Continue — your previous response was interrupted by an error: <first line of the
message, without Flue's direct(<sub>) failed: wrapper>. Pick up where you stopped; do not
repeat work that already completed.`; without one, `Try again — your previous response failed
before producing anything: <reason>.` A visible message was chosen over a hidden `kind: 'signal'`
nudge because it goes through the hook: the busy strip and ⏹ work, the pinned ✕ clears, and
after a reload the transcript explains itself. The button is inert while a send/run is in
flight and disappears as soon as anything newer is in the transcript.

**Failed sends** render above the composer as `send failed — <message>` with a Retry that
re-sends the text verbatim (`agent.failedSends[i].message` — nothing reached the server); the
optimistic bubble stays in the transcript until the next dispatch clears it (reducer). Every
`agent.sendMessage(...)` call in the surface is `.catch(() => {})`: the hook records the
rejection in `failedSends` before rethrowing, so the rejection itself carries nothing more.
**Connection errors** (`status: 'error'` explained by neither a failed send nor a failed
settlement — the reducer builds the settlement flavour of `agent.error` as
`new Error(String(settlement.error.message))`, which `settlementErrorOf` mirrors, so a message
match rules it out) render as `connection error — <message>` with a **Reconnect** button →
`agent.refresh()`.

`scripts/run-outcome.test.mjs` (part of `pnpm test`) covers the derivation over the real
session's shape plus aborted / completed / older-failed / unanchored / pending-echo / joined
cases and the message helpers.

## Task tracking (TaskCreate / TaskUpdate / TaskList / TaskGet)

The four task tools (`backend-b/src/tools/tasks.ts` + the pure `task-store.ts`; design §17)
give every agent a durable checklist for multi-step work and give the chat UI a structured
progress signal. They are **Claude Code's Task tools, verbatim** — same names, input schemas,
result shapes and semantics as Claude Code 2.1.92 (extracted from its bundle), the successor
to `TodoWrite`, which is deliberately NOT provided:

| tool | input | result |
| --- | --- | --- |
| `TaskCreate` | `{ subject, description, activeForm?, metadata? }` | `{ task: { id, subject } }` |
| `TaskUpdate` | `{ taskId, status?, subject?, description?, activeForm?, owner?, metadata?, addBlocks?, addBlockedBy? }` — `status: "deleted"` removes | `{ success, taskId, updatedFields, error?, statusChange? }` |
| `TaskList` | `{}` | `{ tasks: [{ id, subject, status, owner?, blockedBy }] }` (open blockers only; `metadata._internal` hidden) |
| `TaskGet` | `{ taskId }` | `{ task: { id, subject, description, status, blocks, blockedBy } \| null }` |

Ids are sequential strings from a high-watermark (a deleted id is never reused);
`addBlocks`/`addBlockedBy` link both sides; `metadata` merges (`null` deletes a key);
`updatedFields` names only what changed. A UI written against Claude Code's `tool_use` /
`tool_result` stream renders ours unchanged. The always-present Flue built-in `task` tool
(subagent delegation) is unrelated — the descriptions say so. Mounted on **every channel**
(`agents/main.ts`, `taskTools(id)`), and a static `TASK_TRACKING_INSTRUCTIONS` paragraph
(literal text — the cached prompt prefix stays byte-identical) tells the model when to use them.

**On disk: one JSON document, `/workspace/.tasks/tasks.json`** (`{ version, highwatermark,
tasks[] }`, pretty-printed — `cat` it). It is a workspace file like any other, so it rides the
per-mutation R2 backup and is restored before the first read of the next container life: the
list survives compaction, a paused turn, a container reset and a session restart. Why one index
file and not Claude Code's one-file-per-task layout: the lazy env answers `exists`/`readdir`/
`stat` outside the skills tree from the KV bundle view ("not there") until the container is
provisioned — only `readFile`/`exec`/writes boot + restore — so a `readdir` of a task directory at
the start of a submission would report zero tasks without ever restoring the backup; one
`readFile` boots, restores, then reads (a read failure is disambiguated with a now-live
`exists`, so a real failure is never mistaken for "no tasks"). Not under `.agents` (excluded from
archives), not at the top level (user-downloadable). Corrupt content (a squashfs taken
mid-write) is set aside as `tasks.json.corrupt-<iso>` and the list restarts empty. Cost: the first
task op of a submission provisions the container like any `bash`/`read`; each later op pays one
`resetProbe` RPC; each write triggers a coalesced R2 persist; a read-only `TaskList` turn still
marks the workspace touched (one squashfs at response finish).

**Parallel batches.** Flue executes a tool batch in parallel; three `TaskCreate` calls in one
assistant message would race the read-modify-write and mint duplicate ids. `defineTool` has no
sequential-execution flag, so every task op runs under a per-session promise-chain mutex (one
conversation = one Durable Object = one isolate; pi starts the parallel executions in call
order, so ids come out in message order). The tools reach the sandbox via `harness: true` →
`harness.sandbox` — the lazy env `useSandbox` created — so writes fire `onMutation →
requestWorkspacePersist` with no extra wiring.

**Call economy and latency.** `TaskUpdate` takes `status`, `addBlockedBy` and `addBlocks` in ONE
call, both arrays take several ids, and every link is mirrored onto the other task — so "chain
it, point it at its parent, start it" is one round trip per task, and gating a stage on N open
questions is one `{"taskId":"<stage>","addBlockedBy":[<N ids>]}`, not N calls (the tool
description says so; a skill that prescribes one call per field triples the bookkeeping — see
`task-tools-skill-change-request.md`). `TaskCreate` stays Claude Code's schema (no edge fields),
deliberately. Per-call latency is NOT a function of list size — a 14-task store is ~4 KB and
parse/serialize is microseconds — but of sandbox I/O and scheduling: a write is probe + read +
write RPCs; every write starts a workspace persist (marker `exec` + mksquashfs + upload over the
~0.6 MB/s channel, on the same container) that later ops contend with and that grows with the
workspace over a run; and calls the model batched into one message queue behind each other on
the mutex while Flue times each from invocation, so the Nth call reports the wait for calls
1..N-1 (an escalating 0.2 s → 2.4 s → 6 s series is that shape, not a slow store). Every op logs
one line in `wrangler tail` to tell these apart:
`tasks: TaskUpdate #3 queue=1804ms read=212ms write=188ms n=14 bytes=4120 persist=inflight` —
`queue` is the mutex wait, `read`/`write` the sandbox I/O (incl. the reset probe; `write`
omitted when nothing changed), `n`/`bytes` the store after the op, `persist` whether a
workspace persist was running for the session when the call arrived (`backups.ts
isPersistInFlight`). The same line goes to Flue's logger with the numbers as attributes (the
conversation activity stream). Measured 2026-08-19 with `task-tools-probe.mjs` (three
`TaskCreate` in one message): `queue=0ms read=3594ms` (the boot), then `queue=3673ms
read=141ms write=123ms`, `queue=3937ms read=82ms write=123ms` — the second and third calls
reported ~4 s each for ~0.25 s of work; warm ops read in 80–140 ms and write in 80–130 ms; each
persist of that 4 KB workspace took 0.7–0.8 s (one 2.6 s). Size check, same day: 20 creates with
~200-char descriptions (365 B/task, 7 KB at the end), one per turn so `queue=0` — `read` stayed
55–120 ms and `write` 90–300 ms from n=2 to n=19 with no trend against bytes (outliers `read=582`
and `read=245 persist=inflight` sat next to persists, not large lists); persists ran back-to-back
at 0.7–2.5 s each for a constant 4 KB archive. In that run the container died during the 9th
consecutive persist (`container is not listening`, the persist's `rm -f` → 500), the lazy env
restored backup #8 inside the next call (`read=7293ms`), and the write that had triggered the
fatal persist was lost (19 tasks for 20 creates) — the one-call loss window above, provoked by
the per-write persist load itself. One observation, not proof of causation; a debounce of task
persists is the lever if it recurs.

**The UI** (`frontend/src/components/ai-elements/task-fold.ts` + `task-progress.tsx`, part of the
copyable folder) folds the conversation's settled task tool parts — `TaskCreate` results and
`TaskUpdate` inputs into a map keyed by id, `TaskList`/`TaskGet` results merged and pruned — into a
collapsible checklist + progress bar pinned above the composer (starts collapsed — the header
row shows count, bar and the current task; in_progress rows show `activeForm`, completed rows
are struck through, blocked rows name their open blockers, owners get a badge). Durable truth is history: reloads and the key-flip remount re-derive the same
panel; `output-error` parts and `success:false` updates never phantom-update it. Individual calls
stay collapsed in the tool-call group (`TaskUpdate #3 → completed` on the row).

Tests: `scripts/tasks.test.mjs` (in `pnpm test`; imports the two pure `.ts` modules straight
into Node) — the reference semantics, the fold over a synthetic conversation, and a parity check
that folding the events the store emitted reproduces the store's own list.
`API_TOKEN=$(cat .api-token) node scripts/task-tools-probe.mjs` verifies the deployed backend:
three creates in one turn get ids 1..3, updates report `statusChange`, `TaskList` reflects them,
the session record gains a `session_backup`, and a second submission lists the same state and
`TaskGet`s a full record.

## GitHub channel (backend B)

`backend-b/src/channels/github.ts` (`@flue/github`) connects IntranetFactory/semantius-copilot to
the `main` agent: `issues.opened` and `issue_comment.created` dispatch one conversation per
issue; replies are posted via the `comment_on_github_issue` tool and carry a
`<!-- semantius-copilot-agent-reply -->` marker the webhook skips (loop guard). The agent instructions
must insist on the tool — otherwise the model answers in plain conversation text and
nothing appears on GitHub.

- Webhook endpoint: `https://semantius-copilot-backend-b.ma532.workers.dev/channels/github/webhook`,
  mounted in `app.ts` **before** the API-key guard (auth is `X-Hub-Signature-256`, not the
  bearer). The explicit early mount is load-bearing.
- GitHub conversations run the trip-planner agent directly from the no-TTL KV entry
  `agentdef:hoth-trip-planner` (`GITHUB_AGENT_NAME` in `channels/github.ts`) — the same
  definition chat sessions ingest by name; a normal `pnpm deploy:agent hoth-trip-planner`
  (or `--all`) updates both. No alias key exists anymore (the former
  `agentdef:github-default` and the pre-named-definition keys are dead). These
  conversations never pass the ingest route, so the agent initializer self-heals their
  whitelist — but, like every session, they get no `egress_secrets` until the
  secret-retrieval layer exists (the former initializer-minted `github`-tagged entry was
  removed with the rest of the server-side minting), so the credential-required echo host
  fails closed. They carry no Semantius
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

Both backends export traces to the Braintrust project **`semantius-copilot`** via the Flue tooling
blueprint (`flue add tooling braintrust` — it prints an agent-directed blueprint, it does not
edit files). Per backend: `braintrust@3.17.0` (pinned) + `src/braintrust.ts` (the
`observe(...)` bridge, imported first in `app.ts`).

- **Key**: `BRAINTRUST_API_KEY` is a Worker secret (`wrangler secret put`) and in gitignored
  `.dev.vars` — never a wrangler `vars` value. Without the key the bridge is a no-op:
  nothing initializes, the app runs untraced.
- **Project name**: `BRAINTRUST_PROJECT_NAME=semantius-copilot` in each `wrangler.jsonc` `vars`.
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

Both backends also export to the Arize AX project **`semantius-copilot`** via Flue's own
OTel adapter — `@flue/opentelemetry` (pinned to the same runtime version) +
`src/otel.ts` per backend (imported next to `./braintrust` in `app.ts`). The
adapter projects runtime observations onto OTel **GenAI semconv** spans
(`invoke_agent` / `chat` / `execute_tool` / `flue.operation …`), and Arize
normalizes `gen_ai.*` into OpenInference at ingestion (span kind inferred from
`gen_ai.operation.name`), so kinds, messages, token counts, and tool args
render natively — no client-side mapping.

- **Keys**: `ARIZE_SPACE_ID` + `ARIZE_API_KEY` are Worker secrets
  (`wrangler secret put`, `.dev.vars` locally). No secrets = the bridge is a
  no-op. `ARIZE_PROJECT_NAME=semantius-copilot` is a `wrangler.jsonc` var.
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
  `invoke_agent` span's input/output — but the runtime (observed on the 2.0
  nightlies; the enrichment is a no-op if a later version projects it) emits
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
project `semantius-copilot` → the session should appear with the full
invoke_agent → chat → execute_tool tree. Export failures surface as
`arize: OTLP export …` warnings in `wrangler tail`. A direct probe of the
endpoint from Node (same serializer + headers) returned 200 on 2026-07-26.

### Workers Logs after the fact (`pnpm logs:query`)

The three sinks above see what the *agent* did (spans, tool calls, tokens). What the
*Worker and its Durable Objects* logged — the `lazy-env:` boot / reset / stub-break
breadcrumbs, `backup:` persist outcomes, the egress broker, and the runtime's own
exception events with their `reference =` ids — is Workers Logs (`observability.enabled`
in wrangler.jsonc, retained for days). `pnpm logs` (`wrangler tail`) only shows it live;
`scripts/logs.mjs` reads it back through the Workers Observability query API:

```bash
pnpm logs:query                                    # last 30 min
pnpm logs:query --from -2h --level error
pnpm logs:query --from 2026-08-19T15:33:00Z --to 2026-08-19T15:35:00Z
pnpm logs:query --grep unbhcaukga1o6dadc9klavln    # a runtime reference id
pnpm logs:query --session <session id>             # lines that carry the id (backup:, request URLs)
pnpm logs:query --do <durableObjectId> --json      # one DO's events, raw
```

It needs a Cloudflare API token with **Account → Workers Observability → Read** —
`CLOUDFLARE_OBSERVABILITY_TOKEN` in `backend-b/.dev.vars` (local only, never a Worker
secret), falling back to `CLOUDFLARE_API_TOKEN` if that one is widened to carry the
permission. Neither token the repo held before (Analytics-read, the wrangler OAuth login)
can read logs (`10000 Authentication error`) — which is why the 2026-08-19 stub-break
post-mortem ("Mid-turn stub break" above) had to be reconstructed from Braintrust span
timings and the session record instead of the DO's own log lines.

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
(pinned to the deployed version), C2 (concurrent sessions both fail closed at the
credential-required echo host — the distinct-credentials and `x-semantius-org` assertions
return with the secret-retrieval layer), C3
(single source of truth — reconstructed sandbox files == bundle bytes, sha256 per file),
C4 (the credential-required echo host fails closed — 403, no unauthenticated forward —
until secret retrieval exists; the injected-credential assertion returns with it), C5
(repeated creates by one user mint distinct ids — immutability per id is by construction
now that the route mints them — plus fail-closed egress after teardown), session-id shape
(server-minted, tenant-prefixed, sandbox-safe), plus clean-base, zero-skill-agent,
per-agent-egress deny-all, session_context / session record (THE `session:<id>` record
carries JWT context + whitelist + org_whitelist + containerId in one document — and no server-generated
credential, `egress_secrets` stays absent until secret retrieval exists — the
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

All 86 acceptance checks pass against the deployed Workers (the `[cookie]` block skipped —
it needs a live better-auth session cookie); re-verified on the Flue 2.0.3 upgrade
(2026-08-11), which included the live-sandbox blocks (`[clean-base]`, `[C3]`, `[C4]`,
`[credentials]`, `[backup]`) that exercise the renamed `createSandbox` factory end to
end. (The original A/B thesis — image-baked and dynamically-delivered skills produce
byte-identical sandboxes and identical `activate_skill → read → bash` behavior — was
proven while backend A still existed; see git history.) Two wiring findings and the egress HTTP-vs-HTTPS caveat are
recorded in [`copilot-design.md`](./copilot-design.md) §7.

**Workspace backup restore-over-sleep, proven live 2026-08-05:** a real LLM turn wrote
`/workspace/semantius/proof.txt`; the turn-end persist archived it to R2 unprompted; the
container idled out at exactly `sleepAfter` (10 min, `stoppedAt` on the DO); a second turn
on the same session — cold container, marker absent — restored the archive during lazy
provisioning and `cat` returned the exact content. The same run also demonstrated the
documented KV-no-CAS window: `DELETE /sessions/:id` read a stale replica (the fire-and-forget
persist had merged a NEWER `backup_id` seconds earlier), deleted the superseded id, and left
the fresh archive orphaned — which is exactly the case sweep rule (b)/(a) exists for; the
hourly cron (or `POST /admin/backups/sweep`, or `DELETE /admin/backups/:id`) removes it.

**Per-mutation persist + mid-turn reset detection, proven live 2026-08-18:** one real turn
with four sequential `bash` calls (`echo one > t1.txt`, `echo two > t2.txt`,
`rm -f /workspace/.restored` to simulate a reset, `cat t1.txt t2.txt`). Logs showed
`backup: persisted … (#1)`, `(#2)` after the first two calls; the persist after the
marker removal was refused (`persist … skipped — container not reconciled (marker absent),
keeping <id> backup`); the fourth call logged `lazy-env: container reset detected before
exec: cat … — re-provisioning`, restored, returned `one two`, and persists resumed `(#3)`,
`(#4)` — `session_backup.backup_count: 4`, marker re-armed. The full acceptance suite
(incl. `[backup]`, whose `action:"backup"` oracle now reconciles first) passed the same day.

## The `/sessions/:id/skill-check` route

A **bounded** test affordance (behind the API-key guard): it runs one of a fixed set of
deterministic commands (`opening-times`, `hash-skill`, `count-skill-files`, `curl-check`,
`semantius-whoami`, `semantius-env`) built server-side from strictly validated structured params — **not**
arbitrary shell. It exists to drive the acceptance oracle; it is not a product route.
