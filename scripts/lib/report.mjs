/**
 * Structured test reporting, shared by every suite in scripts/.
 *
 * WHY: a test run's result has to be readable by whoever (or whatever) reads it
 * next — a human scrolling, CI, or an agent that only sees the last lines of a
 * long output. Prose on stdout serves none of them reliably: the interesting
 * line scrolls away, and patching that with "repeat the failures at the end,
 * capped, truncated" is a workaround stacked on a workaround.
 *
 * So the console output is DECORATION and this file is the RECORD. Each run
 * writes one NDJSON file — one JSON object per line, in order:
 *
 *   {"type":"run","suite":"acceptance","startedAt":"…","target":"https://…"}
 *   {"type":"check","seq":1,"id":"health","name":"backend healthy","ok":true,"detail":"…"}
 *   …
 *   {"type":"summary","total":61,"failures":0,"ok":true,"endedAt":"…"}
 *
 * Two properties fall out of that shape, both of which the old prose format
 * could not give:
 *
 *  - **Append-per-check, not buffered.** A crash mid-suite still leaves every
 *    check that ran on disk.
 *  - **A missing `summary` line MEANS aborted.** Completion is a positive fact
 *    in the record, so a truncated run can never be mistaken for a clean one —
 *    no heuristics, no "did I read enough lines".
 *
 * Read it with `pnpm report` (scripts/report.mjs), which is the only thing that
 * needs to know this layout. Nothing greps stdout.
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** Where run records live: gitignored, one file per suite, overwritten per run. */
export const REPORTS_DIR = join(here, '..', '..', '.reports');

/** The NDJSON path for one suite. */
export function reportPath(suite) {
  return join(REPORTS_DIR, `${suite}.ndjson`);
}

/**
 * Start a run record. Returns the recorder the suite calls per check, plus
 * `finish()` for the exit path.
 *
 * @param {string} suite file-safe suite name (`acceptance`, `unit`)
 * @param {Record<string, unknown>} [meta] extra run-header fields (e.g. target URL)
 */
export function startRun(suite, meta = {}) {
  const path = reportPath(suite);
  let writable = true;
  try {
    mkdirSync(REPORTS_DIR, { recursive: true });
    writeFileSync(path, ''); // truncate: the file is THIS run, not a log tail
  } catch {
    // A read-only checkout still runs the suite; it just loses the record.
    writable = false;
  }
  const write = (record) => {
    if (!writable) return;
    try {
      appendFileSync(path, `${JSON.stringify(record)}\n`);
    } catch {
      writable = false;
    }
  };

  write({ type: 'run', suite, startedAt: new Date().toISOString(), ...meta });

  let total = 0;
  let failures = 0;

  return {
    path,
    get total() { return total; },
    get failures() { return failures; },

    /**
     * Record one check. `detail` is stored WHOLE — truncation is a display
     * concern, and the reader decides, not the writer.
     */
    check({ id = '', name, ok, detail = '' }) {
      total += 1;
      if (!ok) failures += 1;
      write({ type: 'check', seq: total, id, name, ok: Boolean(ok), detail: String(detail) });
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${id ? `[${id}] ` : ''}${name}${detail ? ` — ${detail}` : ''}`);
    },

    /** Record the abort of a run that threw before finishing. */
    aborted(err) {
      write({ type: 'abort', error: String(err).slice(0, 2000), at: new Date().toISOString() });
    },

    /**
     * Close the record and print the one line stdout is actually good for: the
     * verdict, and where to read the details. No cap, no truncation, no repeat
     * — `pnpm report` renders the file.
     */
    finish() {
      write({ type: 'summary', total, failures, ok: failures === 0, endedAt: new Date().toISOString() });
      const verdict = failures === 0 ? `PASS  ${total}/${total} checks` : `FAIL  ${failures}/${total} checks failed`;
      console.log(`\n${suite}: ${verdict}   →  pnpm report ${suite}`);
      return failures === 0 ? 0 : 1;
    },
  };
}
