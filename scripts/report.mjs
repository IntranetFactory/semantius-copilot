#!/usr/bin/env node
/**
 * Read a suite's run record (`pnpm report [suite …]`).
 *
 * The counterpart to scripts/lib/report.mjs: that writes NDJSON, this is the
 * ONE parser of it. Suites print a verdict line; anything more detailed comes
 * from here, so nobody greps stdout or guesses how many lines to tail.
 *
 * Output is the whole truth about the run, in a fixed order:
 *   header (suite, target, when) → every failure IN FULL → the verdict.
 * Exit code: 0 all passed, 1 failures or an incomplete run, 2 no record.
 *
 *   pnpm report                # every suite that has a record
 *   pnpm report acceptance     # one suite
 *   pnpm report --failures     # failure lines only (for piping)
 */
import { readdirSync, readFileSync } from 'node:fs';

import { REPORTS_DIR, reportPath } from './lib/report.mjs';

const args = process.argv.slice(2);
const failuresOnly = args.includes('--failures');
const suites = args.filter((a) => !a.startsWith('--'));

/** Parse one NDJSON record file. Malformed lines are surfaced, never skipped silently. */
function readRun(suite) {
  let text;
  try {
    text = readFileSync(reportPath(suite), 'utf-8');
  } catch {
    return null;
  }
  const records = [];
  const malformed = [];
  for (const [i, line] of text.split('\n').entries()) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      malformed.push(i + 1);
    }
  }
  return {
    suite,
    header: records.find((r) => r.type === 'run') ?? null,
    checks: records.filter((r) => r.type === 'check'),
    abort: records.find((r) => r.type === 'abort') ?? null,
    summary: records.find((r) => r.type === 'summary') ?? null,
    malformed,
  };
}

function discoverSuites() {
  try {
    return readdirSync(REPORTS_DIR)
      .filter((f) => f.endsWith('.ndjson'))
      .map((f) => f.slice(0, -'.ndjson'.length))
      .sort();
  } catch {
    return [];
  }
}

const wanted = suites.length > 0 ? suites : discoverSuites();
if (wanted.length === 0) {
  console.error(`no run records in ${REPORTS_DIR} — run a suite first (pnpm test / pnpm acceptance)`);
  process.exit(2);
}

let exitCode = 0;
for (const suite of wanted) {
  const run = readRun(suite);
  if (!run) {
    console.error(`${suite}: no record at ${reportPath(suite)}`);
    exitCode = Math.max(exitCode, 2);
    continue;
  }
  const failed = run.checks.filter((c) => !c.ok);

  if (!failuresOnly) {
    const target = run.header?.target ? ` · ${run.header.target}` : '';
    console.log(`\n${suite}${target} · ran ${run.header?.startedAt ?? '(unknown time)'}`);
  }

  for (const c of failed) {
    console.log(`FAIL  ${c.id ? `[${c.id}] ` : ''}${c.name}${c.detail ? `\n      ${c.detail}` : ''}`);
  }

  if (failuresOnly) {
    if (failed.length > 0) exitCode = 1;
    continue;
  }

  // A run is complete ONLY if it wrote a summary. Anything else is a partial
  // record — reported as such, never rounded down to "the checks that ran passed".
  if (!run.summary) {
    const lastCheck = run.checks.at(-1);
    console.log(
      `INCOMPLETE  no summary record — the run died after ${run.checks.length} check(s)` +
        (lastCheck ? `, last: ${lastCheck.name}` : ''),
    );
    if (run.abort) console.log(`ABORTED  ${run.abort.error}`);
    exitCode = 1;
    continue;
  }
  if (run.malformed.length > 0) {
    console.log(`WARNING  ${run.malformed.length} malformed record line(s): ${run.malformed.join(', ')}`);
    exitCode = Math.max(exitCode, 1);
  }
  console.log(
    run.summary.ok
      ? `PASS  ${run.summary.total}/${run.summary.total} checks`
      : `FAIL  ${run.summary.failures}/${run.summary.total} checks failed`,
  );
  if (!run.summary.ok) exitCode = 1;
}

process.exit(exitCode);
