#!/usr/bin/env node
/**
 * task-tools-probe.mjs — verify the Claude Code–compatible task tools
 * (TaskCreate / TaskUpdate / TaskList / TaskGet, design §17) against the
 * DEPLOYED backend, without the frontend:
 *
 *   1. Ingest a session and instruct the model to create three tasks, move #1
 *      through in_progress → completed, and list them.
 *      Oracles: the submission settles `completed`; the assistant messages
 *      carry `TaskCreate/output-available` parts whose outputs are
 *      `{ task: { id, subject } }` with ids "1".."3" (sequential, no
 *      duplicates even when the model batches the calls — the per-session
 *      mutex); `TaskUpdate` outputs are `{ success: true, … statusChange }`;
 *      the last `TaskList` output lists the three with #1 completed.
 *   2. `POST /admin/sessions/<id>/backup {action:"status"}` (API key):
 *      the session record carries a `session_backup` — the tasks file was
 *      persisted to R2 like any workspace mutation.
 *   3. A second turn: "call TaskList, then TaskGet 2".
 *      Oracles: the list matches turn 1 (durable across submissions — read
 *      back from /workspace/.tasks/tasks.json, not from model memory) and
 *      TaskGet returns the full record.
 *
 *   API_TOKEN=$(cat .api-token) node scripts/task-tools-probe.mjs
 *
 * Same wire protocol and credentials as ask-user-question-probe.mjs (raw
 * fetch; needs the `.env` credentials `pnpm mint-token` uses, and the
 * trip-planner agent deployed via `pnpm deploy:agent hoth-trip-planner`).
 * Without API_TOKEN step 2 is skipped with a warning.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { skillCatalogFromBundle } from '../core/src/index.js';
import { mintSemantiusToken } from './lib/semantius.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const base = process.env.B_URL ?? 'https://semantius-copilot-backend-b.ma532.workers.dev';
const apiToken = process.env.API_TOKEN;

const semantiusToken = await mintSemantiusToken();
const headers = { authorization: `Bearer ${semantiusToken}`, 'content-type': 'application/json' };

async function postJson(url, body, extraHeaders = headers) {
  const response = await fetch(url, { method: 'POST', headers: extraHeaders, body: JSON.stringify(body) });
  const text = await response.text();
  if (!response.ok) throw new Error(`POST ${url} -> ${response.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : undefined;
}

async function settle(conversationUrl, submissionId, deadlineMs = 240_000) {
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

const toolParts = (snapshot, toolName) =>
  snapshot.messages
    .filter((m) => m.role === 'assistant')
    .flatMap((m) => m.parts)
    .filter((part) => part.type === 'dynamic-tool' && part.toolName === toolName);

// ── 1. Session + task turn ──────────────────────────────────────────────────
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

const SUBJECTS = ['Pack the thermal suit', 'Book the tauntaun', 'Reserve the spa slot'];
const taskMessage =
  'This is a tool-usage test — do NOT plan a trip, do NOT read skills, do NOT run commands. ' +
  `Use the task tools exactly like this, in this order: (1) call TaskCreate three times with the subjects ` +
  `${SUBJECTS.map((s) => `"${s}"`).join(', ')} (any short description each); ` +
  '(2) call TaskUpdate to set task "1" to in_progress; (3) call TaskUpdate to set task "1" to completed; ' +
  '(4) call TaskList. Then reply with one line: "Tasks: <ids of the tasks TaskList returned>".';
console.log('sending task turn…');
const admission1 = await postJson(conversationUrl, { initialData: seed, kind: 'user', body: taskMessage });
const snapshot1 = await settle(conversationUrl, admission1.submissionId);

const creates = toolParts(snapshot1, 'TaskCreate');
if (creates.length < 3) fail(`expected ≥3 TaskCreate parts, got ${creates.length}`);
for (const part of creates) {
  if (part.state !== 'output-available') fail(`TaskCreate part state ${part.state}: ${JSON.stringify(part).slice(0, 300)}`);
  const id = part.output?.task?.id;
  const subject = part.output?.task?.subject;
  if (typeof id !== 'string' || typeof subject !== 'string') fail(`TaskCreate output not {task:{id,subject}}: ${JSON.stringify(part.output)}`);
  if (subject !== part.input?.subject) fail(`TaskCreate output subject ${subject} ≠ input ${part.input?.subject}`);
}
const createdIds = creates.map((part) => part.output.task.id);
if (new Set(createdIds).size !== createdIds.length) fail(`duplicate task ids allocated: ${createdIds.join(', ')} (mutex broken?)`);
if (!['1', '2', '3'].every((id) => createdIds.includes(id))) fail(`expected ids 1..3, got ${createdIds.join(', ')}`);
console.log(`OK: TaskCreate ×${creates.length} → ids ${createdIds.join(', ')}`);

const updates = toolParts(snapshot1, 'TaskUpdate');
if (updates.length < 2) fail(`expected ≥2 TaskUpdate parts, got ${updates.length}`);
for (const part of updates) {
  if (part.state !== 'output-available') fail(`TaskUpdate part state ${part.state}: ${JSON.stringify(part).slice(0, 300)}`);
  if (part.output?.success !== true) fail(`TaskUpdate not successful: ${JSON.stringify(part.output)}`);
  if (!Array.isArray(part.output.updatedFields)) fail(`TaskUpdate output lacks updatedFields: ${JSON.stringify(part.output)}`);
}
const completedUpdate = updates.find((part) => part.output.statusChange?.to === 'completed');
if (!completedUpdate) fail(`no TaskUpdate carried statusChange.to === "completed": ${JSON.stringify(updates.map((p) => p.output))}`);
console.log(`OK: TaskUpdate ×${updates.length} — ${updates.map((p) => `#${p.output.taskId} ${p.output.updatedFields.join('+')}${p.output.statusChange ? `→${p.output.statusChange.to}` : ''}`).join(', ')}`);

const lists1 = toolParts(snapshot1, 'TaskList');
if (lists1.length === 0) fail('no TaskList part in turn 1');
const list1 = lists1.at(-1);
if (list1.state !== 'output-available') fail(`TaskList part state ${list1.state}`);
const listed1 = list1.output?.tasks;
if (!Array.isArray(listed1) || listed1.length !== 3) fail(`TaskList should list 3 tasks: ${JSON.stringify(list1.output)}`);
const one = listed1.find((t) => t.id === '1');
if (one?.status !== 'completed') fail(`task #1 should be completed in TaskList: ${JSON.stringify(listed1)}`);
for (const t of listed1) {
  if (typeof t.subject !== 'string' || typeof t.status !== 'string' || !Array.isArray(t.blockedBy)) {
    fail(`TaskList entry not {id,subject,status,blockedBy}: ${JSON.stringify(t)}`);
  }
}
console.log(`OK: TaskList → ${listed1.map((t) => `#${t.id}[${t.status}]`).join(' ')}`);

// ── 2. The tasks file was persisted (R2 workspace backup) ───────────────────
// The persist is fire-and-forget and coalesced (≥1.5 s spacing, squashfs +
// R2 upload), so it can land seconds AFTER the submission settles — poll.
if (apiToken) {
  const adminHeaders = { authorization: `Bearer ${apiToken}`, 'content-type': 'application/json' };
  const deadline = Date.now() + 90_000;
  let status;
  for (;;) {
    status = (await postJson(`${base}/admin/sessions/${sessionId}/backup`, { action: 'status' }, adminHeaders))?.result;
    if (status?.configured === false || status?.session_backup?.backup_id || Date.now() > deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  if (status?.configured === false) {
    console.log('WARN: BACKUP_BUCKET not configured on the deployment — persistence check skipped');
  } else if (!status?.session_backup?.backup_id) {
    fail(`no session_backup on the record 90 s after the task turn: ${JSON.stringify(status)}`);
  } else {
    console.log(`OK: session_backup ${status.session_backup.backup_id} (${status.session_backup.size_bytes} B, count ${status.session_backup.backup_count})`);
  }
} else {
  console.log('WARN: API_TOKEN not set — skipping the backup-status oracle');
}

// ── 3. Second turn: durable across submissions ──────────────────────────────
console.log('sending list turn…');
const admission2 = await postJson(conversationUrl, {
  kind: 'user',
  body: 'Tool-usage test again: call TaskList, then call TaskGet for task "2". Reply with one line: "Task 2: <its subject>".',
});
const snapshot2 = await settle(conversationUrl, admission2.submissionId);

const list2 = toolParts(snapshot2, 'TaskList').at(-1);
if (!list2 || list2.state !== 'output-available') fail('no settled TaskList part in turn 2');
const listed2 = list2.output?.tasks;
if (!Array.isArray(listed2) || listed2.length !== 3) fail(`turn-2 TaskList should still list 3 tasks: ${JSON.stringify(list2.output)}`);
const same =
  JSON.stringify(listed2.map((t) => [t.id, t.subject, t.status])) === JSON.stringify(listed1.map((t) => [t.id, t.subject, t.status]));
if (!same) fail(`turn-2 TaskList differs from turn 1:\n  ${JSON.stringify(listed1)}\n  ${JSON.stringify(listed2)}`);
console.log('OK: turn-2 TaskList matches turn 1 (state read back from the workspace file)');

const get2 = toolParts(snapshot2, 'TaskGet').at(-1);
if (!get2 || get2.state !== 'output-available') fail('no settled TaskGet part in turn 2');
const got = get2.output?.task;
if (!got || got.id !== '2' || typeof got.description !== 'string' || !Array.isArray(got.blocks) || !Array.isArray(got.blockedBy)) {
  fail(`TaskGet output not the full record for #2: ${JSON.stringify(get2.output)}`);
}
console.log(`OK: TaskGet #2 → "${got.subject}" [${got.status}]`);

console.log('PASS: task tools verified (create/update/list, persisted, durable across turns, get)');
