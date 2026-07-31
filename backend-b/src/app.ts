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
 *      follows at egress,
 *  (d) pre-warms: eagerly boots the container and reconstructs the skills so
 *      the 1-3 s cold boot overlaps the user typing (plan §15 P1).
 *
 * The route STORES the snapshot — reconstruction also lives in the
 * initializer, which self-heals every cold container. A snapshot is immutable
 * per id (plan §6/§13 C5), which minted ids give by construction: every create
 * is a fresh id, so nothing can be overwritten.
 */
import './braintrust';
import './otel';
import { getSandbox } from '@cloudflare/sandbox';
import { createAgentRouter } from '@flue/runtime/routing';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { Main } from './agents/main';
import {
  apiKeyGuard,
  BundleValidationError,
  buildSkillCheckCommand,
  ECHO_HOST,
  SkillCheckError,
  isValidSessionId,
  mintSessionId,
  sessionIdTail,
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
  STREAM_PROTOCOL_HEADERS,
  COST_BASIS,
  CONTAINER_RATES,
  utcDayWindow,
} from '@hoth/core';
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
};

/** What `userTokenGuard` puts on the context once it has verified the bearer. */
type SemantiusUser = {
  org: string;
  jwt: string;
  user: { org: string; sub: string; email?: string; name?: string };
};

const BUNDLE_TTL_SECONDS = 24 * 60 * 60;

const app = new Hono<{ Bindings: Env; Variables: { semantiusUser: SemantiusUser } }>();

// exposeHeaders: without it the browser can't read the durable-streams cursor
// headers (Stream-Up-To-Date / Stream-Next-Offset), so the conversation client
// busy-polls catch-up reads forever. See STREAM_PROTOCOL_HEADERS.
app.use('*', cors({ exposeHeaders: STREAM_PROTOCOL_HEADERS }));

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

// The per-session container-cost SNAPSHOT (`session_sandbox`), which HothSandbox
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
  return c.json(await sandboxRpc(() => getSandbox(c.env.Sandbox, id).snapshotStatus()));
});
app.post('/admin/sessions/:id/sandbox', async (c) => {
  const id = c.req.param('id');
  if (!isValidSessionId(id)) return c.json({ error: 'invalid session id' }, 400);
  // ?in=<seconds> arms the SCHEDULED path with a short fuse instead of running
  // inline — the only way to exercise schedule() -> alarm() -> callback without
  // waiting out the production timings.
  const armIn = Number(c.req.query('in'));
  if (Number.isFinite(armIn) && armIn > 0) {
    return c.json(await sandboxRpc(() => getSandbox(c.env.Sandbox, id).armSnapshot(Math.min(armIn, 3600))));
  }
  return c.json(await sandboxRpc(() => getSandbox(c.env.Sandbox, id).snapshotNow()));
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

// --- USER SURFACE (the caller's own Semantius token) ----------------------
// Creating a session is the user's own act, done from their browser, so it
// takes the user bearer — not the admin key. The token also supplies the org
// and the JWT the sandbox will act with, so nothing credential-shaped needs to
// travel in the body any more.
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
  // verified bearer, never from the body: `user` is what the chat gate matches
  // every later request against (so only this user can open this session), and
  // the BARE jwt beside an explicit org is what egress injects into the
  // sandbox's Semantius calls. `semantius_org` / `semantius_user` are the
  // token's org and its `sub` — WHICH tenant this session acts on and AS WHOM,
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
  const containerId = namespace.idFromName(id).toString();

  // Per-session credentials for downstream services, keyed by host glob. The
  // sandbox is given NOTHING — not the value, not a placeholder — and the
  // outbound handler adds the header on the way out (core/src/egress.js).
  // The POC's only entry is the fictional Hoth Tourism API (the echo host):
  // there is no vault here, so ingest mints a per-session stand-in for what
  // production would store as a secret REFERENCE. Add a host glob here to give
  // a session another downstream credential — no code change at egress.
  // The session user's Semantius JWT is deliberately NOT in this map: it is
  // also the token the backend authenticates the user with, so it lives with
  // the identity in session_context (see the identity comment above).
  // Tagged with the HEAD OF THE RANDOM TAIL (`sessionIdTail`), not a slice of
  // the whole id: the id's head is now the tenant prefix, identical for every
  // session of one user, and the id's end is a suffix nobody can match against
  // a full session id. This is the git-style short form, so a tag seen in an
  // echo dump prefix-matches the session it belongs to.
  const egressSecrets = { [ECHO_HOST]: `hoth-tourism-key-${sessionIdTail(id).slice(0, 8)}-${crypto.randomUUID()}` };
  await c.env.STORE.put(`agent:${id}`, raw, { expirationTtl: BUNDLE_TTL_SECONDS });
  // THE session record — the single mutable per-session document: browse
  // meta, the egress fields (egress_secrets/whitelist, read by the outbound
  // proxy via the container pointer), and the opaque client session_context (consumed
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
    egress_secrets: egressSecrets,
    whitelist: bundle.proxyWhitelist ?? [],
    session_context: sessionContext,
  });
  await putContainerPointer(c.env.STORE, containerId, id);

  // Pre-warm + eager reconstruction (plan §8/§15 P1). The initializer will
  // find the dirs present and no-op; on a later cold container it re-creates.
  const sandbox = getSandbox(namespace, id);
  await provisionAgentSkills(sandbox, bundle);
  // Point the sandbox's semantius CLI at THIS user's org, with the sentinel
  // standing in for their JWT (swapped at egress). Same self-healing shape as
  // the skills: re-applied by the agent's start callback on a cold container.
  await provisionSemantiusEnv(sandbox, org);

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
// this replays EXACTLY the agent initializer's cold-container path — read
// stored bundle, absent→write reconstruction — so cold-recovery is testable
// without an LLM turn. Admin surface: it execs in the container, so it takes
// the deployment key, never a user token.
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
  const sandbox = getSandbox(namespace, id);
  let reconstructed = false;
  if (raw) {
    const bundle = validateAgentBundle(raw);
    reconstructed = (await provisionAgentSkills(sandbox, bundle)).reconstructed;
    // Mirror the initializer's egress-policy self-heal so the check exercises
    // the same policy a real turn would (deny-all stays deny-all: []; no
    // bearer is ever minted here, matching the old whitelist-only heal).
    await ensureEgressPolicy(c.env.STORE, namespace.idFromName(id).toString(), id, {
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
  const containerId = c.env.Sandbox.idFromName(id).toString();
  // Pointer first: egress fails closed immediately, even if a later delete fails.
  await removeContainerPointer(c.env.STORE, containerId);
  await c.env.STORE.delete(`agent:${id}`);
  await removeSessionIndex(c.env.STORE, id);
  return c.json({ ok: true });
});

// Ownership gate for the chat surface. `userTokenGuard` (registered with it
// below) has already verified the bearer on THIS request; what is left is to
// prove the conversation belongs to that user:
//   - no session record, or one without a `session_context.user` -> 401;
//   - a record owned by somebody else -> 403. Without this check any holder of
//     a valid token of their own could open a stranger's conversation just by
//     knowing its id.
//
// A successful request also refreshes `session_context.semantius_jwt` whenever
// the presented token differs from the stored one — that field is what egress
// injects into the sandbox's Semantius calls, so this is how a long
// conversation's sandbox credential stays live (tokens last ~1 h, sessions
// 24 h). Write-on-change only.
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
