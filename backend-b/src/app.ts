/**
 * Backend B HTTP app — the multi-agent named-definition surface (plan §6/§8).
 *
 * PUT /agents/:name (the `pnpm deploy:agent <name>` target):
 *  validates the untrusted agent bundle and persists it as the named
 *  definition `agentdef:<name>` — no TTL, overwritten on every deploy. The KV
 *  key name is authoritative; bundle.agentName is informative (an alias like
 *  github-default deliberately diverges).
 *
 * POST /sessions/:id/agent (body: { agentName, tenantTag? }):
 *  (a) resolves the named definition from KV (404 when not deployed),
 *  (b) snapshots it keyed by session id (read back by the agent initializer),
 *      so in-flight sessions are pinned even when the definition is redeployed,
 *  (c) mints a per-session bearer + tenant tag and writes the
 *      KV[containerId] mapping the outbound handler resolves at egress,
 *  (d) pre-warms: eagerly boots the container and reconstructs the skills so
 *      the 1-3 s cold boot overlaps the user typing (plan §15 P1).
 *
 * The route STORES the snapshot — reconstruction also lives in the
 * initializer, which self-heals every cold container. A snapshot is immutable
 * per id: a reused id is rejected (plan §6/§13 C5).
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
  SkillCheckError,
  isValidSessionId,
  kvSecretBroker,
  putSessionIndex,
  removeSessionIndex,
  adminCollections,
  listCollectionRecords,
  readCollectionRecord,
  provisionAgentSkills,
  SKILLS_DIR,
  putEgressWhitelist,
  removeEgressWhitelist,
  resolveSandboxBinding,
  validateAgentBundle,
  AGENT_DEF_KEY_PREFIX,
  SKILL_NAME_RE,
  STREAM_PROTOCOL_HEADERS,
} from '@hoth/core';
import { channel } from './channels/github';

type Env = {
  Sandbox: DurableObjectNamespace;
  STORE: KVNamespace;
  API_TOKEN: string;
};

const BUNDLE_TTL_SECONDS = 24 * 60 * 60;

const app = new Hono<{ Bindings: Env }>();

// exposeHeaders: without it the browser can't read the durable-streams cursor
// headers (Stream-Up-To-Date / Stream-Next-Offset), so the conversation client
// busy-polls catch-up reads forever. See STREAM_PROTOCOL_HEADERS.
app.use('*', cors({ exposeHeaders: STREAM_PROTOCOL_HEADERS }));

// GitHub webhook (POST /channels/github/webhook). Mounted BEFORE the API
// key guard: GitHub can't send our bearer — the channel authenticates each
// delivery itself via X-Hub-Signature-256 over the raw body.
app.route('/channels/github', channel.route());

// Every route except /health requires Authorization: Bearer <API_TOKEN>.
// Fail-closed if API_TOKEN is unset (503). Covers the mounted agent
// conversation/stream routes too, since the guard runs before the
// createAgentRouter mount below.
app.use('*', apiKeyGuard());

app.get('/health', (c) => c.json({ ok: true, backend: 'b', delivery: 'dynamic-bundle' }));

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

// Named-definition deploy target (`pnpm deploy:agent <name>`). Body is the raw
// bundle JSON (not `{bundle}`-wrapped) — validated at this trust boundary,
// then stored byte-exact under `agentdef:<name>` with NO TTL; every deploy
// overwrites. No bundle.agentName === :name check: the KV key is what sessions
// resolve, and the github-default alias deliberately diverges. Path-safe next
// to the /agents/main mount below: `:name` matches a single segment only.
app.put('/agents/:name', async (c) => {
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

app.post('/sessions/:id/agent', async (c) => {
  const id = c.req.param('id');
  if (!isValidSessionId(id)) return c.json({ error: 'invalid session id' }, 400);

  // Session-id uniqueness guard: a bundle is immutable per id (plan §6).
  if (await c.env.STORE.get(`agent:${id}`)) {
    return c.json({ error: 'session id already has an agent bundle; a changed agent is a new session id' }, 409);
  }

  let agentName: string;
  let tenantTag: string;
  try {
    const body = (await c.req.json()) as { agentName?: unknown; tenantTag?: unknown };
    if (typeof body.agentName !== 'string' || !SKILL_NAME_RE.test(body.agentName) || body.agentName.length > 64) {
      return c.json(
        { error: 'agentName required — deploy the bundle with pnpm deploy:agent <name>, then submit its name' },
        422,
      );
    }
    agentName = body.agentName;
    tenantTag =
      typeof body.tenantTag === 'string' && /^[a-z0-9-]{1,64}$/.test(body.tenantTag)
        ? body.tenantTag
        : `tenant-${id.slice(0, 8)}`;
  } catch (err) {
    if (err instanceof SyntaxError) {
      return c.json({ error: String(err.message) }, 422);
    }
    throw err;
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

  const bearer = `hoth-b-bearer-${id.slice(0, 8)}-${crypto.randomUUID()}`;
  await c.env.STORE.put(`agent:${id}`, raw, { expirationTtl: BUNDLE_TTL_SECONDS });
  await kvSecretBroker(c.env.STORE).put(containerId, bearer, tenantTag);
  // Per-agent egress policy: map the bundle's proxy_whitelist to this
  // session's container. No proxy_whitelist in the agent -> [] -> deny all.
  await putEgressWhitelist(c.env.STORE, containerId, bundle.proxyWhitelist ?? []);

  // Index the session so the data browser can enumerate conversations without
  // knowing ids upfront (best-effort — never fail provisioning over the index).
  await putSessionIndex(c.env.STORE, id, {
    backend: 'b',
    containerId,
    tenantTag,
    agentName: bundle.agentName,
    version: bundle.version,
    skills: Object.keys(bundle.skills),
    createdAt: new Date().toISOString(),
  }).catch(() => {});

  // Pre-warm + eager reconstruction (plan §8/§15 P1). The initializer will
  // find the dirs present and no-op; on a later cold container it re-creates.
  await provisionAgentSkills(getSandbox(namespace, id), bundle);

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
    tenantTag,
  });
});

// Deterministic skill-check (plan §13): NOT arbitrary exec — the command is
// built server-side from a bounded op + validated params. Before running it
// this replays EXACTLY the agent initializer's cold-container path — read
// stored bundle, absent→write reconstruction — so cold-recovery is testable
// without an LLM turn. Behind the API-key guard like every other route.
app.post('/sessions/:id/skill-check', async (c) => {
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
    // Mirror the initializer's whitelist self-heal so the check exercises the
    // same egress policy a real turn would (deny-all stays deny-all: []).
    await putEgressWhitelist(c.env.STORE, namespace.idFromName(id).toString(), bundle.proxyWhitelist ?? []);
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

app.delete('/sessions/:id', async (c) => {
  const id = c.req.param('id');
  if (!isValidSessionId(id)) return c.json({ error: 'invalid session id' }, 400);
  const containerId = c.env.Sandbox.idFromName(id).toString();
  await kvSecretBroker(c.env.STORE).remove(containerId);
  await removeEgressWhitelist(c.env.STORE, containerId);
  await c.env.STORE.delete(`agent:${id}`);
  await removeSessionIndex(c.env.STORE, id).catch(() => {});
  return c.json({ ok: true });
});

// Explicit v2 mount (no auto-router): serves POST/GET /agents/main/:id and
// the conversation stream. `main` is the generic multi-agent host — which
// agent a session runs comes from its stored bundle, not the route.
app.route('/agents/main', createAgentRouter(Main));

export default app;
