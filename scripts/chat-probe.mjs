/**
 * chat-probe.mjs — drive ONE real LLM chat turn against a deployed backend
 * and print the assistant reply.
 *
 * Exists so observability changes (Braintrust, Arize/OTel) can be verified
 * without clicking through the frontend: send a turn here, then check the
 * Braintrust `hoth-poc` logs / Arize `hoth-poc` project for the trace.
 *
 *   API_TOKEN=$(cat .api-token) node scripts/chat-probe.mjs [a|b] ["message"]
 *
 * Talks the same wire protocol as the frontend FlueClient (raw fetch, like
 * acceptance.mjs): A = provision + POST the message to /agents/hoth/:id;
 * B = name-based ingest ({ agentName } — the trip-planner definition must
 * already be deployed via `pnpm deploy:agent hoth-trip-planner`), then POST
 * the message to /agents/main/:id with the creation seed as `initialData`
 * (plan §6 — without it, turn 1 runs on generic default instructions; the
 * seed is built from dist-bundle/, so run `pnpm bundle` first). The reply is
 * polled from `?view=history` until the submission settles.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { skillCatalogFromBundle } from '../core/src/index.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const backend = process.argv[2] ?? 'a';
const message = process.argv[3] ?? 'Reply with the single word OK.';
if (backend !== 'a' && backend !== 'b') {
  console.error('usage: node scripts/chat-probe.mjs [a|b] ["message"]');
  process.exit(2);
}
const token = process.env.API_TOKEN || readFileSync(join(root, '.api-token'), 'utf8').trim();
const base =
  backend === 'a'
    ? (process.env.A_URL ?? 'https://hoth-poc-backend-a.ma532.workers.dev')
    : (process.env.B_URL ?? 'https://hoth-poc-backend-b.ma532.workers.dev');
const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

async function postJson(url, body) {
  const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await response.text();
  if (!response.ok) throw new Error(`POST ${url} -> ${response.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : undefined;
}

const sessionId = randomUUID();
let conversationUrl;
let sendBody;
if (backend === 'a') {
  await postJson(`${base}/sessions/${sessionId}/provision`, {});
  conversationUrl = `${base}/agents/hoth/${sessionId}`;
  sendBody = { kind: 'user', body: message };
} else {
  const bundle = JSON.parse(readFileSync(join(root, 'dist-bundle', 'hoth-trip-planner.agent.json'), 'utf8'));
  try {
    await postJson(`${base}/sessions/${sessionId}/agent`, { agentName: bundle.agentName });
  } catch (err) {
    if (String(err).includes('404')) {
      console.error(`agent "${bundle.agentName}" is not deployed — run: pnpm deploy:agent ${bundle.agentName}`);
    }
    throw err;
  }
  const skillCatalog = skillCatalogFromBundle(bundle);
  const seed = {
    agentName: bundle.agentName,
    version: bundle.version,
    baseImage: bundle.baseImage,
    instructions: bundle.instructions,
    ...(bundle.model ? { model: bundle.model } : {}),
    ...(bundle.modelBaseUrl ? { modelBaseUrl: bundle.modelBaseUrl } : {}),
    ...(skillCatalog.length > 0 ? { skillCatalog } : {}),
  };
  conversationUrl = `${base}/agents/main/${sessionId}`;
  sendBody = { initialData: seed, kind: 'user', body: message };
}

console.log(`session ${sessionId} on backend ${backend} — sending: ${JSON.stringify(message)}`);
const admission = await postJson(conversationUrl, sendBody);
const submissionId = admission?.submissionId;
if (!submissionId) throw new Error(`send admission carried no submissionId: ${JSON.stringify(admission)}`);

const DEADLINE_MS = 180_000;
const start = Date.now();
for (;;) {
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const response = await fetch(`${conversationUrl}?view=history`, { headers });
  if (!response.ok) throw new Error(`history read -> ${response.status}`);
  const snapshot = await response.json();
  const settlement = snapshot.settlements?.find((entry) => entry.submissionId === submissionId);
  if (!settlement) {
    if (Date.now() - start > DEADLINE_MS) throw new Error('timed out waiting for the submission to settle');
    continue;
  }
  if (settlement.outcome !== 'completed') {
    throw new Error(`submission settled ${settlement.outcome}: ${JSON.stringify(settlement.error ?? null)}`);
  }
  const answeredBy = settlement.answeredBySubmissionId ?? submissionId;
  const assistant = snapshot.messages.filter((m) => m.role === 'assistant' && m.submissionId === answeredBy).at(-1)
    ?? snapshot.messages.filter((m) => m.role === 'assistant').at(-1);
  const text = (assistant?.parts ?? [])
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n');
  console.log(`settled completed in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  console.log(`reply: ${text || JSON.stringify(assistant ?? null)}`);
  break;
}
