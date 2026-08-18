#!/usr/bin/env node
/**
 * chat-probe.mjs — drive ONE real LLM chat turn against the deployed backend
 * and print the assistant reply.
 *
 * Exists so observability changes (Braintrust, Arize/OTel) can be verified
 * without clicking through the frontend: send a turn here, then check the
 * Braintrust `semantius-copilot` logs / Arize `semantius-copilot` project for the trace.
 *
 *   API_TOKEN=$(cat .api-token) node scripts/chat-probe.mjs ["message"] [--payload='{"k":"v"}'] [--session=<id>] [--agent=<name>] [--deadline=<seconds>]
 *
 * --session=<id> resumes an EXISTING session instead of ingesting a new one —
 * the tool for cross-turn persistence checks (workspace backup/restore across
 * a container sleep needs a write turn and a later read turn on one session).
 * --agent=<name> drives another agents/ definition (default
 * hoth-trip-planner); its bundle must exist in dist-bundle/ (`pnpm bundle`)
 * and be deployed. --deadline=<seconds> extends the settle wait (default 180)
 * for turns that legitimately run long — e.g. the model-limits regression's
 * single-shot long write (fix_model_limits_plan.md).
 *
 * Talks the same wire protocol as the frontend FlueClient (raw fetch, like
 * acceptance.mjs): name-based ingest ({ agentName } — the trip-planner
 * definition must already be deployed via `pnpm deploy:agent
 * hoth-trip-planner`), then POST the message to /agents/main/:id with the
 * creation seed as `initialData` (design §6 — without it, turn 1 runs on
 * generic default instructions; the seed is built from dist-bundle/, so run
 * `pnpm bundle` first). The reply is polled from `?view=history` until the
 * submission settles.
 *
 * Ingest carries a freshly minted `<org>:<jwt>` as sessionContext because the
 * chat route rejects sessions without a verified Semantius user — so this
 * needs the same `.env` credentials as `pnpm mint-token`.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { skillCatalogFromBundle } from '../core/src/index.js';
import { mintSemantiusToken } from './lib/semantius.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args[0] === 'b') args.shift(); // legacy [a|b] selector — B is all that's left
if (args[0] === 'a') {
  console.error('backend A was removed — the probe drives the one remaining backend');
  process.exit(2);
}
// --payload='{"k":"v"}' rides the creation seed as `payload` (initialData) —
// the agent surfaces it in its instructions, so a message asking about it
// proves the payload E2E path.
let payload;
const payloadArg = args.find((arg) => arg.startsWith('--payload='));
if (payloadArg) payload = JSON.parse(payloadArg.slice('--payload='.length));
const message = args.find((arg) => !arg.startsWith('--')) ?? 'Reply with the single word OK.';
const adminKey = process.env.API_TOKEN || readFileSync(join(root, '.api-token'), 'utf8').trim();
const base = process.env.B_URL ?? 'https://semantius-copilot-backend-b.ma532.workers.dev';
// The chat surface authenticates as the USER (their own Semantius token as the
// bearer), the admin surface with the shared deployment key. The probe drives
// both: chat for the turn itself, admin for the session-record read at the end.
const semantiusToken = await mintSemantiusToken();
const headers = { authorization: `Bearer ${semantiusToken}`, 'content-type': 'application/json' };
const adminHeaders = { authorization: `Bearer ${adminKey}`, 'content-type': 'application/json' };

async function postJson(url, body) {
  const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await response.text();
  if (!response.ok) throw new Error(`POST ${url} -> ${response.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : undefined;
}

const agentName = args.find((arg) => arg.startsWith('--agent='))?.slice('--agent='.length) ?? 'hoth-trip-planner';
const bundle = JSON.parse(readFileSync(join(root, 'dist-bundle', `${agentName}.agent.json`), 'utf8'));
console.log(`minted semantius token for org ${semantiusToken.slice(0, semantiusToken.indexOf(':'))}`);
let sessionId = args.find((arg) => arg.startsWith('--session='))?.slice('--session='.length);
if (sessionId) {
  console.log(`resuming session ${sessionId}`);
} else try {
  // No credential in the body any more: the bearer IS the user's token, and the
  // backend pins the identity it verifies onto the session as its owner — and
  // mints the session id from it (`<org>-<sub>-<random>`), so the id is the
  // response's, never this script's.
  const ingest = await postJson(`${base}/sessions/agent`, { agentName: bundle.agentName });
  sessionId = ingest?.sessionId;
  if (!sessionId) throw new Error(`ingest returned no sessionId: ${JSON.stringify(ingest)}`);
  console.log(`session user: ${JSON.stringify(ingest?.user ?? null)}`);
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
  ...(bundle.maxTokens !== undefined ? { maxTokens: bundle.maxTokens } : {}),
  ...(bundle.contextWindow !== undefined ? { contextWindow: bundle.contextWindow } : {}),
  ...(bundle.openRouterRouting !== undefined ? { openRouterRouting: bundle.openRouterRouting } : {}),
  ...(skillCatalog.length > 0 ? { skillCatalog } : {}),
  ...(payload !== undefined ? { payload } : {}),
};
const conversationUrl = `${base}/agents/main/${sessionId}`;
const sendBody = { initialData: seed, kind: 'user', body: message };

console.log(`session ${sessionId} — sending: ${JSON.stringify(message)}`);
const admission = await postJson(conversationUrl, sendBody);
const submissionId = admission?.submissionId;
if (!submissionId) throw new Error(`send admission carried no submissionId: ${JSON.stringify(admission)}`);

const DEADLINE_MS = 1000 * Number(args.find((arg) => arg.startsWith('--deadline='))?.slice('--deadline='.length) ?? 180);
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

// session_state: aggregated at the response-finish seam and mirrored into the
// session:<id> index record fire-and-forget. The mirror is written in the
// DO's colo; this read runs in ours — KV propagation can take up to ~60 s
// (observed live), so poll a full propagation window before failing.
let sessionState;
for (let attempt = 0; attempt < 12 && !sessionState; attempt++) {
  if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 6000));
  const record = await fetch(`${base}/admin/collections/kv/record?id=session:${sessionId}`, { headers: adminHeaders });
  if (record.ok) sessionState = (await record.json())?.json?.session_state;
}
console.log(`session_state: ${JSON.stringify(sessionState ?? null)}`);
if (!sessionState || !(sessionState.llm_calls_count >= 1) || !(sessionState.total_tokens > 0)) {
  console.error('FAIL: session_state missing or counters not positive');
  process.exitCode = 1;
}
