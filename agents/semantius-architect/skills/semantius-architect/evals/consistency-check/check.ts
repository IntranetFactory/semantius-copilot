#!/usr/bin/env bun
/**
 * Fixture check for the architect's `consistency-check.ts`.
 *
 * Offline (no Semantius instance needed). Every `fixture-*.md` in this folder is run through
 * the checker's CLI, one file per run (`bun consistency-check.ts <fixture>`), and the issues it
 * prints are compared with the fixture's `expected-*.json`:
 *
 *  - each expected entry `{ "check", "detail", "warn"? }` matches exactly one printed issue with
 *    the same check name, the same severity (`✗` error, or `⚠` warning when `warn` is true) and
 *    a detail that contains the expected `detail` substring;
 *  - no printed issue is left unmatched;
 *  - the checker exits 0 when no error is expected and 1 otherwise.
 *
 * Usage:  bun evals/consistency-check/check.ts
 * Exit 0 = every fixture matches; 1 = at least one mismatch (details on stdout).
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const here = import.meta.dir;
const checker = resolve(here, "../../references/consistency-check.ts");

type Issue = { check: string; detail: string; warn?: boolean };

let failures = 0;
const fail = (msg: string) => { failures++; console.log(`  ✗ ${msg}`); };
const ok = (msg: string) => console.log(`  ✓ ${msg}`);

async function run(cmd: string[]): Promise<{ code: number; out: string; err: string }> {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, out, err };
}

/** The issues of one checker run: `  ✗ <check>` / `  ⚠ <check>` headings, each followed by `      - <detail>` lines. */
function printedIssues(out: string): Issue[] {
  const issues: Issue[] = [];
  let cur: { check: string; warn: boolean } | null = null;
  for (const line of out.split(/\r?\n/)) {
    const h = line.match(/^ {2}([✗⚠]) (.+)$/);
    if (h) { cur = { check: h[2].trim(), warn: h[1] === "⚠" }; continue; }
    const d = line.match(/^ {6}- (.*)$/);
    if (d && cur) { issues.push({ ...cur, detail: d[1] }); continue; }
    const e = line.match(/^ {2}\[ERROR\] (.*)$/);
    if (e) issues.push({ check: "[ERROR]", detail: e[1] });
    cur = null;
  }
  return issues;
}

const show = (i: Issue) => `${i.warn ? "⚠" : "✗"} ${i.check}: ${i.detail}`;

const fixtures = readdirSync(here).filter((f) => /^fixture-.*\.md$/.test(f)).sort();
console.log(`consistency-check fixtures: ${fixtures.length} fixture(s)`);
for (const fx of fixtures) {
  const name = fx.replace(/^fixture-/, "").replace(/\.md$/, "");
  const expectedPath = join(here, `expected-${name}.json`);
  let expected: Issue[];
  try {
    expected = JSON.parse(readFileSync(expectedPath, "utf8"));
  } catch (err) {
    fail(`${fx}: cannot read ${expectedPath} (${(err as Error).message})`);
    continue;
  }
  const r = await run(["bun", checker, join(here, fx)]);
  if (r.err.trim()) fail(`${fx}: checker wrote to stderr\n${r.err}`);
  const printed = printedIssues(r.out);
  const used = new Set<number>();
  let mismatches = 0;
  for (const want of expected) {
    const i = printed.findIndex((got, n) => !used.has(n) && got.check === want.check && !!got.warn === !!want.warn && got.detail.includes(want.detail));
    if (i < 0) { mismatches++; fail(`${fx}: expected issue not reported: ${show(want)}`); continue; }
    used.add(i);
  }
  printed.forEach((got, n) => {
    if (!used.has(n)) { mismatches++; fail(`${fx}: unexpected issue: ${show(got)}`); }
  });
  const wantCode = expected.some((i) => !i.warn) ? 1 : 0;
  if (r.code !== wantCode) { mismatches++; fail(`${fx}: checker exited ${r.code}, expected ${wantCode}`); }
  if (!mismatches) {
    const errors = expected.filter((i) => !i.warn).length, warnings = expected.length - errors;
    ok(`${fx}: ${errors} error(s), ${warnings} warning(s) as expected (exit ${r.code})`);
  }
}

console.log(failures ? `\nRESULT: ${failures} failure(s)` : "\nRESULT: all green");
process.exit(failures ? 1 : 0);
