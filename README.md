# Hoth Trip-Planner POC

Proves that **two agent-delivery mechanisms yield identical agent behavior** on Flue +
Cloudflare Sandbox:

- **Backend A** — hard-coded / OOTB: the fixed `hoth-trip-planner` agent, its skills
  **baked into the container image**, instructions/model resolved at build time.
- **Backend B** — dynamic bundle, **multi-agent**: a whole agent (instructions + model
  overrides + ALL its skills) is serialized as **one JSON string** — the *agent bundle* —
  delivered at session creation, and reconstructed into the sandbox (the multi-tenant
  path). Which agent a session runs is data, not code.

See [`hoth-poc-plan.md`](./hoth-poc-plan.md) for the full design and acceptance criteria.

## Deployed

| Deployable | URL |
| ---------- | --- |
| Frontend (A/B chat UI) | https://hoth-poc-frontend.ma532.workers.dev |
| Backend A — image-baked skills | https://hoth-poc-backend-a.ma532.workers.dev |
| Backend B — dynamic bundle (multi-agent) | https://hoth-poc-backend-b.ma532.workers.dev |

All three run on Cloudflare Workers (account `Ma@adenin.com`). Backends A and B each own a
container app (Containers) and a private KV namespace; the frontend is a static SPA served
from Workers assets with the two backend URLs baked in at build time.

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
             deterministic skill-check. `@hoth/core/node` adds the bundler library
             (fs walk, JSONC parse via jsonc-parser).
backend-a/   Flue+CF Worker — the FIXED hoth-trip-planner agent; its skills are baked
             into the image (Dockerfile COPY of agents/hoth-trip-planner/skills),
             instructions/model from bundler-generated src/generated/agent.json.
backend-b/   Flue+CF Worker — the MULTI-AGENT backend: one generic `main` Flue agent;
             the agent bundle POSTed per session decides instructions, model, skills.
             First-turn identity rides the creating send's `initialData` (see plan §6).
frontend/    React + Vite — one chat, New-session button, A/B backend dropdown, and an
             agent dropdown when B is selected (fed by the bundler output).
scripts/     bundle.mjs (agent bundler CLI) · node-smoke.mjs (portability, zero
             Cloudflare) · acceptance.mjs (C1–C5) · admin.test.mjs ·
             chat-probe.mjs (one real LLM turn against a deployed backend —
             the observability verification driver).
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

Artifacts per run: `dist-bundle/<name>.agent.json` (canonical, used by acceptance and the
GitHub-channel seed), `frontend/src/generated/agents/<name>.json` (glob-imported by the UI —
a NEW agents/ folder shows up in the frontend agent dropdown after re-running `pnpm bundle`,
no code change), and `backend-a/src/generated/agent.json` (meta-only build input for A's
fixed agent). Limits: ≤16 skills, ≤64 files & ≤1 MiB per skill, ≤4 MiB per agent,
instructions ≤64 KiB (`core/src/agent.js`). Zero-skill agents (no `skills/` folder) are
valid — nothing is provisioned, the bundle still carries instructions/model.

## Skill delivery to the model (backend B)

Skill delivery has TWO legs on backend B, and both are required:

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
caches the catalog for the conversation. On B, fully provisioned sessions still
composed system prompts with an EMPTY catalog (verified 2026-07-23 on the
2.x nightly: the Braintrust-logged system prompt had no skills section while the
deterministic skill-check proved the same container held all 70 files, and the SDK
`exists()` probe — surfaced as `sdkExists` in the skill-check response — returned
true when tested moments later). Backend A never hits this because its skills are
baked into the image and exist at container boot; the pre-nightly "activate_skill →
read → bash" A/B result in Verified results predates this regression. Catalog
descriptions are truncated to 1024 chars (Flue's SkillDefinition cap). When
workspace discovery does find the disk copy, the discovered skill wins the
name-merge over the mounted definition — same content either way. That
discovered-wins merge is restored by our `@flue/runtime` patch (see
Prerequisites): the stock nightly THROWS on the name conflict instead, and
because the ingest pre-warm provisions the files before the first send,
discovery often does see them — every submission of such a session then
failed with a generic `internal_error` (root-caused via `wrangler tail`
2026-07-26; backend B was undriveable until the patch).

Observability: both backends log every llm span to Braintrust (exact system
prompt in span metadata `flue.system_prompt`, messages as the span input) and
export OTel GenAI traces to Arize AX. Check there first when the model behaves
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

pnpm dev:frontend      # http://localhost:5173  (talks to localhost:3583/3584 in dev)
```

## Deploy

```bash
pnpm deploy            # bundle + deploy A + B + frontend, in order
pnpm deploy:agents     # bundle + deploy:frontend — ships agents/ content changes to
                       # backend B (bundles ride the frontend build; B's worker is the
                       # generic host and needs no redeploy). NEW sessions only; if
                       # hoth-trip-planner changed, backend A needs deploy:a too, and the
                       # GitHub channel's agent:github-default KV key its manual re-upload.
# or individually:
pnpm deploy:a          # vite build + wrangler deploy backend A (creates its container app)
pnpm deploy:b          # vite build + wrangler deploy backend B
pnpm deploy:frontend   # vite build (URLs from frontend/.env.production) + wrangler deploy
```

First deploy of each backend creates its Cloudflare Container application and prompts to
confirm. Backends need **Workers AI** and **Containers** enabled on the account. The frontend
build reads the two backend URLs from [`frontend/.env.production`](./frontend/.env.production).

## Authentication

Both backends are behind a shared **API-key guard** (`core/src/auth.js`): every route except
`/health` requires `Authorization: Bearer <API_TOKEN>`, and fails closed (503) if `API_TOKEN`
is unset. Set it as a Cloudflare secret per backend, and locally via `.dev.vars`:

```bash
node -e "console.log('hoth_'+require('crypto').randomBytes(24).toString('base64url'))" > .api-token
cd backend-a && printf 'API_TOKEN="%s"\n' "$(cat ../.api-token)" > .dev.vars   # local dev
wrangler secret put API_TOKEN --config backend-a/wrangler.jsonc                 # deployed (paste the value)
# repeat for backend-b
```

The **frontend never bakes the key in** — you type it into the API-key field on the page
(persisted to `localStorage`), and it rides every request: the FlueClient `token` option
(chat + SSE) and an explicit header on the session-setup fetches. This is a gate against
outside abuse, not per-tenant identity — real multi-tenant auth is the server-side
`verify token → tenant` from plan §9.6.

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
  the worker-wide `LLM_API_KEY` secret. Backend A applies its fixed agent's override at
  build time; backend B per session from the bundle.

## Egress (per-agent proxy_whitelist)

Egress from an agent's sandbox is governed by the agent's own `proxy_whitelist` in
`agent.jsonc` — an array of host globs (`"www.semantius.com"` exact, `"*.semantius.ai"`
subdomains only). **Deny-all when absent**: an agent without the property (or with an
empty list) can make no outbound request at all. There is no global whitelist anymore.
The list rides the agent bundle as `proxyWhitelist`; backend B maps it to the session's
container in KV at ingest (`whitelist:<containerId>`, self-healed by the agent
initializer — a deleted session stays deny-all) and both outbound handlers in
`src/cloudflare.ts` resolve it per invocation. Backend A bakes its fixed agent's list at
build time from the generated meta. The sentinel→key swap (`brokerEgress`) and the echo
bearer injection both sit behind this gate; a request to a non-whitelisted host is
rejected with 403 even when it carries the credential sentinel.

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
calls the echo host over 443 and the bearer rides inside TLS.

**Session substrate expires after 24 h (fail-closed by design):** the stored agent
bundle, bearer, and whitelist mappings all carry a 24 h TTL, and chat-session bearers
are never re-minted (plan §13 C5). A chat session older than that loses egress and — on
a cold container — its skills; start a new session.

## Data browser

The frontend **Data** tab navigates all Cloudflare-stored data as a generic
collection → record → detail tree, backed by the read-only `/admin/collections` routes on
both backends (behind the API-key guard; host-agnostic logic in `core/src/admin.js`, tests
in `scripts/admin.test.mjs`, `pnpm test`).

Non-obvious constraint: Cloudflare cannot list Durable Object instances, so conversations
are enumerable only via the `session:<id>` KV records each backend writes at
provision/ingest (`putSessionIndex`) — sessions created before that index existed don't
appear. Conversation *content* is streamed by the frontend via the Flue conversation
client, not an admin endpoint.

Token/cost usage in the Raw JSON view: Flue v2 dropped the beta's per-message
`metadata.usage` from the conversation read, so both agents re-attach it via
`useResponseFinish` (one aggregate per response, openrouter specifiers only — which
includes catalog-known model overrides, since `llm.ts` keeps their `openrouter/...`
specifier; the placeholder/custom catalogs register zero rates and would report $0).
`cost.total` is OpenRouter's **billed** amount: the `@earendil-works/pi-ai` patch (see
Prerequisites) requests usage accounting (`usage: { include: true }`, OpenRouter-only)
and prefers the inline `usage.cost` from the last SSE chunk over the catalog estimate.
Component costs (input/output/cache) remain pi-ai's model-catalog computation —
OpenRouter reports only the total — so components may not sum exactly to the total.

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
- GitHub conversations load the trip-planner agent bundle from the no-TTL KV entry
  `agent:github-default`, uploaded manually (from `backend-b/`):
  `wrangler kv key put agent:github-default --path ../dist-bundle/hoth-trip-planner.agent.json --binding STORE --remote`
  — re-upload after re-running `pnpm bundle` (and after this refactor: the old
  `bundle:github-default` key is dead). The agent initializer mints the egress bearer
  itself (tenantTag `github`) since these conversations never pass the ingest route.
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

Verify: `node scripts/chat-probe.mjs a` (or `b`), then open the Arize space →
project `hoth-poc` → the session should appear with the full
invoke_agent → chat → execute_tool tree. Export failures surface as
`arize: OTLP export …` warnings in `wrangler tail`. A direct probe of the
endpoint from Node (same serializer + headers) returned 200 on 2026-07-26.

## Acceptance

```bash
API_TOKEN=$(cat .api-token) node scripts/acceptance.mjs        # default deployed URLs
API_TOKEN=... A_URL=... B_URL=... node scripts/acceptance.mjs
```

Drives the **deterministic core** (the bounded `/sessions/:id/skill-check` route) so the A/B
comparison is isolated from LLM nondeterminism. Covers: auth (401 without/with wrong key),
C1 (A is OOTB/static, no agent ingest), C2 (B per-session bearers + tenant tags), C3 (single
source of truth — A image == bundle == B reconstructed, byte-identical), C4 (same result A
vs B — `opening-times.js` stdout byte-for-byte, plus the injected bearer reaching the echo
upstream while the container sends none), C5 (uniqueness guard + fail-closed egress), plus
clean-base, zero-skill-agent, per-agent-egress deny-all, and hostile-bundle checks.

## Verified results

All 30 acceptance checks pass against the deployed Workers, and both backends drive the LLM
end-to-end with the identical `activate_skill → read → bash` sequence and matching opening
times. Two wiring findings and the egress HTTP-vs-HTTPS caveat are recorded in
[`hoth-poc-plan.md`](./hoth-poc-plan.md) §7.

## The `/sessions/:id/skill-check` route

A **bounded** test affordance (behind the API-key guard): it runs one of a fixed set of
deterministic commands (`opening-times`, `hash-skill`, `count-skill-files`, `curl-check`,
`semantius-whoami`) built server-side from strictly validated structured params — **not**
arbitrary shell. It exists to drive the acceptance oracle; it is not a product route.
