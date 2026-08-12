/**
 * Per-SESSION rollup over the Braintrust traces (pnpm sessions).
 *
 * Braintrust stores one trace per submission (user message), which is the
 * atomic-completion unit — the session view is a reassembly over the
 * `metadata."flue.instance_id"` key every span carries (README "Skill
 * delivery to the model" > Observability). This script does that reassembly:
 * one row per session with messages, llm/tool calls, tokens, cost, and wall
 * time; `--session <id>` adds the per-message breakdown of one session.
 *
 * Usage:
 *   BRAINTRUST_API_KEY=... node scripts/session-costs.mjs [--hours 24] [--session <id>]
 *   (falls back to BRAINTRUST_API_KEY in backend-b/.dev.vars, the local dev home
 *    of that secret; BRAINTRUST_PROJECT_NAME defaults to semantius-copilot)
 *
 * Costs are pi-ai's model-catalog computation (see README) and span delivery
 * from Workers is best-effort — treat totals as a floor, not an invoice.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const API = 'https://api.braintrust.dev';
const MAX_SPANS = 5000;

const args = process.argv.slice(2);
const argValue = (flag) => {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : undefined;
};
const hours = Number(argValue('--hours') ?? 24);
const onlySession = argValue('--session');

const apiKey = process.env.BRAINTRUST_API_KEY ?? keyFromDevVars();
if (!apiKey) {
  console.error('BRAINTRUST_API_KEY not set and not found in backend-b/.dev.vars');
  process.exit(1);
}
const projectName = process.env.BRAINTRUST_PROJECT_NAME ?? 'semantius-copilot';

function keyFromDevVars() {
  try {
    const devVars = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'backend-b', '.dev.vars'), 'utf8');
    const line = devVars.split(/\r?\n/).find((l) => l.startsWith('BRAINTRUST_API_KEY='));
    return line?.slice('BRAINTRUST_API_KEY='.length).replace(/^"|"$/g, '').trim();
  } catch {
    return undefined;
  }
}

async function api(path, init) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', ...init?.headers },
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${await res.text()}`);
  return res.json();
}

const projects = await api(`/v1/project?project_name=${encodeURIComponent(projectName)}`);
const projectId = projects.objects?.[0]?.id;
if (!projectId) {
  console.error(`Braintrust project "${projectName}" not found`);
  process.exit(1);
}

// Keyset-paged fetch (the BTQL limit cap is 1000/page), newest first, until
// the time cutoff. llm spans carry the token/cost metrics; tool spans are
// counted per session/message.
const PAGE = 1000;
const cutoff = Date.now() - hours * 3600_000;
const data = [];
let before;
while (data.length < MAX_SPANS) {
  const query =
    `from: project_logs('${projectId}') | ` +
    `filter: (span_attributes.type = 'llm' or span_attributes.type = 'tool') and metadata."flue.instance_id" is not null` +
    `${before ? ` and created < '${before}'` : ''} | ` +
    `sort: created desc | limit: ${PAGE} | ` +
    `select: created, root_span_id, span_attributes.type as type, metadata."flue.instance_id" as instance, ` +
    `metadata.model as model, metadata."flue.stop_reason" as stop, ` +
    `metrics.prompt_tokens as prompt, metrics.completion_tokens as completion, ` +
    `metrics.estimated_cost as cost`;
  const page = (await api('/btql', { method: 'POST', body: JSON.stringify({ query, fmt: 'json' }) })).data ?? [];
  data.push(...page);
  if (page.length < PAGE) break;
  before = page[page.length - 1].created;
  if (Date.parse(before) < cutoff) break;
}

const spans = data.filter((s) => Date.parse(s.created) >= cutoff && (!onlySession || s.instance === onlySession));
if (data.length >= MAX_SPANS) {
  console.warn(`note: hit the ${MAX_SPANS}-span fetch cap — oldest sessions in the window may be incomplete`);
}
if (spans.length === 0) {
  console.log(`no spans in the last ${hours}h${onlySession ? ` for session ${onlySession}` : ''}`);
  process.exit(0);
}

function aggregate(group) {
  const out = { llm: 0, tool: 0, lengthStops: 0, prompt: 0, completion: 0, cost: 0, first: Infinity, last: -Infinity, models: new Set(), roots: new Set() };
  for (const s of group) {
    const t = Date.parse(s.created);
    out.first = Math.min(out.first, t);
    out.last = Math.max(out.last, t);
    out.roots.add(s.root_span_id);
    if (s.type === 'tool') out.tool += 1;
    else {
      out.llm += 1;
      // A length stop is a response truncated at the output-token cap — the
      // turn settles as completed with the work unfinished (the "agent went
      // silent" failure; see modelCatalogWarning in backend-b/src/llm.ts).
      if (s.stop === 'length') out.lengthStops += 1;
      out.prompt += s.prompt ?? 0;
      out.completion += s.completion ?? 0;
      out.cost += s.cost ?? 0;
      if (s.model) out.models.add(s.model);
    }
  }
  return out;
}

const fmt = {
  time: (t) => new Date(t).toISOString().slice(0, 16).replace('T', ' '),
  mins: (ms) => `${(ms / 60000).toFixed(1)}m`,
  cost: (c) => `$${c.toFixed(4)}`,
  int: (n) => n.toLocaleString('en-US'),
};

function printTable(rows, headers) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (cells) => cells.map((c, i) => String(c).padStart(widths[i])).join('  ');
  console.log(line(headers));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const r of rows) console.log(line(r));
}

const bySession = Map.groupBy(spans, (s) => s.instance);
const sessions = [...bySession.entries()]
  .map(([id, group]) => ({ id, ...aggregate(group), group }))
  .sort((a, b) => b.first - a.first);

console.log(`\nSessions with activity in the last ${hours}h (project ${projectName}):\n`);
printTable(
  sessions.map((s) => [
    s.id.slice(0, 8),
    fmt.time(s.first),
    fmt.mins(s.last - s.first),
    s.roots.size,
    s.llm,
    s.tool,
    s.lengthStops > 0 ? `⚠ ${s.lengthStops}` : '',
    fmt.int(s.prompt),
    fmt.int(s.completion),
    fmt.cost(s.cost),
    [...s.models].join(','),
  ]),
  ['session', 'started (UTC)', 'span', 'msgs', 'llm', 'tools', 'len-stops', 'prompt tok', 'compl tok', 'cost', 'model'],
);
const total = aggregate(spans);
console.log(
  `\nTOTAL: ${sessions.length} session(s), ${total.roots.size} message(s), ${total.llm} llm + ${total.tool} tool calls, ` +
  `${fmt.int(total.prompt)} prompt + ${fmt.int(total.completion)} completion tokens, ${fmt.cost(total.cost)}`,
);

if (onlySession) {
  const session = sessions[0];
  console.log(`\nPer-message breakdown for ${session.id}:\n`);
  const byMessage = [...Map.groupBy(session.group, (s) => s.root_span_id).values()]
    .map((g) => aggregate(g))
    .sort((a, b) => a.first - b.first);
  printTable(
    byMessage.map((m, i) => [
      i + 1,
      fmt.time(m.first),
      fmt.mins(m.last - m.first),
      m.llm,
      m.tool,
      m.lengthStops > 0 ? `⚠ ${m.lengthStops}` : '',
      fmt.int(m.prompt),
      fmt.int(m.completion),
      fmt.cost(m.cost),
    ]),
    ['#', 'started (UTC)', 'span', 'llm', 'tools', 'len-stops', 'prompt tok', 'compl tok', 'cost'],
  );
}
