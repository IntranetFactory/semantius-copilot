#!/usr/bin/env node
/**
 * logs.mjs — read the deployed backend's Workers Logs AFTER THE FACT (pnpm logs:query).
 *
 * `wrangler tail` (pnpm logs) is live-only: whatever happened before you attached is
 * gone from it. Cloudflare keeps Workers Logs for days (observability.enabled in
 * wrangler.jsonc) and exposes them through the Workers Observability query API;
 * this script is the CLI for that — the post-mortem tool the 2026-08-19 stub-break
 * incident lacked (README "Mid-turn stub break": the `lazy-env:` / `backup:`
 * breadcrumbs and the runtime's own exception events were all in there, and no
 * token in the repo could read them).
 *
 *   pnpm logs:query                                   # last 30 min, all events
 *   pnpm logs:query --from -2h                        # relative window (s/m/h/d)
 *   pnpm logs:query --from 2026-08-19T15:33:00Z --to 2026-08-19T15:35:00Z
 *   pnpm logs:query --grep unbhcaukga1o6dadc9klavln   # substring match (the reference id)
 *   pnpm logs:query --session tests-user3-84351d826fa44ee1961c1439f094e58e
 *   pnpm logs:query --level error                     # error | warn | info | log | debug
 *   pnpm logs:query --limit 500 --json                # raw events, one JSON per line
 *
 * --session is a convenience needle for the session id: it matches every log line
 * that carries it (`backup: persisted … for <id>`, request URLs `/agents/main/<id>`)
 * but NOT the DO-internal lines that don't (`lazy-env: …` names the op, not the
 * session) — for those, narrow by time and read the neighbours, or pass
 * `--do <durableObjectId>` (printed on every DO event) once you have one.
 *
 * Credential: a Cloudflare API token with **Account → Workers Observability → Read**.
 * Read from the environment, then backend-b/.dev.vars (the local home of secrets):
 * `CLOUDFLARE_OBSERVABILITY_TOKEN` first, then `CLOUDFLARE_API_TOKEN` (the costs
 * token — widen that one's permissions in the dashboard instead of minting a
 * second secret, if you prefer; its value does not change, so no redeploy). The
 * account id is read from wrangler.jsonc (CLOUDFLARE_ACCOUNT_ID), the worker name
 * from its `name`. Both tokens the repo held before this script existed were
 * rejected with `10000 Authentication error` — the Analytics-read token and the
 * wrangler OAuth token — so the permission really is a separate grant.
 *
 * Output (default, human): one line per event —
 *   <UTC time> <level> <entrypoint|script> [<outcome> <wallTime>ms] <message or error>
 * followed by request method/url when the event is a request boundary and by the
 * DO id when it ran in a Durable Object. Events arrive newest first from the API;
 * they are printed oldest first here, so a window reads like a log.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const argValue = (flag) => {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : undefined;
};
const hasFlag = (flag) => args.includes(flag);

if (hasFlag('--help') || hasFlag('-h')) {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^\/\*\*?\s?|^ \* ?/gm, ''));
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Config: token, account, worker name.

function devVar(name) {
  try {
    const text = readFileSync(join(root, 'backend-b', '.dev.vars'), 'utf8');
    const line = text.split(/\r?\n/).find((l) => l.startsWith(`${name}=`));
    const value = line?.slice(name.length + 1).replace(/^"|"$/g, '').trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

const token =
  process.env.CLOUDFLARE_OBSERVABILITY_TOKEN ||
  devVar('CLOUDFLARE_OBSERVABILITY_TOKEN') ||
  process.env.CLOUDFLARE_API_TOKEN ||
  devVar('CLOUDFLARE_API_TOKEN');
if (!token) {
  console.error(
    'No token: set CLOUDFLARE_OBSERVABILITY_TOKEN (or CLOUDFLARE_API_TOKEN with Workers Observability Read) in the env or backend-b/.dev.vars',
  );
  process.exit(1);
}

const wranglerJsonc = readFileSync(join(root, 'backend-b', 'wrangler.jsonc'), 'utf8');
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? wranglerJsonc.match(/"CLOUDFLARE_ACCOUNT_ID":\s*"([0-9a-f]+)"/)?.[1];
const workerName = argValue('--worker') ?? wranglerJsonc.match(/^\s*"name":\s*"([^"]+)"/m)?.[1];
if (!accountId || !workerName) {
  console.error('could not read CLOUDFLARE_ACCOUNT_ID / name from backend-b/wrangler.jsonc');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Window: --from / --to accept ISO timestamps or relative offsets (-15m, -2h, -1d).

const now = Date.now();
function parseTime(value, fallback) {
  if (!value) return fallback;
  const rel = value.match(/^-(\d+)([smhd])$/);
  if (rel) {
    const unit = { s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[rel[2]];
    return now - Number(rel[1]) * unit;
  }
  const t = Date.parse(value);
  if (Number.isNaN(t)) {
    console.error(`bad time: ${value} (use ISO 8601 or -15m / -2h / -1d)`);
    process.exit(1);
  }
  return t;
}
const from = parseTime(argValue('--from'), now - 30 * 60_000);
const to = parseTime(argValue('--to'), now);
if (to <= from) {
  console.error('--to must be after --from');
  process.exit(1);
}

const limit = Math.min(Number(argValue('--limit') ?? 200), 10_000);
const needle = argValue('--grep') ?? argValue('--session');
const level = argValue('--level');
const doId = argValue('--do');
const asJson = hasFlag('--json');

// ---------------------------------------------------------------------------
// Query. Shape per the Workers Observability "telemetry query" API (the one the
// dashboard's Query Builder and Workers Logs view call): filters on event keys,
// an optional free-text needle, `view: 'events'` for raw events.

const filters = [{ key: '$metadata.service', operation: 'eq', value: workerName, type: 'string' }];
if (level) filters.push({ key: '$metadata.level', operation: 'eq', value: level, type: 'string' });
if (doId) filters.push({ key: '$workers.durableObjectId', operation: 'eq', value: doId, type: 'string' });

const body = {
  queryId: 'semantius-copilot-logs',
  timeframe: { from, to },
  parameters: {
    datasets: ['cloudflare-workers'],
    filters,
    ...(needle ? { needle: { value: needle, matchCase: false, isRegex: false } } : {}),
    limit,
  },
  view: 'events',
  limit,
};

const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/observability/telemetry/query`, {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
const text = await res.text();
if (!res.ok) {
  console.error(`query failed: HTTP ${res.status}\n${text.slice(0, 2000)}`);
  if (res.status === 403 || res.status === 401) {
    console.error(
      '\nThe token lacks Account → Workers Observability → Read (dashboard → My Profile → API Tokens). ' +
        'Put it in backend-b/.dev.vars as CLOUDFLARE_OBSERVABILITY_TOKEN, or add the permission to the existing CLOUDFLARE_API_TOKEN.',
    );
  }
  process.exit(1);
}

let payload;
try {
  payload = JSON.parse(text);
} catch {
  console.error(`non-JSON response:\n${text.slice(0, 2000)}`);
  process.exit(1);
}
if (payload.success === false) {
  console.error(`query error: ${JSON.stringify(payload.errors ?? payload).slice(0, 2000)}`);
  process.exit(1);
}

// The events live at result.events.events in the current API; be tolerant of a
// flatter shape (result.events as the array) so a response-format change degrades
// to "here is what came back" rather than a crash.
const result = payload.result ?? payload;
const events = Array.isArray(result.events?.events)
  ? result.events.events
  : Array.isArray(result.events)
    ? result.events
    : Array.isArray(result)
      ? result
      : null;
if (!events) {
  console.error('unrecognized response shape — raw result follows:');
  console.log(JSON.stringify(result, null, 2).slice(0, 5000));
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Print, oldest first.

const sorted = [...events].sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
const iso = (ms) => (typeof ms === 'number' ? new Date(ms).toISOString() : String(ms ?? ''));

if (asJson) {
  for (const ev of sorted) console.log(JSON.stringify(ev));
} else {
  for (const ev of sorted) {
    const meta = ev.$metadata ?? {};
    const workers = ev.$workers ?? {};
    const where = workers.entrypoint || workers.scriptName || meta.service || '';
    const outcome = workers.outcome ? ` ${workers.outcome}${typeof workers.wallTimeMs === 'number' ? ` ${workers.wallTimeMs}ms` : ''}` : '';
    const message = meta.message ?? meta.error ?? ev.message ?? '';
    const request = workers.event?.request;
    const reqLine = request?.url ? `\n      ${request.method ?? ''} ${request.url}` : '';
    const doLine = workers.durableObjectId ? `\n      do=${workers.durableObjectId}` : '';
    console.log(`${iso(ev.timestamp)} ${String(meta.level ?? '').padEnd(5)} ${where}${outcome}  ${String(message).replace(/\s+/g, ' ').slice(0, 600)}${reqLine}${doLine}`);
  }
  const count = result.events?.count ?? events.length;
  console.log(`\n${events.length} event(s) shown${count > events.length ? ` of ${count}` : ''}, ${iso(from)} → ${iso(to)}, worker ${workerName}${needle ? `, needle "${needle}"` : ''}${level ? `, level ${level}` : ''}`);
  if (events.length >= limit) console.log(`(hit --limit ${limit}; narrow the window or raise the limit)`);
}
