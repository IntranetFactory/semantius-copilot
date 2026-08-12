/**
 * Parallel field creation for the semantius-importer skill.
 *
 * Reads `./mapping.json` (schema-mapping.md section 8) and issues one
 * `semantius call crud create_field` per column with disposition "create",
 * with a concurrency pool of 5. Explicit `field_order` comes from the
 * mapping (increments of 10 - the platform preserves it, so creation order
 * and therefore parallelism carry no meaning).
 *
 * - Idempotent: live fields are read first; columns whose field_name already
 *   exists are skipped (safe re-run; read-before-create).
 * - Fail-fast: the first non-zero exit stops new launches, in-flight calls
 *   drain, and the run exits 1 with the result table below. Exit 5 (auth)
 *   aborts the same way and the script exits 5.
 * - Loud: every field gets a row in the final table - field, status
 *   (ok / failed / skipped-exists / not-run), exit code, first stderr line.
 *   No error is ever swallowed.
 *
 * Run (inside the run folder):
 *   bun run create-fields.ts            # create the fields
 *   bun run create-fields.ts --dry-run  # print the exact payloads, no writes
 */
import { readFileSync } from "node:fs";

type ColumnSpec = {
  header: string;
  field_name: string;
  format: string;
  empty_value?: string | number | boolean | null;
  bool_pair?: { true: string; false: string };
  disposition?: "create" | "exists" | "label" | "skip";
  reason?: string;
  title?: string;
  precision?: number;
  enum_values?: string[];
  input_type?: string;
  field_order?: number;
  reference_table?: string;
  reference_delete_mode?: string;
  unique_value?: boolean;
  searchable?: boolean;
  default_value?: string;
};

type Mapping = { table: string; columns: ColumnSpec[] };

const DRY_RUN = process.argv.includes("--dry-run");
const CONCURRENCY = 5;

const M: Mapping = JSON.parse(
  readFileSync(new URL("./mapping.json", import.meta.url), "utf8"),
);
const toCreate = M.columns.filter((c) => c.disposition === "create");

if (toCreate.length === 0) {
  console.log(`no columns with disposition "create" in mapping.json - nothing to do`);
  process.exit(0);
}

function titleCase(name: string): string {
  return name.split("_").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

function payloadFor(c: ColumnSpec): { data: Record<string, unknown> } {
  const data: Record<string, unknown> = {
    table_name: M.table,
    field_name: c.field_name,
    title: c.title ?? titleCase(c.field_name),
    format: c.format,
    width: "default",
    input_type: c.input_type ?? "default",
  };
  if (typeof c.field_order === "number") data.field_order = c.field_order;
  if (typeof c.precision === "number" && c.format === "number") data.precision = c.precision;
  if (c.enum_values) data.enum_values = c.enum_values;
  if (c.reference_table) {
    data.reference_table = c.reference_table;
    data.reference_delete_mode = c.reference_delete_mode ?? "restrict";
  }
  if (c.unique_value) data.unique_value = true;
  if (c.searchable) data.searchable = true;
  if (c.default_value !== undefined) data.default_value = c.default_value;
  return { data };
}

async function call(tool: string, payload: unknown): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["semantius", "call", "crud", tool], {
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

if (DRY_RUN) {
  for (const c of toCreate) console.log(JSON.stringify(payloadFor(c), null, 2));
  console.error(`dry run: ${toCreate.length} create_field payload(s) for table "${M.table}", nothing written`);
  process.exit(0);
}

// Idempotency: skip field names that already exist on the live entity.
const live = await call("read_field", { filters: `table_name=eq.${M.table}` });
if (live.code !== 0) {
  console.error(`read_field failed (exit ${live.code}) - refusing to create blind:\n${live.stderr || live.stdout}`);
  process.exit(live.code === 5 ? 5 : 1);
}
const existing = new Set(
  (JSON.parse(live.stdout) as { field_name: string }[]).map((f) => f.field_name),
);

type Result = { status: "ok" | "failed" | "skipped-exists" | "not-run"; code?: number; error?: string };
const results = new Map<string, Result>();
const queue: ColumnSpec[] = [];

for (const c of toCreate) {
  if (existing.has(c.field_name)) results.set(c.field_name, { status: "skipped-exists" });
  else queue.push(c);
}

let stopped = false;
let authFailure = false;

async function worker(): Promise<void> {
  for (;;) {
    if (stopped) return;
    const c = queue.shift();
    if (!c) return;
    const res = await call("create_field", payloadFor(c));
    if (res.code === 0) {
      results.set(c.field_name, { status: "ok" });
      console.error(`  ok       ${c.field_name}`);
    } else {
      const firstLine = (res.stderr || res.stdout).split("\n").find((l) => l.trim()) ?? "";
      results.set(c.field_name, { status: "failed", code: res.code, error: firstLine });
      console.error(`  FAILED   ${c.field_name} (exit ${res.code}): ${firstLine}`);
      stopped = true; // fail fast: no new launches, in-flight calls drain
      if (res.code === 5) authFailure = true;
    }
  }
}

await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
for (const c of queue) results.set(c.field_name, { status: "not-run" });

// Compact result table, one row per requested field, in mapping order.
const w = Math.max(...toCreate.map((c) => c.field_name.length), 5);
console.log(`\n${"field".padEnd(w)}  status          exit  error`);
for (const c of toCreate) {
  const r = results.get(c.field_name)!;
  console.log(
    `${c.field_name.padEnd(w)}  ${r.status.padEnd(14)}  ${String(r.code ?? "").padEnd(4)}  ${(r.error ?? "").slice(0, 120)}`,
  );
}

const counts = { ok: 0, "failed": 0, "skipped-exists": 0, "not-run": 0 } as Record<string, number>;
for (const r of results.values()) counts[r.status] += 1;
console.log(`\n${counts.ok} created, ${counts["skipped-exists"]} already existed, ${counts.failed} failed, ${counts["not-run"]} not run`);

if (authFailure) process.exit(5);
if (counts.failed > 0 || counts["not-run"] > 0) process.exit(1);
