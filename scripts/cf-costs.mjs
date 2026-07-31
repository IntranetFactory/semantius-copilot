#!/usr/bin/env node
/**
 * Today's Cloudflare CONTAINER spend per session, straight from the CLI
 * (`pnpm costs`) — the same query and the same pricing the admin console's
 * Costs tab shows, both imported from core/src/cost.js so the two can never
 * disagree. Use it to cross-check the UI, and to debug the query without a
 * deploy.
 *
 * CONTAINER cost only. The admin tab additionally shows each session's LLM spend
 * (`session_state.cost_total`) beside it; that comes from THE session record in
 * KV, which this script has no binding for — so the LLM column is endpoint-only,
 * by design rather than by omission. `pnpm sessions` is the CLI for LLM cost.
 *
 * The join is the `session` label HothSandbox stamps on every container it
 * starts (backend-b/src/cloudflare.ts). Cloudflare's dataset has no dimension
 * that carries a name we choose — the `containerName` in some example queries
 * does not exist — so `--introspect` is here to settle field names against the
 * live schema rather than against documentation.
 *
 * Usage:
 *   node scripts/cf-costs.mjs                # today (UTC), per session
 *   node scripts/cf-costs.mjs --date 2026-07-29
 *   node scripts/cf-costs.mjs --raw          # the unfolded GraphQL response
 *   node scripts/cf-costs.mjs --introspect   # dimensions + sum fields of the dataset
 *
 * Credentials: CLOUDFLARE_API_TOKEN (Account -> Account Analytics -> Read) and
 * CLOUDFLARE_ACCOUNT_ID from the environment, else backend-b/.dev.vars and
 * backend-b/wrangler.jsonc respectively — the same places the Worker reads them.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CF_GRAPHQL_URL,
  CONTAINER_RATES,
  COST_BASIS,
  containerCostQuery,
  foldContainerCostResponse,
  utcDayWindow,
} from '../core/src/cost.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const argValue = (flag) => {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : undefined;
};

function fromDevVars(name) {
  try {
    const text = readFileSync(join(repoRoot, 'backend-b', '.dev.vars'), 'utf8');
    const line = text.split(/\r?\n/).find((l) => l.startsWith(`${name}=`));
    return line?.slice(name.length + 1).replace(/^"|"$/g, '').trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Account tag from wrangler.jsonc's vars — the deployed Worker's own value. */
function accountFromWrangler() {
  try {
    const text = readFileSync(join(repoRoot, 'backend-b', 'wrangler.jsonc'), 'utf8');
    return text.match(/"CLOUDFLARE_ACCOUNT_ID"\s*:\s*"([^"]+)"/)?.[1];
  } catch {
    return undefined;
  }
}

const token = process.env.CLOUDFLARE_API_TOKEN ?? fromDevVars('CLOUDFLARE_API_TOKEN');
const accountTag = process.env.CLOUDFLARE_ACCOUNT_ID ?? accountFromWrangler();
if (!token) {
  console.error('CLOUDFLARE_API_TOKEN not set and not found in backend-b/.dev.vars');
  console.error('Create one at dash.cloudflare.com/profile/api-tokens with Account → Account Analytics → Read.');
  process.exit(1);
}
if (!accountTag) {
  console.error('CLOUDFLARE_ACCOUNT_ID not set and not found in backend-b/wrangler.jsonc');
  process.exit(1);
}

async function graphql(body) {
  const res = await fetch(CF_GRAPHQL_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Cloudflare GraphQL ${res.status}: ${text.slice(0, 500)}`);
  const payload = JSON.parse(text);
  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    throw new Error(`Cloudflare GraphQL: ${payload.errors.map((e) => e.message ?? String(e)).join('; ')}`);
  }
  return payload;
}

// --- --introspect: what the dataset actually exposes -------------------------
if (args.includes('--introspect')) {
  const typeFields = async (name) => {
    const payload = await graphql({
      query: `query T($name: String!) { __type(name: $name) { name fields { name type { name kind ofType { name kind } } } } }`,
      variables: { name },
    });
    return payload.data?.__type;
  };
  for (const name of [
    'AccountContainersUsageAdaptiveGroups',
    'AccountContainersUsageAdaptiveGroupsDimensions',
    'AccountContainersUsageAdaptiveGroupsSum',
  ]) {
    const type = await typeFields(name);
    console.log(`\n=== ${name} ===`);
    if (!type) {
      console.log('(no such type — the dataset may be named differently on this account)');
      continue;
    }
    for (const f of type.fields ?? []) {
      console.log(`  ${f.name}: ${f.type?.name ?? f.type?.ofType?.name ?? f.type?.kind}`);
    }
  }
  process.exit(0);
}

// --- the real query ---------------------------------------------------------
const date = argValue('--date');
const window = date
  ? { date, start: `${date}T00:00:00Z`, end: `${date}T23:59:59Z` }
  : utcDayWindow();

const LIMIT = 1000;
const payload = await graphql(containerCostQuery({ accountTag, ...window, limit: LIMIT }));

if (args.includes('--raw')) {
  console.log(JSON.stringify(payload, null, 2));
  process.exit(0);
}

const { rows, unlabeled, totals, truncated } = foldContainerCostResponse(payload, LIMIT);

const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);
const usd = (n) => `$${n.toFixed(4)}`;
const num = (n) => n.toFixed(1);

console.log(`\nContainer cost — ${window.date} UTC (${window.start} .. ${window.end})`);
console.log(`account ${accountTag}`);
console.log(
  `\n${pad('session', 50)} ${padL('vCPU s', 10)} ${padL('GiB·s', 12)} ${padL('GB·s disk', 12)} ${padL('egress MB', 10)} ${padL('cost', 10)}`,
);
console.log('-'.repeat(108));
for (const row of rows) {
  console.log(
    `${pad(row.sessionId, 50)} ${padL(num(row.cpuSeconds), 10)} ${padL(num(row.memoryGiBSeconds), 12)} ${padL(num(row.diskGBSeconds), 12)} ${padL((row.egressBytes / 1e6).toFixed(2), 10)} ${padL(usd(row.cost.total), 10)}`,
  );
}
if (unlabeled) {
  console.log(
    `${pad('(unlabeled)', 50)} ${padL(num(unlabeled.cpuSeconds), 10)} ${padL(num(unlabeled.memoryGiBSeconds), 12)} ${padL(num(unlabeled.diskGBSeconds), 12)} ${padL((unlabeled.egressBytes / 1e6).toFixed(2), 10)} ${padL(usd(unlabeled.cost.total), 10)}`,
  );
}
console.log('-'.repeat(108));
console.log(
  `${pad('TOTAL', 50)} ${padL(num(totals.cpuSeconds), 10)} ${padL(num(totals.memoryGiBSeconds), 12)} ${padL(num(totals.diskGBSeconds), 12)} ${padL((totals.egressBytes / 1e6).toFixed(2), 10)} ${padL(usd(totals.cost.total), 10)}`,
);
console.log(
  `\nsplit: cpu ${usd(totals.cost.cpu)}  memory ${usd(totals.cost.memory)}  disk ${usd(totals.cost.disk)}  egress ${usd(totals.cost.egress)}`,
);
console.log(
  `rates: $${CONTAINER_RATES.cpuSecond}/vCPU-s, $${CONTAINER_RATES.memoryGiBSecond}/GiB-s, $${CONTAINER_RATES.diskGBSecond}/GB-s, $${CONTAINER_RATES.egressGB}/GB`,
);
console.log(`\n${COST_BASIS}`);
if (truncated) console.log('\nWARNING: hit the group limit — totals are partial.');
if (rows.length === 0 && !unlabeled) {
  console.log('\nNo container usage in this window. Analytics lags a few minutes behind live traffic.');
}
