# Import Script Template

The generated import script: a Bun (TypeScript) one-shot that streams the CSV with `csv-parse`, coerces per `mapping.json`, and bulk-inserts uniform-key batches through `semantius call crud postgrestRequest`. Python is not used in this skill; Bun runs identically on every platform.

## Workspace layout

Every import run gets its own scratch folder in the **OS temp directory**. Resolve it portably with Bun (never a shell-literal `/tmp` or `$TMPDIR`, which resolve inconsistently across shells on Windows):

```bash
bun -e 'console.log(require("node:os").tmpdir())'
```

```
<os-tmpdir>/semantius-import/run-<yyyymmdd-hhmmss>/
├── package.json          # {"dependencies": {"csv-parse": "^6"}} — created by `bun add csv-parse`
├── mapping.json          # the approved mapping (schema-mapping.md section 8)
├── <file>.csvschema.json # copied introspection output
├── import.ts             # generated from the template below
├── failed-batches.json   # written only when something fails
└── import-summary.json   # written at the end of every run
```

Setup commands (run inside the run folder):

```bash
cd "<os-tmpdir>/semantius-import/run-<ts>" && bun add csv-parse
bun run import.ts <absolute-path-to>/<file>.csv
```

The workspace never goes into the user's project, the CSV's folder, or the skill folder; it is disposable scratch outside anything the user tracks. Always report the run folder's **absolute path** in the final summary so the user can open `failed-batches.json` and `import-summary.json` directly. Re-running an import for the same table: prefer updating `mapping.json` / CONFIG in the existing run folder over generating a fresh one, so `failed-batches.json` history stays in one place.

## Design rules the generated script must keep

1. **Stream, never slurp.** `csv-parse`'s async iterator with `{columns: true, bom: true, skip_empty_lines: true}`. `columns: true` keys each row by raw header, matching `mapping.json`'s `header` keys. Works on multi-GB files.
<!-- DEFERRED — id preservation (re-enable with the fix_id_sequence RPC; see README):
1b. The `id` entry, when present, is an ordinary mapped column targeting the platform primary key. It appears exactly once in MAPPING — a moved column ("header": "customer_id", "field_name": "id") never also maps to its own field. When ids are preserved, NATURAL_KEY defaults to "id", and the script calls POST /rpc/fix_id_sequence {"p_table": TABLE} after the last batch.
-->
1a. **The primary key never travels (hard guard).** While id preservation is deferred, the script strips the entity's primary key column from **every** outgoing payload — insert batches and PATCH bodies alike — silently and unconditionally, after coercion. `ID_COLUMN` is **not** assumed to be `id`: it is copied from the target entity's `id_column` property (`read_entity`) at generation time; the platform default is `id` but any entity can carry a custom name. This is a runtime safety net, not a mapping convention: even a mapping that wrongly targets the primary key cannot reintroduce explicit-id inserts and the sequence desync they cause.
1b. **Write modes.** With `NATURAL_KEY` set, `ON_EXISTS` decides what happens to rows whose key already exists: `"insert"` skips them (counted `skipped`); `"update"` synchronizes them — the preload fetches the mapped fields too, rows whose coerced CSV values equal the live values are untouched (counted `unchanged`), differing rows are updated with a per-row `PATCH` (counted `updated`). Update mode requires the key field to be unique. A key seen twice in the same file sends the second row to the failed capture (`duplicate key in file`) — deterministic, never last-wins.
2. **Uniform keys.** Every record object carries every non-skipped mapped field, empties filled from `empty_value`. PostgREST rejects heterogeneous arrays with `PGRST102`.
3. **Stdin transport.** The batch payload is piped to the CLI via stdin (`Bun.spawn` with `stdin: "pipe"`); no inline JSON argument, so Windows argument-length limits and shell quoting never apply. The interactive "always pass inline JSON" gotcha is about a human shell with an empty stdin; a script that pipes and closes stdin is the documented preferred form.
4. **Batches of 250 by default** (`BATCH_SIZE`, sane range 200 to 500) for inserts. Do not send a `prefer` key: the current server strips it and always uses `Prefer: return=representation` (the tool returns a `{request, response}` envelope; the script ignores it on success). Batched upsert (`resolution=merge-duplicates`) becomes possible once the MCP passes `prefer` through — see the README roadmap; until then updates go per-row via `PATCH`.
5. **Exit-code-aware error handling.** Exit 3 (transient, CLI retries already exhausted) retries the batch up to 3 times with 1s/3s/9s backoff. Exit 5 (auth) aborts immediately. Exit 4 or anything else captures the batch (index, row range, stderr, rows) into `failed-batches.json` and continues; the run ends with exit 1 if anything failed.
6. **Row-level validation before batching, coercion by exception.** The coercion switch handles only the families that genuinely need it (`integer`/`number` parse, `boolean` via `bool_pair`, `date`/`date-time` validation); its `default` branch passes every other format through verbatim, so `email`, `url`, and any future format flow untouched (server-side validation failures land in the batch-level capture). A cell that cannot coerce (unparseable number, unknown bool token, invalid date) sends the whole row to the failed capture with a reason instead of poisoning its batch. `ColumnSpec.format` is a plain `string` — known values are a comment, never a closed union the script enforces.
7. **Preload doubles as the diff source.** With `NATURAL_KEY` set, page `GET /<table>?select=<key>,<mapped fields>&order=<key>&limit=1000&offset=N` until a short page, building a map of key → live values. Insert mode uses only the key set; update mode compares coerced CSV values field-by-field against the live values (strict equality after coercion, so `"1"` vs `1` is not a change) to decide untouched vs `PATCH`. Without a natural key the script is a plain insert; re-running it duplicates rows and the script says so in its banner.
8. **Progress on stderr, summary on stdout.** One line per batch (`batch 12/40 ok - 3000/9873 rows`) and a periodic update-progress line in update mode; the final line of stdout is the JSON summary (`parsed / inserted / updated / unchanged / skipped / failed / ...`), also written to `import-summary.json`, so the calling skill parses one object.
9. **Built-in count verify.** After the last batch the script compares the server row count (`GET /<table>?select=count`, reading `[{"count": N}]`) against `preexisting + inserted` and exits non-zero on mismatch. Skipped and failed rows are excluded from the expectation.

## The template

Placeholders in `<...>` are filled at generation time from `mapping.json` and the run decisions.

```typescript
/**
 * Batched CSV import into Semantius table "<table>".
 * Generated by the semantius-importer skill. One-shot; safe to re-run only
 * with NATURAL_KEY set (otherwise re-running duplicates rows).
 *
 * Run: bun run import.ts <absolute-path-to-csv>
 */
import { parse } from "csv-parse";
import { createReadStream, writeFileSync } from "node:fs";

// ---------------------------------------------------------------- CONFIG --
const TABLE = "<table>";
const BATCH_SIZE = 250;
// A mapped field name (unique via unique_value: true for update mode), or
// null (plain insert; re-running duplicates rows).
const NATURAL_KEY: string | null = <"<field>" | null>;
// What happens to rows whose NATURAL_KEY already exists (mapping.json on_exists):
// "insert" skips them, "update" synchronizes them (diff, then PATCH changed rows).
const ON_EXISTS: "insert" | "update" = <"update" | "insert">;
// The entity's primary key column, copied from the LIVE entity's id_column
// property at generation time (read_entity; default "id", but customizable
// per entity - never assume the literal "id" for existing targets). Stripped
// from every payload (hard guard, rule 1a) while id preservation is deferred.
const ID_COLUMN = "<id_column from the target entity>";
// record_count from the introspection wrapper; null when the scan was capped.
const EXPECTED_RECORDS: number | null = <record_count | null>;
const MAPPING: ColumnSpec[] = <inlined non-skipped columns from mapping.json>;

type ColumnSpec = {
  header: string;                       // raw CSV header (row key)
  field_name: string;                   // Semantius field name (payload key); "id" targets the PK
  // Open set - e.g. "string", "multiline", "integer", "number", "date",
  // "date-time", "boolean", "enum", "reference", "email", "url". Formats the
  // coercion switch does not know pass through verbatim.
  format: string;
  empty_value: string | number | boolean | null;
  bool_pair?: { true: string; false: string };
};

const CSV_PATH = process.argv[2];
if (!CSV_PATH) { console.error("usage: bun run import.ts <csv-path>"); process.exit(1); }

// ------------------------------------------------------------- transport --
async function pgRequest(payload: unknown): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["semantius", "call", "crud", "postgrestRequest"], {
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  proc.stdin.write(JSON.stringify(payload));
  proc.stdin.end();
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, stdout, stderr };
}

async function postBatch(rows: Record<string, unknown>[], attempt = 1): Promise<{ ok: boolean; error?: string }> {
  // No prefer key: the server strips it and always answers with the representation envelope.
  const res = await pgRequest({ method: "POST", path: `/${TABLE}`, body: rows });
  if (res.code === 0) return { ok: true };
  if (res.code === 5) { console.error(`auth failure, aborting:\n${res.stderr}`); process.exit(5); }
  if (res.code === 3 && attempt <= 3) {
    const delay = 1000 * 3 ** (attempt - 1);
    console.error(`  transient failure, retry ${attempt}/3 in ${delay / 1000}s`);
    await new Promise((r) => setTimeout(r, delay));
    return postBatch(rows, attempt + 1);
  }
  return { ok: false, error: res.stderr || res.stdout };
}

async function serverCount(): Promise<number> {
  const res = await pgRequest({ method: "GET", path: `/${TABLE}?select=count` });
  if (res.code !== 0) { console.error(`count read failed:\n${res.stderr}`); process.exit(1); }
  return JSON.parse(res.stdout)[0].count;
}

// -------------------------------------------------------------- coercion --
function coerce(spec: ColumnSpec, raw: string | undefined): { ok: boolean; value?: unknown; reason?: string } {
  const v = (raw ?? "").trim();
  if (v === "") return { ok: true, value: spec.empty_value };
  switch (spec.format) {
    case "integer": {
      if (!/^[+-]?\d+$/.test(v)) return { ok: false, reason: `not an integer: "${v}"` };
      return { ok: true, value: Number.parseInt(v, 10) };
    }
    case "number": {
      const n = Number.parseFloat(v);
      if (Number.isNaN(n)) return { ok: false, reason: `not a number: "${v}"` };
      return { ok: true, value: n };
    }
    case "boolean": {
      const p = spec.bool_pair;
      if (p) {
        if (v.toLowerCase() === p.true.toLowerCase()) return { ok: true, value: true };
        if (v.toLowerCase() === p.false.toLowerCase()) return { ok: true, value: false };
      }
      return { ok: false, reason: `unknown boolean token: "${v}"` };
    }
    case "date":
    case "date-time": {
      if (Number.isNaN(Date.parse(v))) return { ok: false, reason: `invalid date: "${v}"` };
      return { ok: true, value: v };
    }
    default:
      return { ok: true, value: v }; // string / multiline / enum / reference pass through
  }
}

// ------------------------------------------------------------------ main --
const failed: { batchIndex: number; rowRange?: string; row?: unknown; error: string }[] = [];
let parsed = 0, inserted = 0, updated = 0, unchanged = 0, skipped = 0, rowFailed = 0;

// key -> live row (mapped fields only). Insert mode only needs the keys;
// update mode diffs CSV values against these to avoid pointless writes.
const liveRows = new Map<string, Record<string, unknown>>();
if (NATURAL_KEY) {
  const fields = [...new Set([NATURAL_KEY, ...MAPPING.map((m) => m.field_name)])].join(",");
  let offset = 0;
  for (;;) {
    const res = await pgRequest({ method: "GET", path: `/${TABLE}?select=${fields}&order=${NATURAL_KEY}&limit=1000&offset=${offset}` });
    if (res.code !== 0) { console.error(`natural-key preload failed:\n${res.stderr}`); process.exit(1); }
    const page = JSON.parse(res.stdout) as Record<string, unknown>[];
    for (const r of page) liveRows.set(String(r[NATURAL_KEY]), r);
    if (page.length < 1000) break;
    offset += 1000;
  }
  console.error(`natural key "${NATURAL_KEY}": ${liveRows.size} existing rows loaded (${ON_EXISTS} mode)`);
}
const preexisting = await serverCount();

function sameValues(live: Record<string, unknown>, next: Record<string, unknown>): boolean {
  return MAPPING.every((m) => {
    const a = live[m.field_name] ?? null;
    const b = next[m.field_name] ?? null;
    return a === b || String(a) === String(b);
  });
}

async function patchRow(key: string, row: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> {
  const path = `/${TABLE}?${NATURAL_KEY}=eq.${encodeURIComponent(key)}`;
  const res = await pgRequest({ method: "PATCH", path, body: row });
  if (res.code === 0) return { ok: true };
  if (res.code === 5) { console.error(`auth failure, aborting:\n${res.stderr}`); process.exit(5); }
  return { ok: false, error: res.stderr || res.stdout };
}

const parser = createReadStream(CSV_PATH).pipe(
  parse({ columns: true, bom: true, skip_empty_lines: true }),
);

let batch: Record<string, unknown>[] = [];
let batchIndex = 0;

async function flush() {
  if (batch.length === 0) return;
  batchIndex += 1;
  const rows = batch;
  batch = [];
  const res = await postBatch(rows);
  if (res.ok) {
    inserted += rows.length;
    console.error(`batch ${batchIndex} ok - ${inserted}/${parsed} rows inserted`);
  } else {
    rowFailed += rows.length;
    failed.push({ batchIndex, rowRange: `${parsed - rows.length + 1}-${parsed}`, error: res.error!, row: rows });
    console.error(`batch ${batchIndex} FAILED (${rows.length} rows captured): ${res.error!.slice(0, 200)}`);
  }
}

const seenInFile = new Set<string>();

for await (const record of parser) {
  parsed += 1;
  const out: Record<string, unknown> = {};
  let bad: string | null = null;
  for (const spec of MAPPING) {
    const c = coerce(spec, record[spec.header]);
    if (!c.ok) { bad = `${spec.field_name}: ${c.reason}`; break; }
    out[spec.field_name] = c.value;
  }
  if (bad) {
    rowFailed += 1;
    failed.push({ batchIndex: -1, row: record, error: bad });
    continue;
  }
  // Hard guard (rule 1a): the primary key never travels while id
  // preservation is deferred - silently dropped, whatever the mapping says.
  delete out[ID_COLUMN];
  if (NATURAL_KEY) {
    const key = String(out[NATURAL_KEY]);
    if (seenInFile.has(key)) {
      rowFailed += 1;
      failed.push({ batchIndex: -1, row: record, error: `${NATURAL_KEY}: duplicate key in file: "${key}"` });
      continue;
    }
    seenInFile.add(key);
    const live = liveRows.get(key);
    if (live) {
      if (ON_EXISTS === "insert") { skipped += 1; continue; }
      if (sameValues(live, out)) { unchanged += 1; continue; }
      const res = await patchRow(key, out);
      if (res.ok) {
        updated += 1;
        if (updated % 50 === 0) console.error(`updated ${updated} rows so far - ${parsed} parsed`);
      } else {
        rowFailed += 1;
        failed.push({ batchIndex: -1, row: record, error: `PATCH failed: ${res.error}` });
      }
      continue;
    }
  }
  batch.push(out);
  if (batch.length >= BATCH_SIZE) await flush();
}
await flush();

// ---------------------------------------------------------------- verify --
const finalCount = await serverCount();
const expected = preexisting + inserted;
const summary = {
  table: TABLE, parsed, inserted, updated, unchanged, skipped, failed: rowFailed,
  preexisting, finalCount, countMatches: finalCount === expected,
  expectedRecords: EXPECTED_RECORDS,
  recordCountMatches: EXPECTED_RECORDS === null || parsed === EXPECTED_RECORDS,
};
writeFileSync("import-summary.json", JSON.stringify(summary, null, 2));
if (failed.length > 0) writeFileSync("failed-batches.json", JSON.stringify(failed, null, 2));
console.log(JSON.stringify(summary));
if (!summary.recordCountMatches) console.error(`RECORD COUNT MISMATCH: introspection saw ${EXPECTED_RECORDS} records, parser saw ${parsed} - investigate delimiters/embedded newlines`);
if (!summary.countMatches) { console.error(`COUNT MISMATCH: expected ${expected}, server has ${finalCount}`); process.exit(1); }
if (failed.length > 0) process.exit(1);
```

## Generation-time checklist

- [ ] `MAPPING` contains **only** non-skipped columns; the label column **is** present; reserved columns are renamed or absent per the mapping decisions. No `field_name: "id"` entry (id preservation is deferred; the runtime guard in rule 1a strips `ID_COLUMN` regardless, but the mapping must still not target it).
- [ ] Digit-leading field names were renamed during the review.
- [ ] Every `boolean` column carries its `bool_pair` from the mapping.
- [ ] `NATURAL_KEY` is a **field name** that exists in `MAPPING`, or `null`.
- [ ] `ON_EXISTS` matches the mapping review's `on_exists` decision; `"update"` only when the key field is unique (`unique_value: true`).
- [ ] `ID_COLUMN` equals the target entity's live `id_column` (from `read_entity`; `id` only for entities this skill just created, which leave the platform default in place).
- [ ] `EXPECTED_RECORDS` carries the introspection's `record_count` on full scans, `null` when the scan was capped.
- [ ] When the diff chose coerce-into-live for a mismatched column, the `ColumnSpec.format` is the **live** field's format, so validation routes incompatible rows to the failed capture.
- [ ] The banner comment names the table and states the re-run stance.
- [ ] After a successful run, report the summary with the run folder's absolute path and leave the folder in place (the user may want `failed-batches.json` and `import-summary.json`); the OS cleans its temp directory on its own schedule.
