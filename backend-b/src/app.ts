/**
 * Backend B HTTP app — the multi-agent named-definition surface (plan §6/§8).
 *
 * TWO AUTH SURFACES, never mixed (core/src/auth.js):
 *
 *   admin / CLI  `Authorization: Bearer <API_TOKEN>` — the shared deployment
 *                secret. PUT /agents/:name, /admin/*, /sessions/:id/skill-check,
 *                DELETE /sessions/:id. Machine-to-machine only; no browser user
 *                should ever hold this key.
 *   user chat    `Authorization: Bearer <org>:<jwt>` — the caller's own
 *                Semantius token, verified per request against their org's
 *                userinfo endpoint. POST /sessions/agent and /agents/main/*,
 *                and nothing else: a chat client can create a session and use
 *                sessions it owns, but cannot read stored data or deploy
 *                anything.
 *
 * /health is public. The GitHub webhook authenticates itself by signature and
 * sits outside both guards.
 *
 * PUT /agents/:name (the `pnpm deploy:agent <name>` target):
 *  validates the untrusted agent bundle and persists it as the named
 *  definition `agentdef:<name>` — no TTL, overwritten on every deploy. The KV
 *  key name is authoritative; bundle.agentName is informative (a `--as` alias
 *  deploy may deliberately diverge).
 *
 * POST /sessions/agent (body: { agentName, sessionContext? }) -> { sessionId }:
 *  (0) takes the caller's verified identity from the user guard and pins it to
 *      the session as `session_context.user` / `semantius_org` /
 *      `semantius_user` — `user` is what the chat gate below matches every
 *      later request against, so a session can only ever be opened by the user
 *      who created it, and the org/sub pair is the tenant + principal the
 *      sandbox acts as. NOTHING tenant-shaped is taken from the body,
 *  (0b) MINTS the session id from that identity — `<org>-<sub>-<32 hex>`, so
 *      the tenant is visible in `session:<id>` / `agent:<id>` without opening a
 *      record (mintSessionId, core/src/config.js). The route takes no id: a
 *      client-supplied one would make the prefix a claim rather than a fact,
 *  (a) resolves the named definition from KV (404 when not deployed),
 *  (b) snapshots it keyed by session id (read back by the agent initializer),
 *      so in-flight sessions are pinned even when the definition is redeployed,
 *  (c) mints the session's `egress_secrets` (host glob -> downstream
 *      credential the sandbox never holds) and writes THE session record
 *      (`session:<id>`: meta + egress_secrets/whitelist + optional `sessionContext` —
 *      e.g. semantius_jwt, injected at egress, never delivered to the agent)
 *      plus the `container:<containerId>` pointer the outbound handler
 *      follows at egress.
 *
 * The route ONLY stores: it never touches the container. The container boots
 * lazily at the first sandbox operation that genuinely needs it (the agent's
 * lazy SessionEnv wrapper provisions-then-forwards; see agents/main.ts and
 * src/lazy-env.ts) — the old eager pre-warm (plan §15 P1) is gone
 * because sessions are now created at first-message time, so there is no
 * typing window left to overlap the boot with. A snapshot is immutable per id
 * (plan §6/§13 C5), which minted ids give by construction: every create is a
 * fresh id, so nothing can be overwritten.
 */
import './braintrust';
import './otel';
import { getSandbox } from '@cloudflare/sandbox';
import { createAgentRouter } from '@flue/runtime/routing';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { csrf } from 'hono/csrf';
import { Main } from './agents/main';
import {
  apiKeyGuard,
  BundleValidationError,
  buildSkillCheckCommand,
  SkillCheckError,
  isValidSessionId,
  listSessions,
  mintSessionId,
  sandboxNameForSession,
  sessionTenantPrefix,
  mergeSessionRecord,
  readSession,
  removeSessionIndex,
  userTokenGuard,
  adminCollections,
  listCollectionRecords,
  readCollectionRecord,
  provisionAgentSkills,
  provisionSemantiusEnv,
  SKILLS_DIR,
  putContainerPointer,
  removeContainerPointer,
  ensureEgressPolicy,
  SESSION_CONTEXT_MAX_BYTES,
  resolveSandboxBinding,
  validateAgentBundle,
  AGENT_DEF_KEY_PREFIX,
  SKILL_NAME_RE,
  skillCatalogFromBundle,
  STREAM_PROTOCOL_HEADERS,
  COST_BASIS,
  CONTAINER_RATES,
  utcDayWindow,
} from '@semantius-copilot/core';
import { channel } from './channels/github';
import { fetchContainerCosts } from './costs';

type Env = {
  Sandbox: DurableObjectNamespace;
  STORE: KVNamespace;
  API_TOKEN: string;
  /** Cloudflare account tag — a var (not a secret); needed to query analytics. */
  CLOUDFLARE_ACCOUNT_ID?: string;
  /** Analytics-read token for GET /admin/costs. Secret; absent = costs disabled. */
  CLOUDFLARE_API_TOKEN?: string;
  /**
   * Server-to-server key for POST /session/token — trades a better-auth session
   * cookie for the Semantius JWT the sandbox acts with. Secret; absent = the
   * cookie half of the chat gate answers 503 (bearers keep working).
   */
  JWT_EXCHANGE_API_KEY?: string;
  /** Host serving /session and /session/token. A var; defaults to api.semantius.cloud. */
  SEMANTIUS_SESSION_BASE_URL?: string;
  /**
   * Comma-separated exact origins allowed to make CREDENTIALED browser calls
   * (the frontend Worker, plus any app embedding the chat same-site). A var;
   * unset/empty = no browser origin is allowed. Non-browser callers (deploy
   * scripts, curl, the GitHub webhook) send no Origin header and are never
   * affected.
   */
  ALLOWED_ORIGINS?: string;
};

/** What `userTokenGuard` puts on the context once it has verified the bearer. */
type SemantiusUser = {
  org: string;
  jwt: string;
  user: { org: string; sub: string; email?: string; name?: string };
};

const BUNDLE_TTL_SECONDS = 24 * 60 * 60;

const app = new Hono<{ Bindings: Env; Variables: { semantiusUser: SemantiusUser } }>();

/** The ALLOWED_ORIGINS var, parsed. Shared by the CORS echo and the CSRF
 * origin check below, so the two can never disagree. */
const allowedOrigins = (env: Env): string[] =>
  (env.ALLOWED_ORIGINS ?? '').split(',').map((o) => o.trim()).filter(Boolean);

// CORS is CREDENTIALED (ambient-cookie chat: the browser attaches its own
// better-auth cookie to `credentials: 'include'` requests), which forbids the
// old wildcard: browsers reject `*` with credentials, and echoing arbitrary
// origins would let any website make cookie-authenticated calls. So the
// origin is echoed only off the ALLOWED_ORIGINS allowlist — function form,
// because `c.env` does not exist at module scope. Falsy return = no CORS
// headers at all.
// exposeHeaders: without it the browser can't read the durable-streams cursor
// headers (Stream-Up-To-Date / Stream-Next-Offset), so the conversation
// client busy-polls catch-up reads forever. See STREAM_PROTOCOL_HEADERS —
// an explicit list on purpose: `*` is ignored on credentialed responses.
app.use(
  '*',
  cors({
    origin: (origin, c) => (allowedOrigins(c.env as Env).includes(origin) ? origin : ''),
    credentials: true,
    exposeHeaders: STREAM_PROTOCOL_HEADERS,
  }),
);

// CSRF, scoped to EXACTLY the cookie-reachable unsafe-method surface: with
// ambient cookies on, a hostile page can fire a no-preflight form POST
// (text/plain) that CORS never inspects, and c.req.json() parses the body
// regardless of Content-Type. Hono's csrf middleware 403s unsafe-method
// requests whose Content-Type is form-like (missing counts as text/plain)
// unless the Origin is allowlisted — JSON requests (the SDK always sends
// application/json on body requests) are untouched, as is every
// Authorization-only admin/CLI route (a bare curl DELETE /sessions/:id has no
// Content-Type and would 403 under a wider scope — do not broaden this to
// /sessions/* or /agents/*).
// Known benign leftover: the ownership gate's write-on-change JWT refresh
// (further down) runs on GET, and CORS never stops a cross-site GET from
// EXECUTING server-side — it only refreshes the victim's own session record,
// so there is nothing for an attacker to gain.
const csrfGuard = csrf({ origin: (origin, c) => allowedOrigins(c.env as Env).includes(origin) });
app.use('/sessions/agent', csrfGuard);
app.use('/agents/main/*', csrfGuard);

// GitHub webhook (POST /channels/github/webhook). Mounted BEFORE the API
// key guard: GitHub can't send our bearer — the channel authenticates each
// delivery itself via X-Hub-Signature-256 over the raw body.
app.route('/channels/github', channel.route());

app.get('/health', (c) => c.json({ ok: true, backend: 'b', delivery: 'dynamic-bundle' }));

// --- ADMIN SURFACE (shared API key) --------------------------------------
// Applied per route, NOT as a wildcard: the chat surface below must not inherit
// it, or a chat client would need the deploy-capable key and the Authorization
// header would be occupied by something other than the user's own token.
app.use('/admin/*', apiKeyGuard());

// Read-only data browser (behind the API-key guard). Presents every backing
// store as a generic collection so the frontend is a plain entities -> records
// -> record tree. Never mutates. `deps` injects the KV binding into the
// host-agnostic core resolver. (Flue v2 removed the workflow-run registry, so
// KV and the session index are the only backing stores left.)
const adminDeps = (c: { env: Env }) => ({ kv: c.env.STORE });
app.get('/admin/collections', (c) => c.json({ backend: 'b', collections: adminCollections('STORE') }));
app.get('/admin/collections/:cid/records', async (c) => {
  const result = await listCollectionRecords(c.req.param('cid'), adminDeps(c));
  if (!result) return c.json({ error: 'unknown collection' }, 404);
  return c.json(result);
});
app.get('/admin/collections/:cid/record', async (c) => {
  const id = c.req.query('id');
  if (!id) return c.json({ error: 'id query param required' }, 400);
  const record = await readCollectionRecord(c.req.param('cid'), id, adminDeps(c));
  if (!record) return c.json({ error: 'not found' }, 404);
  return c.json(record);
});

// Today's Cloudflare CONTAINER spend, per session (src/costs.ts). Not a
// "collection": it is a live read-through to Cloudflare's analytics, not one of
// our backing stores, so it gets its own route rather than pretending to be
// browsable state. UTC day — the day Cloudflare bills on.
//
// Container cost ONLY. Worker and Durable Object usage carries no session-shaped
// dimension in Cloudflare's datasets, so attributing it per session would be a
// guess; we report what is measured (see core/src/cost.js).
app.get('/admin/costs', async (c) => {
  const window = utcDayWindow();
  let costs;
  try {
    costs = await fetchContainerCosts(c.env, window);
  } catch (err) {
    return c.json({ error: String(err instanceof Error ? err.message : err), ...window }, 502);
  }
  return c.json({ ...window, currency: 'USD', rates: CONTAINER_RATES, basis: COST_BASIS, ...costs });
});

// The per-session container-cost SNAPSHOT (`session_sandbox`), which SemantiusCopilotSandbox
// writes ~15 min after its container stops. That task runs on a fuse inside a
// Durable Object nobody is watching, so it needs a window:
//   GET  — did it run, what did it decide, is it still armed?
//   POST — take the snapshot now, skipping the settle delay.
// Both are plain RPC onto the sandbox DO; neither starts a container.
// A diagnostic route that hides the failure is worthless — these report the DO's
// own error text rather than letting Hono turn it into a bare 500.
const sandboxRpc = async (fn: () => Promise<unknown>) => {
  try {
    return { ok: true as const, result: await fn() };
  } catch (err) {
    return {
      ok: false as const,
      error: String(err instanceof Error ? err.message : err),
      stack: err instanceof Error ? err.stack?.split('\n').slice(0, 4).join('\n') : undefined,
    };
  }
};

app.get('/admin/sessions/:id/sandbox', async (c) => {
  const id = c.req.param('id');
  if (!isValidSessionId(id)) return c.json({ error: 'invalid session id' }, 400);
  return c.json(await sandboxRpc(() => getSandbox(c.env.Sandbox, sandboxNameForSession(id)).snapshotStatus()));
});
app.post('/admin/sessions/:id/sandbox', async (c) => {
  const id = c.req.param('id');
  if (!isValidSessionId(id)) return c.json({ error: 'invalid session id' }, 400);
  // ?in=<seconds> arms the SCHEDULED path with a short fuse instead of running
  // inline — the only way to exercise schedule() -> alarm() -> callback without
  // waiting out the production timings.
  const armIn = Number(c.req.query('in'));
  if (Number.isFinite(armIn) && armIn > 0) {
    return c.json(
      await sandboxRpc(() => getSandbox(c.env.Sandbox, sandboxNameForSession(id)).armSnapshot(Math.min(armIn, 3600))),
    );
  }
  return c.json(await sandboxRpc(() => getSandbox(c.env.Sandbox, sandboxNameForSession(id)).snapshotNow()));
});

// Admin read of the SAME conversations the chat surface serves, mounted under
// /admin/* so it inherits the API-key guard above. The data browser exists to
// show everything the backend persists, and a conversation is persisted state
// (the agent Durable Object's SQLite stream) — so the operator can read it,
// while `/agents/main/*` below stays the user's own token-authenticated
// surface. Two mounts of one router, one per credential.
//
// Read-only, enforced here rather than by convention: the browser never
// mutates, and an operator must not be able to speak as a user.
app.use('/admin/agents/main/*', async (c, next) => {
  if (c.req.method !== 'GET') {
    return c.json({ error: 'admin conversation access is read-only' }, 405);
  }
  return next();
});
app.route('/admin/agents/main', createAgentRouter(Main));

// Named-definition deploy target (`pnpm deploy:agent <name>`). Body is the raw
// bundle JSON (not `{bundle}`-wrapped) — validated at this trust boundary,
// then stored byte-exact under `agentdef:<name>` with NO TTL; every deploy
// overwrites. No bundle.agentName === :name check: the KV key is what sessions
// resolve, and a `--as` alias deploy may deliberately diverge. Path-safe next
// to the /agents/main mount below: `:name` matches a single segment only.
app.put('/agents/:name', apiKeyGuard(), async (c) => {
  const name = c.req.param('name');
  if (!SKILL_NAME_RE.test(name) || name.length > 64) {
    return c.json({ error: 'invalid agent name (lowercase alphanumerics/hyphens, max 64)' }, 400);
  }
  const text = await c.req.text();
  let bundle;
  try {
    bundle = validateAgentBundle(text);
  } catch (err) {
    if (err instanceof BundleValidationError || err instanceof SyntaxError) {
      return c.json({ error: String(err instanceof Error ? err.message : err) }, 422);
    }
    throw err;
  }
  await c.env.STORE.put(`${AGENT_DEF_KEY_PREFIX}${name}`, text);
  return c.json({
    ok: true,
    name,
    agentName: bundle.agentName,
    version: bundle.version,
    skills: Object.keys(bundle.skills),
    bytes: text.length,
  });
});

// --- USER SURFACE (the caller's own Semantius credential) -----------------
// Creating a session is the user's own act, done from their browser, so it
// takes the user's own credential — not the admin key. Either a Semantius
// bearer (`<org>:<jwt>`) or a better-auth session cookie: the guard resolves
// both to one verdict, which supplies the org and the JWT the sandbox will act
// with, so nothing credential-shaped needs to travel in the body any more.

// The deployed-agent index: every `agentdef:<name>` key, names only. This is
// what the chat pages' agent dropdown lists at RUNTIME — agents deploy to KV
// independently of any frontend build, so the UI asks the registry instead of
// baking a list in. User guard, not admin: listing which agents exist is part
// of the chat surface, but not something for the unauthenticated.
app.get('/agents', userTokenGuard(), async (c) => {
  const names: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await c.env.STORE.list({ prefix: AGENT_DEF_KEY_PREFIX, cursor });
    for (const key of page.keys) names.push(key.name.slice(AGENT_DEF_KEY_PREFIX.length));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return c.json({ agents: names.sort() });
});

// One agent's live definition meta: existence, the welcome card, and the
// turn-1 seed (instructions, model, skillCatalog) — read from `agentdef:
// <name>` on every call, so what the chat seeds a new session with can never
// skew from the definition the session create snapshots. Skill FILES are
// deliberately not returned — the UI needs the catalog, not the contents.
// Path-safe next to the /agents/main mount: `main` is a static segment, so
// Hono routes /agents/main/* to the conversation router, never here.
app.get('/agents/:name/meta', userTokenGuard(), async (c) => {
  const name = c.req.param('name');
  if (!SKILL_NAME_RE.test(name) || name.length > 64) {
    return c.json({ error: 'invalid agent name (lowercase alphanumerics/hyphens, max 64)' }, 400);
  }
  const raw = await c.env.STORE.get(`${AGENT_DEF_KEY_PREFIX}${name}`);
  if (!raw) {
    return c.json({ error: `unknown agent "${name}" — deploy it with pnpm deploy:agent ${name}` }, 404);
  }
  // Re-validate on read (defense in depth, same as session create).
  const bundle = validateAgentBundle(raw);
  const skillCatalog = skillCatalogFromBundle(bundle);
  return c.json({
    agentName: bundle.agentName,
    version: bundle.version,
    baseImage: bundle.baseImage,
    instructions: bundle.instructions,
    ...(bundle.model ? { model: bundle.model } : {}),
    ...(bundle.modelBaseUrl ? { modelBaseUrl: bundle.modelBaseUrl } : {}),
    ...(skillCatalog.length > 0 ? { skillCatalog } : {}),
    ...(bundle.welcome ? { welcome: bundle.welcome } : {}),
  });
});

// The caller's own session index — every session whose id carries THIS user's
// tenant prefix (`session:<org>-<sub>-…`; sessionTenantPrefix is "the unit of
// tenant-scoped KV listing", core/src/config.js). The prefix only narrows the
// KV read; it is NOT the access decision: ownership is re-checked per record
// against `session_context.user`, exactly like the chat gate below — the
// prefix is efficiency plumbing, never authorization (README "Session ids").
// The response whitelists fields: THE session record also carries
// egress_secrets and session_context.semantius_jwt, and neither may ever
// reach a browser. Newest-first (listSessions sorts by createdAt); the 24 h
// record TTL makes this inherently "recent sessions" — the same horizon the
// chat surface can actually reopen.
// `user` echoes WHOSE sessions these are (same shape as the session-create
// response): a browser can hold several credentials, and an empty list is
// indistinguishable from "listed as somebody else" unless the answer names
// the identity it was scoped to.
app.get('/sessions', userTokenGuard(), async (c) => {
  const verified = c.get('semantiusUser');
  const records = await listSessions(c.env.STORE, sessionTenantPrefix(verified.org, verified.user.sub));
  const sessions = records
    .filter((r) => {
      const owner = ((r.session_context ?? {}) as Record<string, unknown>).user as
        | { sub?: unknown; org?: unknown }
        | undefined;
      return owner?.sub === verified.user.sub && owner?.org === verified.user.org;
    })
    .map((r) => ({
      id: String(r.id),
      ...(typeof r.agentName === 'string' ? { agentName: r.agentName } : {}),
      ...(typeof r.version === 'string' ? { version: r.version } : {}),
      ...(typeof r.createdAt === 'string' ? { createdAt: r.createdAt } : {}),
      ...(typeof r.title === 'string' ? { title: r.title } : {}),
    }));
  return c.json({ sessions, user: verified.user });
});

app.post('/sessions/agent', userTokenGuard(), async (c) => {
  let agentName: string;
  let sessionContext: Record<string, unknown> | undefined;
  try {
    const body = (await c.req.json()) as { agentName?: unknown; sessionContext?: unknown };
    if (typeof body.agentName !== 'string' || !SKILL_NAME_RE.test(body.agentName) || body.agentName.length > 64) {
      return c.json(
        { error: 'agentName required — deploy the bundle with pnpm deploy:agent <name>, then submit its name' },
        422,
      );
    }
    agentName = body.agentName;
    // Opaque infra-only session context (plan: session_context). Stored per
    // container for the egress handler; NEVER delivered to the agent/model.
    if (body.sessionContext !== undefined) {
      if (typeof body.sessionContext !== 'object' || body.sessionContext === null || Array.isArray(body.sessionContext)) {
        return c.json({ error: 'sessionContext must be a plain JSON object' }, 422);
      }
      const bytes = new TextEncoder().encode(JSON.stringify(body.sessionContext)).length;
      if (bytes > SESSION_CONTEXT_MAX_BYTES) {
        return c.json({ error: `sessionContext too large (${bytes} > ${SESSION_CONTEXT_MAX_BYTES} bytes)` }, 422);
      }
      sessionContext = body.sessionContext as Record<string, unknown>;
    }
  } catch (err) {
    if (err instanceof SyntaxError) {
      return c.json({ error: String(err.message) }, 422);
    }
    throw err;
  }

  // The session's owner and its Semantius credential both come from the
  // verified credential, never from the body: `user` is what the chat gate
  // matches every later request against (so only this user can open this
  // session), and the BARE jwt beside an explicit org is what egress injects
  // into the sandbox's Semantius calls. On the cookie path that jwt is the one
  // /session/token minted, which is exactly why the exchange happens at all —
  // a cookie is useless to the sandbox. `semantius_org` / `semantius_user` are
  // the verdict's org and its `sub` — WHICH tenant this session acts on and AS WHOM,
  // in the same naming as the CLI env pair, so nothing about the tenant is ever
  // invented locally. Reserved keys are stripped from whatever the client sent,
  // so no caller can hand itself an identity.
  const { org, jwt, user } = c.get('semantiusUser');
  const {
    user: _u,
    semantius_jwt: _j,
    semantius_org: _o,
    semantius_user: _s,
    ...clientContext
  } = sessionContext ?? {};
  sessionContext = { ...clientContext, user, semantius_jwt: jwt, semantius_org: org, semantius_user: user.sub };

  // The id is MINTED HERE, from the identity just verified — `<org>-<sub>-<32
  // hex>` (core/src/config.js). The client no longer supplies one: it used to
  // generate the whole id in the browser, which made the tenant prefix
  // unfalsifiable only if the server checked it, and made "server-minted,
  // globally unique, never reused" (plan §6) a promise nobody enforced.
  const id = mintSessionId(org, user.sub);

  // Collision assert, not a client-reachable path: the tail is 122 random bits,
  // so a hit means the generator is broken. Kept because a bundle is immutable
  // per id (plan §6/§13 C5) — silently overwriting one would hand two sessions
  // the same container.
  if (await c.env.STORE.get(`agent:${id}`)) {
    return c.json({ error: 'minted session id collided with a live session' }, 409);
  }

  // Resolve the named definition. Re-validate on read (defense in depth, same
  // as the skill-check route) and snapshot the exact stored bytes per session.
  const raw = await c.env.STORE.get(`${AGENT_DEF_KEY_PREFIX}${agentName}`);
  if (!raw) {
    return c.json({ error: `unknown agent "${agentName}" — deploy it with pnpm deploy:agent ${agentName}` }, 404);
  }
  const bundle = validateAgentBundle(raw);

  // Select the Sandbox binding from the bundle's baseImage; BOTH getSandbox
  // and the bearer KV key must derive from this same binding (plan §7/§16).
  const binding = resolveSandboxBinding(bundle.baseImage);
  const namespace = (c.env as unknown as Record<string, DurableObjectNamespace>)[binding];
  // Container identity drops the USER segment: name = `<org>-<tail>`
  // (sandboxNameForSession) — the only place the 63-char DNS ceiling binds.
  const containerId = namespace.idFromName(sandboxNameForSession(id)).toString();

  // TODO(secret-retrieval): downstream credentials (`egress_secrets`, a map of
  // host glob -> credential consumed by core/src/egress.js) are NOT written
  // here. The server must never generate or hardcode a secret value — this is
  // where retrieval logic plugs in: resolve the tenant's secret REFERENCES
  // (vault / secrets store) and put the resolved entries on the session
  // record. Until that exists the map stays absent and every
  // credential-required host fails closed at egress (403, injectAndForward).
  // The session user's Semantius JWT is deliberately NOT part of that map: it
  // is also the token the backend authenticates the user with, so it lives
  // with the identity in session_context (see the identity comment above).
  await c.env.STORE.put(`agent:${id}`, raw, { expirationTtl: BUNDLE_TTL_SECONDS });
  // THE session record — the single mutable per-session document: browse
  // meta, the egress fields (whitelist, and egress_secrets once retrieval
  // logic populates it — read by the outbound proxy via the container
  // pointer), and the opaque client session_context (consumed
  // at egress only, never delivered to the agent; it cannot be self-healed,
  // so TTL expiry fails soft to the sentinel-swap behavior). No
  // proxy_whitelist in the agent -> [] -> deny all. containerId is NOT
  // stored — it is derivable via idFromName wherever needed. The agent later
  // merges payload/session_data/session_state into this same record.
  // No `skills` on the record (derivable from agentdef:<agentName>@version).
  // No tenant field beside session_context either: the tenant IS
  // session_context.semantius_org, so there is exactly one place to look.
  await mergeSessionRecord(c.env.STORE, id, {
    backend: 'b',
    agentName: bundle.agentName,
    version: bundle.version,
    containerId,
    createdAt: new Date().toISOString(),
    whitelist: bundle.proxyWhitelist ?? [],
    session_context: sessionContext,
  });
  await putContainerPointer(c.env.STORE, containerId, id);

  // NO pre-warm: creation is storage-only. The container boots lazily at the
  // first sandbox operation that needs it (the agent's lazy SessionEnv
  // wrapper provisions skills + Semantius env then), so a session whose user
  // never exercises a skill never starts a container at all.

  // Deliberately minimal: no internals (skills, containerId, provisioning
  // outcome) — those live in the data browser and the /skill-check oracle.
  // agentName/version tell the caller which definition snapshot the session
  // got pinned to (definitions are redeployable, sessions are not).
  return c.json({
    ok: true,
    backend: 'b',
    sessionId: id,
    agentName: bundle.agentName,
    version: bundle.version,
    // Who the session belongs to (and whose tenant it acts on) — the only user
    // who will ever be able to open it.
    user,
  });
});

// Deterministic skill-check (plan §13): NOT arbitrary exec — the command is
// built server-side from a bounded op + validated params. Before running it
// this replays EXACTLY the lazy provisioning a real turn performs at its
// first container-needing op — read stored bundle, absent→write
// reconstruction, Semantius env — so cold-recovery is testable without an
// LLM turn. Admin surface: it execs in the container, so it takes the
// deployment key, never a user token.
app.post('/sessions/:id/skill-check', apiKeyGuard(), async (c) => {
  const id = c.req.param('id');
  if (!isValidSessionId(id)) return c.json({ error: 'invalid session id' }, 400);
  let command: string;
  try {
    command = buildSkillCheckCommand(await c.req.json<Record<string, unknown>>());
  } catch (err) {
    if (err instanceof SkillCheckError) return c.json({ error: err.message }, 422);
    throw err;
  }

  const raw = await c.env.STORE.get(`agent:${id}`);
  const binding = raw ? resolveSandboxBinding((JSON.parse(raw) as { baseImage: string }).baseImage) : 'Sandbox';
  const namespace = (c.env as unknown as Record<string, DurableObjectNamespace>)[binding];
  const sandbox = getSandbox(namespace, sandboxNameForSession(id));
  let reconstructed = false;
  if (raw) {
    const bundle = validateAgentBundle(raw);
    reconstructed = (await provisionAgentSkills(sandbox, bundle)).reconstructed;
    // Semantius-env heal, exactly like the lazy provisioning a real turn runs:
    // a cold container starts from the image's baked sentinel, so re-point the
    // CLI at THIS session's org before the check execs. Without this the
    // `semantius-env` op would only pass on containers some real turn already
    // provisioned — the check must be self-sufficient.
    const record = await readSession(c.env.STORE, id);
    const org = (record?.session_context as { semantius_org?: unknown } | undefined)?.semantius_org;
    await provisionSemantiusEnv(sandbox, typeof org === 'string' ? org : undefined);
    // Mirror the initializer's egress-policy self-heal so the check exercises
    // the same policy a real turn would (deny-all stays deny-all: []; no
    // bearer is ever minted here, matching the old whitelist-only heal).
    await ensureEgressPolicy(c.env.STORE, namespace.idFromName(sandboxNameForSession(id)).toString(), id, {
      whitelist: bundle.proxyWhitelist ?? [],
    });
  }

  // Diagnostic: Flue's cloudflare adapter gates skill discovery on the SDK's
  // exists() RPC (container-server /api/exists), while every find/stat-based
  // op here uses shell exec. Surfacing the RPC's answer for the skills dir
  // makes an empty skill catalog attributable when the files provably exist.
  let sdkExists: unknown;
  try {
    sdkExists = (await sandbox.exists(SKILLS_DIR)).exists;
  } catch (err) {
    sdkExists = `error: ${String(err)}`;
  }

  const result = await sandbox.exec(command, { cwd: '/workspace' });
  return c.json({ exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, reconstructed, sdkExists });
});

app.delete('/sessions/:id', apiKeyGuard(), async (c) => {
  const id = c.req.param('id');
  if (!isValidSessionId(id)) return c.json({ error: 'invalid session id' }, 400);
  const containerId = c.env.Sandbox.idFromName(sandboxNameForSession(id)).toString();
  // Pointer first: egress fails closed immediately, even if a later delete fails.
  await removeContainerPointer(c.env.STORE, containerId);
  await c.env.STORE.delete(`agent:${id}`);
  await removeSessionIndex(c.env.STORE, id);
  return c.json({ ok: true });
});

// Ownership gate for the chat surface. `userTokenGuard` (registered with it
// below) has already verified the caller's credential on THIS request —  a
// Semantius bearer or a better-auth session cookie, indistinguishable by the
// time it lands here; what is left is to prove the conversation belongs to that
// user:
//   - no session record, or one without a `session_context.user` -> 401;
//   - a record owned by somebody else -> 403. Without this check any holder of
//     a valid credential of their own could open a stranger's conversation just
//     by knowing its id.
//
// A successful request also refreshes `session_context.semantius_jwt` whenever
// the verified JWT differs from the stored one — that field is what egress
// injects into the sandbox's Semantius calls, so this is how a long
// conversation's sandbox credential stays live (tokens last ~1 h, sessions
// 24 h). Write-on-change only, which is also why the cookie path CACHES its
// exchanged JWT: a freshly minted token on every request would rewrite the
// record on every request.
//
// HTTP-only by construction: GitHub-issue conversations reach the same agent
// through in-process dispatch (channels/github.ts), never through this route,
// so webhook-driven sessions are unaffected by the gate.
app.use('/agents/main/*', userTokenGuard(), async (c, next) => {
  const verified = c.get('semantiusUser');

  // The mount serves /agents/main/:id and deeper protocol paths; the id is
  // always the third segment.
  const raw = new URL(c.req.url).pathname.split('/')[3] ?? '';
  let conversationId: string;
  try {
    conversationId = decodeURIComponent(raw);
  } catch {
    conversationId = raw;
  }
  const record = conversationId ? await readSession(c.env.STORE, conversationId) : null;
  const context = (record?.session_context ?? {}) as Record<string, unknown>;
  const owner = context.user as { sub?: unknown; org?: unknown } | undefined;
  if (!owner || typeof owner.sub !== 'string') {
    return c.json({ error: 'no such chat session — create it first, then open it by id' }, 401);
  }
  if (owner.sub !== verified.user.sub || owner.org !== verified.user.org) {
    return c.json({ error: 'this conversation belongs to a different Semantius user' }, 403);
  }

  // Keep the sandbox's credential fresh: egress injects whatever bare JWT sits
  // on the record, so a refreshed token has to land there. The org/sub pair is
  // re-stamped with it (identical by the ownership check above, but a refresh
  // must never leave the identity trio half-updated). Only on change.
  if (context.semantius_jwt !== verified.jwt) {
    await mergeSessionRecord(c.env.STORE, conversationId, {
      session_context: {
        ...context,
        semantius_jwt: verified.jwt,
        semantius_org: verified.org,
        semantius_user: verified.user.sub,
      },
    });
  }
  await next();
});

// Explicit v2 mount (no auto-router): serves POST/GET /agents/main/:id and
// the conversation stream. `main` is the generic multi-agent host — which
// agent a session runs comes from its stored bundle, not the route.
app.route('/agents/main', createAgentRouter(Main));

export default app;
