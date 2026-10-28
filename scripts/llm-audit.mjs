#!/usr/bin/env node
/**
 * Audit ONE session's LLM spend against OpenRouter (pnpm llm-audit <sessionId>).
 *
 * Reads what the deployed backend recorded — every response's `llm_requests`
 * rows from the agent conversation (admin read) plus `title_usage.requests`
 * and the totals from THE session record — and checks two things:
 *
 *  1. Internal consistency: the rows sum to the stored totals
 *     (session_state.cost_total, title_usage.cost_total), and the request
 *     count matches llm_calls_count. A difference is either pre-tracking
 *     spend (sessions older than 2026-10-28 carried their old, compaction-less
 *     total forward) or a lost row — the report says which side is bigger.
 *  2. Against OpenRouter: each row's generation id is looked up via
 *     GET /api/v1/generation?id=… and its billed `total_cost` compared to the
 *     row's cost. Rows without an id (`unobserved`, failed calls) are listed.
 *
 * What this CANNOT see: a request OpenRouter billed that we never got a row
 * for (stream cut before its final usage chunk). Those only show in
 * OpenRouter's activity log; compare the log's count for the session's time
 * window with the row count printed here.
 *
 * Usage:
 *   node scripts/llm-audit.mjs <sessionId> [--no-openrouter] [--rows]
 *   (API_TOKEN and LLM_API_KEY from the environment, else backend-b/.dev.vars;
 *    B_URL defaults to the deployed backend)
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const sessionId = args.find((a) => !a.startsWith('--'));
const skipOpenRouter = args.includes('--no-openrouter');
const printRows = args.includes('--rows');
if (!sessionId) {
  console.error('usage: node scripts/llm-audit.mjs <sessionId> [--no-openrouter] [--rows]');
  process.exit(2);
}

function devVar(name) {
  if (process.env[name]) return process.env[name];
  try {
    const devVars = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'backend-b', '.dev.vars'), 'utf8');
    const line = devVars.split(/\r?\n/).find((l) => l.startsWith(`${name}=`));
    return line?.slice(name.length + 1).replace(/^"|"$/g, '').trim();
  } catch {
    return undefined;
  }
}

const B_URL = process.env.B_URL ?? 'https://semantius-copilot-backend-b.ma532.workers.dev';
const apiToken = devVar('API_TOKEN');
if (!apiToken) {
  console.error('API_TOKEN not set and not found in backend-b/.dev.vars');
  process.exit(2);
}
const openRouterKey = devVar('LLM_API_KEY');

async function admin(path) {
  const res = await fetch(`${B_URL}${path}`, { headers: { authorization: `Bearer ${apiToken}` } });
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

const usd = (n) => `$${(n ?? 0).toFixed(6)}`;
const round = (n) => Math.round(n * 1e9) / 1e9;
const sum = (rows, key) => round(rows.reduce((acc, r) => acc + (typeof r[key] === 'number' ? r[key] : 0), 0));

// --- What we recorded ------------------------------------------------------

const recordRes = await admin(`/admin/collections/kv/record?id=${encodeURIComponent(`session:${sessionId}`)}`);
const record = recordRes.json ?? recordRes;
const conversation = await admin(`/admin/agents/main/${encodeURIComponent(sessionId)}?view=history`);

const responses = (conversation.messages ?? []).filter((m) => m.role === 'assistant' && m.metadata);
const agentRows = responses.flatMap((m, i) =>
  (Array.isArray(m.metadata.llm_requests) ? m.metadata.llm_requests : []).map((r) => ({ ...r, response: i + 1 })),
);
const untracked = responses.filter((m) => !Array.isArray(m.metadata.llm_requests)).length;
const titleRows = Array.isArray(record.title_usage?.requests) ? record.title_usage.requests : [];
const rows = [...agentRows, ...titleRows.map((r) => ({ ...r, response: 'title' }))];

// The authoritative running totals are the newest response's
// metadata.session_state (written in the Durable Object with the rows); THE
// session record holds a best-effort mirror that KV may serve stale for up to
// ~60 s after a response. Audit against the former, report the mirror's lag.
const latestState = [...responses].reverse().find((m) => m.metadata.session_state)?.metadata.session_state;
const state = latestState ?? record.session_state ?? {};
const titleUsage = record.title_usage ?? {};

console.log(`session ${sessionId}`);
console.log(`  responses: ${responses.length} (${untracked} before per-request tracking)`);
console.log(`  rows: ${agentRows.length} agent-side + ${titleRows.length} title = ${rows.length}`);
console.log('');

// --- 1. Internal consistency ----------------------------------------------

let problems = 0;
function line(ok, label, detail) {
  if (!ok) problems += 1;
  console.log(`${ok ? 'OK  ' : 'DIFF'}  ${label}${detail ? ` — ${detail}` : ''}`);
}

const agentSum = sum(agentRows, 'cost');
const stateCost = typeof state.cost_total === 'number' ? state.cost_total : 0;
const agentGap = round(stateCost - agentSum);
line(
  Math.abs(agentGap) < 1e-8,
  `session_state.cost_total ${usd(stateCost)} (${latestState ? 'Durable Object' : 'KV mirror'}) vs sum(llm_requests.cost) ${usd(agentSum)}`,
  Math.abs(agentGap) < 1e-8
    ? ''
    : agentGap > 0
      ? `total is ${usd(agentGap)} higher — pre-tracking spend carried forward${untracked ? ` (${untracked} untracked responses)` : ''}, or rows lost`
      : `rows are ${usd(-agentGap)} higher — a row was recorded twice, or the total lost a write`,
);
const callRows = agentRows.filter((r) => r.purpose !== 'unobserved').length;
line(
  untracked > 0 || state.llm_calls_count === callRows,
  `llm_calls_count ${state.llm_calls_count ?? '—'} vs agent-side request rows ${callRows}`,
  untracked > 0 ? 'not comparable: count includes pre-tracking calls' : '',
);
const titleSum = sum(titleRows, 'cost');
line(
  Math.abs(round((titleUsage.cost_total ?? 0) - titleSum)) < 1e-8,
  `title_usage.cost_total ${usd(titleUsage.cost_total)} vs sum(title requests) ${usd(titleSum)}`,
);
const mirror = record.session_state ?? {};
line(
  mirror.cost_total === state.cost_total && mirror.responses_count === state.responses_count,
  `KV mirror (session record) matches the Durable Object's session_state`,
  mirror.cost_total === state.cost_total && mirror.responses_count === state.responses_count
    ? ''
    : `mirror at response ${mirror.responses_count ?? '—'} ${usd(mirror.cost_total)}, DO at response ${state.responses_count} ${usd(state.cost_total)} — KV lag (≤ ~60 s) or a lost mirror write, healed at the next response`,
);
const byPurpose = state.cost_by_purpose ?? {};
const purposeSum = round(Object.values(byPurpose).reduce((a, b) => a + b, 0));
line(Math.abs(round(purposeSum - stateCost)) < 1e-8, `cost_by_purpose sums to cost_total`, JSON.stringify(byPurpose));

const recordedTotal = round(stateCost + (titleUsage.cost_total ?? 0));
console.log(`\n  recorded LLM total (session_state + title_usage): ${usd(recordedTotal)}`);
const perPurpose = {};
for (const r of rows) perPurpose[r.purpose] = round((perPurpose[r.purpose] ?? 0) + (r.cost ?? 0));
console.log(`  rows by purpose: ${JSON.stringify(perPurpose)}`);
const noId = rows.filter((r) => !r.id);
if (noId.length) {
  console.log(`  rows without a generation id: ${noId.length} (${noId.map((r) => `${r.purpose}${r.error ? `/error:${r.error}` : ''} ${usd(r.cost)}`).join(', ')})`);
}
const firstAt = rows.map((r) => r.at).sort()[0];
const lastAt = rows.map((r) => r.at).sort().at(-1);
if (firstAt) console.log(`  window: ${firstAt} .. ${lastAt}`);

// --- 2. Against OpenRouter -------------------------------------------------

if (!skipOpenRouter) {
  if (!openRouterKey) {
    console.error('\nLLM_API_KEY not set and not in backend-b/.dev.vars — rerun with --no-openrouter');
    process.exit(2);
  }
  console.log('\nOpenRouter lookup (GET /api/v1/generation):');
  let billedSum = 0;
  let matched = 0;
  const mismatches = [];
  const missing = [];
  const ids = rows.filter((r) => r.id);
  for (const row of ids) {
    let data;
    // Generation stats land a few seconds after the request; retry a 404 briefly.
    for (let attempt = 0; attempt < 3 && !data; attempt += 1) {
      const res = await fetch(`https://openrouter.ai/api/v1/generation?id=${encodeURIComponent(row.id)}`, {
        headers: { authorization: `Bearer ${openRouterKey}` },
      });
      if (res.ok) data = (await res.json()).data;
      else if (res.status === 404 && attempt < 2) await new Promise((r) => setTimeout(r, 2000));
      else break;
    }
    if (!data) {
      missing.push(row);
      continue;
    }
    const billed = Number(data.total_cost ?? 0);
    billedSum += billed;
    if (Math.abs(billed - (row.cost ?? 0)) < 1e-9) matched += 1;
    else mismatches.push({ row, billed });
    if (printRows) {
      console.log(
        `  ${row.id}  ${String(row.purpose).padEnd(17)} ours ${usd(row.cost)}  openrouter ${usd(billed)}  ${data.model ?? ''}`,
      );
    }
  }
  billedSum = round(billedSum);
  line(mismatches.length === 0, `${matched}/${ids.length} rows match OpenRouter's billed cost exactly`);
  for (const { row, billed } of mismatches) {
    console.log(`        ${row.id} (${row.purpose}): ours ${usd(row.cost)}, openrouter ${usd(billed)}`);
  }
  line(missing.length === 0, `${ids.length - missing.length}/${ids.length} generation ids found on OpenRouter`);
  for (const row of missing) console.log(`        not found: ${row.id} (${row.purpose}, ${row.at})`);
  const idRowsSum = sum(ids, 'cost');
  console.log(`\n  OpenRouter billed for these ids: ${usd(billedSum)}  (our rows with ids: ${usd(idRowsSum)})`);
}

console.log(`\n${problems === 0 ? 'CONSISTENT' : `${problems} DIFFERENCE(S)`}`);
process.exit(problems === 0 ? 0 : 1);
