/**
 * Backend A HTTP app.
 *
 * A is a STATIC agent (plan §6/§13 C1): no skill ingest route exists — the
 * skill is served purely from the image. A still shares the egress/secret
 * seam by design, so POST /sessions/:id/provision seeds the single static
 * bearer mapping KV[containerId] = STATIC_BEARER before the first prompt
 * (the frontend awaits the 2xx before chatting).
 */
import './braintrust';
import './otel';
import { getSandbox } from '@cloudflare/sandbox';
import { createAgentRouter } from '@flue/runtime/routing';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { Hoth } from './agents/hoth';
import {
  apiKeyGuard,
  buildSkillCheckCommand,
  SkillCheckError,
  kvSecretBroker,
  isValidSessionId,
  putSessionIndex,
  removeSessionIndex,
  adminCollections,
  listCollectionRecords,
  readCollectionRecord,
  STREAM_PROTOCOL_HEADERS,
} from '@hoth/core';

type Env = {
  Sandbox: DurableObjectNamespace;
  SECRETS: KVNamespace;
  STATIC_BEARER: string;
  API_TOKEN: string;
};

const app = new Hono<{ Bindings: Env }>();

// exposeHeaders: without it the browser can't read the durable-streams cursor
// headers (Stream-Up-To-Date / Stream-Next-Offset), so the conversation client
// busy-polls catch-up reads forever. See STREAM_PROTOCOL_HEADERS.
app.use('*', cors({ exposeHeaders: STREAM_PROTOCOL_HEADERS }));
// Every route except /health requires Authorization: Bearer <API_TOKEN>.
// Fail-closed if API_TOKEN is unset (503). This covers the mounted agent
// conversation/stream routes too, since the guard runs before the
// createAgentRouter mount below.
app.use('*', apiKeyGuard());

app.get('/health', (c) => c.json({ ok: true, backend: 'a', delivery: 'image-baked' }));

// Read-only data browser (behind the API-key guard). Presents every backing
// store as a generic collection so the frontend is a plain entities -> records
// -> record tree. Never mutates. `deps` injects the KV binding into the
// host-agnostic core resolver. (Flue v2 removed the workflow-run registry, so
// KV and the session index are the only backing stores left.)
const adminDeps = (c: { env: Env }) => ({ kv: c.env.SECRETS });
app.get('/admin/collections', (c) => c.json({ backend: 'a', collections: adminCollections('SECRETS') }));
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

app.post('/sessions/:id/provision', async (c) => {
  const id = c.req.param('id');
  if (!isValidSessionId(id)) return c.json({ error: 'invalid session id' }, 400);

  // Derive the container id exactly as the SDK does (plan §7): our ids are a
  // fixed point of sanitizeSandboxId, so idFromName(id) is the SDK's identity.
  const containerId = c.env.Sandbox.idFromName(id).toString();
  const broker = kvSecretBroker(c.env.SECRETS);
  await broker.put(containerId, c.env.STATIC_BEARER, 'static-a');

  // Index the session so the data browser can enumerate conversations without
  // knowing ids upfront (best-effort — never fail provisioning over the index).
  await putSessionIndex(c.env.SECRETS, id, { backend: 'a', containerId, tenantTag: 'static-a', createdAt: new Date().toISOString() }).catch(() => {});

  return c.json({ ok: true, backend: 'a', sessionId: id, containerId });
});

// Deterministic skill-check (plan §13): drives the fixed core commands in this
// session's sandbox, isolating the A/B comparison from LLM nondeterminism. NOT
// arbitrary exec — the command is built server-side from a bounded op + strictly
// validated params (see @hoth/core buildSkillCheckCommand). Behind the API-key
// guard like every other route.
app.post('/sessions/:id/skill-check', async (c) => {
  const id = c.req.param('id');
  if (!isValidSessionId(id)) return c.json({ error: 'invalid session id' }, 400);
  let command: string;
  try {
    command = buildSkillCheckCommand(await c.req.json());
  } catch (err) {
    if (err instanceof SkillCheckError) return c.json({ error: err.message }, 422);
    throw err;
  }
  const sandbox = getSandbox(c.env.Sandbox, id);
  const result = await sandbox.exec(command, { cwd: '/workspace' });
  return c.json({ exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr });
});

app.delete('/sessions/:id', async (c) => {
  const id = c.req.param('id');
  if (!isValidSessionId(id)) return c.json({ error: 'invalid session id' }, 400);
  const containerId = c.env.Sandbox.idFromName(id).toString();
  await kvSecretBroker(c.env.SECRETS).remove(containerId);
  await removeSessionIndex(c.env.SECRETS, id).catch(() => {});
  return c.json({ ok: true });
});

// Explicit v2 mount (no auto-router): serves POST/GET /agents/hoth/:id and
// the conversation stream — the same URL surface the beta flue() router
// exposed for this agent, so the frontend needs no path changes.
app.route('/agents/hoth', createAgentRouter(Hoth));

export default app;
