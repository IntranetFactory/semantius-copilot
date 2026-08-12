#!/usr/bin/env node
/**
 * ask-user-question-probe.mjs — verify the AskUserQuestion round-trip against
 * the deployed backend, without the frontend:
 *
 *   1. Ingest a session and prompt the model to call AskUserQuestion.
 *      Oracle: the submission settles `completed` (terminate worked) and the
 *      last assistant message carries a dynamic-tool part
 *      `AskUserQuestion/output-available` with `awaiting_user_response`.
 *   2. POST the answer as the same `kind: 'signal'` delivery the chat UI
 *      sends (tagName `user_answers`, attributes.toolCallId, JSON body).
 *      Oracle: 202 admission wakes the idle agent, the signal projects as a
 *      diagnostic system message, and the follow-up assistant reply repeats
 *      the chosen label verbatim.
 *
 *   API_TOKEN=$(cat .api-token) node scripts/ask-user-question-probe.mjs
 *
 * Same wire protocol and credentials as chat-probe.mjs (raw fetch; needs the
 * `.env` credentials `pnpm mint-token` uses, and the trip-planner agent
 * deployed via `pnpm deploy:agent hoth-trip-planner`).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { skillCatalogFromBundle } from '../core/src/index.js';
import { mintSemantiusToken } from './lib/semantius.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const base = process.env.B_URL ?? 'https://semantius-copilot-backend-b.ma532.workers.dev';
const CHOSEN_LABEL = 'Tauntaun';

const semantiusToken = await mintSemantiusToken();
const headers = { authorization: `Bearer ${semantiusToken}`, 'content-type': 'application/json' };

async function postJson(url, body) {
  const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await response.text();
  if (!response.ok) throw new Error(`POST ${url} -> ${response.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : undefined;
}

async function settle(conversationUrl, submissionId, deadlineMs = 180_000) {
  const start = Date.now();
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const response = await fetch(`${conversationUrl}?view=history`, { headers });
    if (!response.ok) throw new Error(`history read -> ${response.status}`);
    const snapshot = await response.json();
    const settlement = snapshot.settlements?.find((entry) => entry.submissionId === submissionId);
    if (settlement) {
      if (settlement.outcome !== 'completed') {
        throw new Error(`submission settled ${settlement.outcome}: ${JSON.stringify(settlement.error ?? null)}`);
      }
      console.log(`settled completed in ${((Date.now() - start) / 1000).toFixed(1)}s`);
      return snapshot;
    }
    if (Date.now() - start > deadlineMs) throw new Error('timed out waiting for the submission to settle');
  }
}

const fail = (message) => {
  console.error(`FAIL: ${message}`);
  process.exit(1);
};

// ── 1. Session + ask turn ────────────────────────────────────────────────────
const bundle = JSON.parse(readFileSync(join(root, 'dist-bundle', 'hoth-trip-planner.agent.json'), 'utf8'));
const ingest = await postJson(`${base}/sessions/agent`, { agentName: bundle.agentName });
const sessionId = ingest?.sessionId;
if (!sessionId) throw new Error(`ingest returned no sessionId: ${JSON.stringify(ingest)}`);
const conversationUrl = `${base}/agents/main/${sessionId}`;
console.log(`session ${sessionId}`);

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

const askMessage =
  'Use the AskUserQuestion tool RIGHT NOW to ask me one single-select question: ' +
  `which mount I prefer, with exactly two options labeled "Speeder" and "${CHOSEN_LABEL}". ` +
  'When my answer arrives, reply with the sentence: You chose <label>. — repeating my chosen label verbatim.';
console.log('sending ask turn…');
const askAdmission = await postJson(conversationUrl, { initialData: seed, kind: 'user', body: askMessage });
const askSnapshot = await settle(conversationUrl, askAdmission.submissionId);

const toolPart = askSnapshot.messages
  .filter((m) => m.role === 'assistant')
  .flatMap((m) => m.parts)
  .findLast((part) => part.type === 'dynamic-tool' && part.toolName === 'AskUserQuestion');
if (!toolPart) fail('no AskUserQuestion dynamic-tool part in the assistant messages');
if (toolPart.state !== 'output-available') fail(`tool part state is ${toolPart.state}: ${JSON.stringify(toolPart)}`);
if (toolPart.output?.status !== 'awaiting_user_response') fail(`unexpected tool output: ${JSON.stringify(toolPart.output)}`);
const questions = toolPart.input?.questions;
if (!Array.isArray(questions) || questions.length === 0) fail(`tool input carries no questions: ${JSON.stringify(toolPart.input)}`);
console.log(`OK: tool called — toolCallId ${toolPart.toolCallId}, question ${JSON.stringify(questions[0].question)}`);

// ── 2. Answer signal (exactly what the chat UI sends) ───────────────────────
const answers = Object.fromEntries(questions.map((q) => [q.question, CHOSEN_LABEL]));
console.log('sending answer signal…');
const answerAdmission = await postJson(conversationUrl, {
  kind: 'signal',
  type: 'ask_user_question.answer',
  tagName: 'user_answers',
  attributes: { toolCallId: toolPart.toolCallId },
  body: JSON.stringify({ toolCallId: toolPart.toolCallId, cancelled: false, answers }),
  idempotencyKey: `ask-user-question:${toolPart.toolCallId}`,
});
const answerSnapshot = await settle(conversationUrl, answerAdmission.submissionId);

const signalMessage = answerSnapshot.messages.findLast((m) => m.signal?.tagName === 'user_answers');
if (!signalMessage) fail('answer signal message not found in history');
if (signalMessage.display === 'visible') fail(`answer signal projects as display=visible — it would show as a chat bubble`);
if (signalMessage.signal.attributes?.toolCallId !== toolPart.toolCallId) {
  fail(`signal attributes carry the wrong toolCallId: ${JSON.stringify(signalMessage.signal)}`);
}
console.log(`OK: signal projected as ${signalMessage.role}/${signalMessage.purpose}/${signalMessage.display}`);

const answeredBy = answerSnapshot.settlements.find((s) => s.submissionId === answerAdmission.submissionId)
  ?.answeredBySubmissionId ?? answerAdmission.submissionId;
const reply = answerSnapshot.messages
  .filter((m) => m.role === 'assistant' && (m.submissionId === answeredBy || m.submissionId === answerAdmission.submissionId))
  .flatMap((m) => m.parts)
  .filter((part) => part.type === 'text' && typeof part.text === 'string')
  .map((part) => part.text)
  .join('\n')
  || answerSnapshot.messages.filter((m) => m.role === 'assistant').at(-1)?.parts
    ?.filter((part) => part.type === 'text').map((part) => part.text).join('\n')
  || '';
console.log(`reply: ${reply}`);
if (!reply.includes(CHOSEN_LABEL)) fail(`assistant reply does not repeat the chosen label "${CHOSEN_LABEL}"`);
console.log('PASS: AskUserQuestion round-trip verified');
