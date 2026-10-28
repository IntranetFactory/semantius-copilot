#!/usr/bin/env node
/**
 * Audit ONE session's LLM spend against OpenRouter (pnpm llm-audit <sessionId>).
 *
 * Reads the session's request ledger exactly as the admin page shows it
 * (`sessionIndex.requests` — KV `requests:<id>` — and `requests_total`) and
 * checks two things:
 *
 *  1. Internal consistency: the total is the sum of the requests; no request
 *     is left pending or without a cost; the ledger's agent+compaction calls
 *     sum to the agent Durable Object's own session_state.cost_total (an
 *     independent count — a shortfall means the ledger lost an entry).
 *  2. Against OpenRouter: each request's generation id is looked up via
 *     GET /api/v1/generation?id=… and its billed `total_cost` and native token
 *     counts compared to ours.
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

// THE session as the admin page shows it: the session record plus
// `requests` (the request ledger, KV `requests:<id>`) and `requests_total`.
const recordRes = await admin(`/admin/collections/sessions/record?id=${encodeURIComponent(sessionId)}`);
const record = recordRes.session ?? {};
const ledger = record.requests && typeof record.requests === 'object' ? record.requests : {};
const rows = Object.entries(ledger)
  .map(([key, entry]) => ({ key, ...entry }))
  .sort((a, b) => String(a.at ?? '').localeCompare(String(b.at ?? '')));

// The agent Durable Object's own running totals (agent + compaction calls,
// newest response's metadata) — an independent cross-check of the ledger.
const conversation = await admin(`/admin/agents/main/${encodeURIComponent(sessionId)}?view=history`).catch(() => ({}));
const responses = (conversation.messages ?? []).filter((m) => m.role === 'assistant' && m.metadata);
const state = [...responses].reverse().find((m) => m.metadata.session_state)?.metadata.session_state ?? {};

console.log(`session ${sessionId}`);
console.log(`  requests: ${rows.length} (${rows.filter((r) => r.purpose === 'title').length} title)`);
console.log('');

// --- 1. Internal consistency ----------------------------------------------

let problems = 0;
function line(ok, label, detail) {
  if (!ok) problems += 1;
  console.log(`${ok ? 'OK  ' : 'DIFF'}  ${label}${detail ? ` — ${detail}` : ''}`);
}

const total = record.requests_total ?? {};
line(Math.abs(round((total.cost_total ?? 0) - sum(rows, 'cost'))) < 1e-8, `requests_total.cost_total ${usd(total.cost_total)} = sum of requests ${usd(sum(rows, 'cost'))}`);

const pending = rows.filter((r) => r.pending);
line(
  pending.length === 0,
  `no pending requests`,
  pending.length
    ? `${pending.length} still pending — a call in flight now, or one interrupted (restart/deploy): ${pending.map((r) => `${r.purpose} ${r.model ?? ''} at ${r.at}`).join('; ')}`
    : '',
);
const unknown = rows.filter((r) => r.cost_unknown);
line(
  unknown.length === 0,
  `no requests with unknown cost`,
  unknown.length ? `${unknown.length} ended without a usage report (OpenRouter's figure below): ${unknown.map((r) => r.id ?? r.key).join(', ')}` : '',
);

// Agent + compaction calls in the ledger vs the Durable Object's totals. The
// DO counts each response's calls (an `unobserved` gap included), so the two
// agree unless the ledger lost an entry — or the ledger also holds calls of a
// response still running.
const agentSide = rows.filter((r) => r.purpose !== 'title');
const settled = new Set((conversation.settlements ?? []).map((st) => st.submissionId));
const responseOpen = (conversation.messages ?? []).some((m) => m.submissionId && !settled.has(m.submissionId));
if (typeof state.cost_total === 'number') {
  const gap = round(state.cost_total - sum(agentSide, 'cost'));
  line(
    Math.abs(gap) < 1e-8 || responseOpen,
    `ledger agent+compaction ${usd(sum(agentSide, 'cost'))} vs Durable Object session_state.cost_total ${usd(state.cost_total)}`,
    Math.abs(gap) < 1e-8
      ? ''
      : responseOpen
        ? 'not comparable yet: a response is still running'
        : gap > 0
          ? `ledger is ${usd(gap)} short — entries missing from the ledger (or spend from before the ledger existed, 2026-10-28)`
          : `ledger is ${usd(-gap)} higher — calls the DO did not count`,
  );
}

const perPurpose = {};
for (const r of rows) perPurpose[r.purpose] = round((perPurpose[r.purpose] ?? 0) + (r.cost ?? 0));
console.log(`
  recorded LLM total: ${usd(total.cost_total)}  by purpose: ${JSON.stringify(perPurpose)}`);
if (total.first_at) console.log(`  window: ${total.first_at} .. ${total.last_at}`);
const noId = rows.filter((r) => !r.id && !r.pending);
if (noId.length) {
  console.log(`  failed requests without a generation id (OpenRouter rejected them; normally not billed): ${noId.length}`);
  for (const r of noId) console.log(`        ${r.at} ${r.purpose} ${r.model ?? ''} ${r.error_message ?? r.error ?? ''}`);
}

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
  const noStats = [];
  const tokenMismatches = [];
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
    // An EMPTY record — no tokens, no finish reason, no provider response —
    // is OpenRouter missing the stats, not a $0 bill: seen 2026-10-28 for
    // every agent call of a meta/muse-spark-1.3-contributor session, whose
    // streams reported a billed usage.cost, while a small direct call to the
    // same model looked up fine. Counted apart so it is not read as a refund.
    if (!data.tokens_prompt && !data.tokens_completion && !data.finish_reason && !data.total_cost) {
      noStats.push(row);
      continue;
    }
    const billed = Number(data.total_cost ?? 0);
    billedSum += billed;
    if (Math.abs(billed - (row.cost ?? 0)) < 1e-9) matched += 1;
    else mismatches.push({ row, billed });
    // Tokens against OpenRouter's NATIVE counts (the provider's tokenizer, the
    // billing basis) — `tokens_prompt` is OpenRouter's normalized count and
    // never matches. Rows from before usage.reported may carry the
    // context-size estimate instead (README "Server-tool usage").
    const ourPrompt = (row.input_tokens ?? 0) + (row.cache_read_tokens ?? 0) + (row.cache_write_tokens ?? 0);
    if (ourPrompt !== data.native_tokens_prompt || row.output_tokens !== data.native_tokens_completion) {
      tokenMismatches.push({ row, ourPrompt, data });
    }
    if (printRows) {
      console.log(
        `  ${row.id}  ${String(row.purpose).padEnd(17)} ours ${usd(row.cost)}  openrouter ${usd(billed)}  ${data.model ?? ''}`,
      );
    }
  }
  billedSum = round(billedSum);
  const withStats = ids.length - missing.length - noStats.length;
  line(mismatches.length === 0, `${matched}/${withStats} rows with OpenRouter stats match its billed cost exactly`);
  line(
    tokenMismatches.length === 0,
    `${withStats - tokenMismatches.length}/${withStats} rows match OpenRouter's native prompt/completion tokens`,
  );
  for (const { row, ourPrompt, data } of tokenMismatches) {
    console.log(
      `        ${row.id} (${row.purpose}): ours ${ourPrompt}/${row.output_tokens}, openrouter ${data.native_tokens_prompt}/${data.native_tokens_completion}`,
    );
  }
  line(
    noStats.length === 0,
    `${withStats}/${ids.length - missing.length} found generations have stats on OpenRouter`,
    noStats.length
      ? `${noStats.length} empty records (no tokens/finish/cost; our rows hold ${usd(sum(noStats, 'cost'))}) — check OpenRouter's activity log for the window`
      : '',
  );
  for (const { row, billed } of mismatches) {
    console.log(`        ${row.id} (${row.purpose}): ours ${usd(row.cost)}, openrouter ${usd(billed)}`);
  }
  line(missing.length === 0, `${ids.length - missing.length}/${ids.length} generation ids found on OpenRouter`);
  for (const row of missing) console.log(`        not found: ${row.id} (${row.purpose}, ${row.at})`);
  const statRows = ids.filter((r) => !missing.includes(r) && !noStats.includes(r));
  console.log(`\n  OpenRouter billed for the ids it has stats for: ${usd(billedSum)}  (our rows for the same ids: ${usd(sum(statRows, 'cost'))})`);
}

console.log(`\n${problems === 0 ? 'CONSISTENT' : `${problems} DIFFERENCE(S)`}`);
process.exit(problems === 0 ? 0 : 1);
