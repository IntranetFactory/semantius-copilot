#!/usr/bin/env bun
/**
 * seed-lib.ts — the fixed helpers for a sample-data seed script. Copy it next to the
 * script and import it; never retype it (`references/seed-data.md` shows how).
 *
 * One command, two passes: `bun run <script>` runs the script's body as a check pass, which records
 * every write and sends none, and then, only when the check pass passed, as the real pass. A halt in the
 * check pass sent nothing. `--check` (or `SEED_CHECK=1`) runs the check pass alone.
 *
 * What it enforces:
 *   - Rows are checked against the platform's description of their table before anything is sent, in both
 *     passes: every column is a field, no column the platform writes is sent (an approval stamp on a row
 *     past its step excepted), required fields carry a value, an enum gets one of its values (never a
 *     label), `null` goes only where the format takes it, a row at or past an approval carries its stamps,
 *     its approver is not the user running the seed, and that user may create and read what is seeded.
 *     The tables' descriptions are read once per module.
 *   - Failure is loud: a non-zero exit from `semantius`, a short RETURNING, rows with different keys, a
 *     wrong count, a child that names the wrong parent, or a stored row that differs from the plan all
 *     THROW, and `runSeed` turns any thrown error into a non-zero exit naming the script line.
 *   - Ids are never typed and never taken from an insert response by position: a parent is re-read by its
 *     key (`idsByKey`) and a child names its parent by that key. `assertParents` then reads every child
 *     back with its `<fk>_label` and compares it with the parent the script meant.
 *   - The key is the table's label column when the seed sends it. Otherwise (the platform computes the
 *     label, or the table is a junction) each planned row carries `_ref`, a name that is never sent, and the
 *     stored rows are matched on the values the rows send.
 *   - Numbers fit the rows (`assertItemized`), states agree (`assertStatesAgree`), computed and rollup
 *     columns move (`assertComputedVary`), rows past an approval carry their stamps (`assertStamped`).
 *   - One call per table: `postMany` sends a whole table in one `postgrestRequest` POST (array `body`, at
 *     most `BATCH_SIZE` rows per call). A failed call landed nothing.
 *   - Sample email addresses never reach a real inbox: any address that is not at a subdomain of
 *     example.com is refused.
 *
 * CLI: `bun seed-lib.ts --describe <table>[,<table>…]` prints what a seed of each table sends.
 *
 * Import it:
 *   import { postMany, seedEnsureMany, idsByKey, assertParents, assertJunction, assertItemized, assertStatesAgree, assertStamped, assertComputedVary, assertSeedCounts, assertSeedDistinct,
 *            readRows, seedUser, rng, days, at, uniq, slugify, exampleDomain, patchById, clearSeeded, runSeed } from "./seed-lib";
 */

import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";

type Row = Record<string, unknown>;

/** The key of a table whose rows carry a planned name instead of a key column: `seedEnsureMany(path, rows, "_ref")`. */
export const REF = "_ref";

let writeCount = 0;
let clearStarted = false;   // this pass called clearSeeded
let rowsInserted = false;   // this pass sent an insert

/** Count of write calls so far in this pass (a bulk call counts once). */
export const writes = (): number => writeCount;

// ─────────────────────────────── passes ───────────────────────────────

type Mode = "check" | "real";
let mode: Mode | undefined;   // set by runSeed; outside it (tests), --check / SEED_CHECK decide
let quiet = false;            // the check pass of a one-command run prints only its halt and one summary line

const checkOnlyAsked = (): boolean => process.env.SEED_CHECK === "1" || process.argv.slice(2).includes("--check");

/** True in the check pass: writes are recorded, never sent. */
export const isCheckRun = (): boolean => (mode ? mode === "check" : checkOnlyAsked());

/** Prefix for a success line, so a check run never reads like a seeded table. */
const tag = (): string => (isCheckRun() ? "[check run] " : "");
const say = (line: string): void => { if (!quiet) console.log(line); };

const SELF_PATH = String((import.meta as { path?: string }).path ?? "seed-lib.ts");
const SELF = SELF_PATH.replace(/\\/g, "/").toLowerCase();
let lastSite = "";
let lastFrame: { path: string; line: number } | undefined;

/** This file's path as the user runs it from the repo root (`.tmp_deploy/seed-lib.ts`). */
const libPath = (): string => {
  const rel = relative(process.cwd(), SELF_PATH).replace(/\\/g, "/");
  return rel && !rel.startsWith("..") ? rel : SELF_PATH.replace(/\\/g, "/");
};

/** The first frame of `stack` outside this file: the script file and line. */
function scriptFrameOf(stack: string): { path: string; line: number } | undefined {
  for (const line of stack.split("\n").slice(1)) {
    const m = line.match(/((?:[A-Za-z]:)?[^\s()]+\.(?:ts|js|mjs|tsx)):(\d+)(?::\d+)?/);
    if (!m) continue;
    const file = m[1].replace(/\\/g, "/");
    const lower = file.toLowerCase();
    if (lower === SELF || lower.endsWith("/seed-lib.ts")) continue;
    return { path: m[1].startsWith("file:") ? fileURLToPath(m[1]) : m[1], line: Number(m[2]) };
  }
  return undefined;
}

/** The first frame of `stack` outside this file, as `<file>:<line>`; "" when there is none. */
function scriptFrame(stack: string): string {
  const f = scriptFrameOf(stack);
  return f ? `${f.path.replace(/\\/g, "/").split("/").pop()}:${f.line}` : "";
}

/** Remembers the script line that called the current helper, so a halt names it and shows it. */
function site(): void {
  const f = scriptFrameOf(new Error().stack ?? "");
  if (f) { lastFrame = f; lastSite = `${f.path.replace(/\\/g, "/").split("/").pop()}:${f.line}`; }
}

/**
 * The statement at `frame` as the file holds it now, numbered: from its line until its brackets close (at most 30
 * lines), so an edit copies its old text from the file, never from memory. "" when the file cannot be read.
 */
function callSource(frame: { path: string; line: number }): string {
  let text: string;
  try { text = readFileSync(frame.path, "utf8"); } catch { return ""; }
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  let depth = 0;
  for (let i = frame.line - 1; i >= 0 && i < lines.length && out.length < 30; i++) {
    out.push(`${String(i + 1).padStart(5)}  ${lines[i]}`);
    depth += (lines[i].match(/[([{]/g) ?? []).length - (lines[i].match(/[)\]}]/g) ?? []).length;
    if (depth <= 0) break;
  }
  if (depth > 0 && out.length === 30) out.push("    …");
  return out.join("\n");
}

const passPlan = new Map<string, string[]>();   // check pass: table → what each insert planned
const passSeen = new Map<string, number>();

/** The real pass must build the rows the check pass checked. */
function samePlanAsCheck(table: string, plan: string): void {
  if (!mode) return;
  if (mode === "check") {
    passPlan.set(table, [...(passPlan.get(table) ?? []), plan]);
    return;
  }
  const i = passSeen.get(table) ?? 0;
  passSeen.set(table, i + 1);
  if (passPlan.get(table)?.[i] !== plan) {
    throw new Error(
      `${table}: the real pass built other rows than the check pass, so what was checked is not what would be written. ` +
      `Build every row inside runSeed's body from the plan, rng(), days() and at(); never from Date.now(), Math.random() or the clock.`,
    );
  }
}

// ─────────────────────────────── transport ───────────────────────────────

type Reply = { code: number; out: string; err: string };
type Transport = (argv: string[], stdin: string) => Promise<Reply>;

const spawnTransport: Transport = async (argv, stdin) => {
  const proc = Bun.spawn(argv, { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  proc.stdin.write(stdin);
  proc.stdin.end();
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, out, err };
};
let transport: Transport = spawnTransport;

/** Tests only: replace the process that talks to the platform (`null` restores it). */
export const setTransport = (t: Transport | null): void => { transport = t ?? spawnTransport; };

// ─────────────────────────────── check pass ───────────────────────────────

const dryRows = new Map<string, any[]>();           // `pg:/<table>` → rows a check pass "inserted"
const dryDeleted = new Map<string, Set<string>>();  // `pg:/<table>` → ids of live rows a check pass "deleted"
let dryId = 0;
const dryWarned = new Set<string>();
const streams = new Set<() => void>();              // every rng(), restarted at the start of each pass

function resetPass(): void {
  dryRows.clear(); dryDeleted.clear(); dryWarned.clear(); dryId = 0;
  writeCount = 0; clearStarted = false; rowsInserted = false; lastSite = ""; lastFrame = undefined;
  stateChecks.length = 0; seededStates.clear(); refLabels.clear();
  for (const restart of streams) restart();
}

/** Clears what a check run recorded and every cached description (tests only). */
export const resetCheckRun = (): void => {
  resetPass();
  metaCache.clear(); me = undefined; passPlan.clear(); passSeen.clear(); mode = undefined; quiet = false;
};

/** `col=op.value` triples of a PostgREST query string (`select`, `order`, `limit`, `offset` dropped); `null` when a part is not of that form. */
function parseFilters(query: string): Array<[string, string, string]> | null {
  const out: Array<[string, string, string]> = [];
  for (const part of query.split("&")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    if (eq < 0) return null;
    const col = part.slice(0, eq);
    if (["select", "order", "limit", "offset"].includes(col)) continue;
    const rest = part.slice(eq + 1);
    const dot = rest.indexOf(".");
    if (dot < 0) return null;
    out.push([col, rest.slice(0, dot), rest.slice(dot + 1)]);
  }
  return out;
}

const decode = (s: string): string => { try { return decodeURIComponent(s); } catch { return s; } };
const unquote = (s: string): string => (s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1).replace(/\\(.)/g, "$1") : s);

/** Rows the check pass recorded under `key` that match `query`. An unsupported operator matches nothing (warned once). */
function dryMatch(key: string, query: string): any[] {
  const rows = dryRows.get(key) ?? [];
  if (!rows.length) return [];
  const warn = (what: string): any[] => {
    if (!dryWarned.has(what)) { dryWarned.add(what); console.warn(`  [check run] ${what}: rows this check run created are not matched`); }
    return [];
  };
  const triples = parseFilters(query);
  if (!triples) return warn(`unparsed filter "${query}"`);
  const tests: Array<(r: any) => boolean> = [];
  for (const [col, op, raw] of triples) {
    if (op === "eq") { const v = unquote(decode(raw)); tests.push((r) => String(r[col]) === v); }
    else if (op === "in") {
      const set = new Set(raw.replace(/^\(|\)$/g, "").split(",").map((v) => unquote(decode(v))));
      tests.push((r) => set.has(String(r[col])));
    } else if (op === "is" && raw === "null") tests.push((r) => r[col] === null || r[col] === undefined);
    else return warn(`operator ${op}. on ${col}`);
  }
  return rows.filter((r) => tests.every((t) => t(r)));
}

/** The ids an `id=eq.` or `id=in.()` filter names. */
function idsIn(query: string): string[] {
  const t = parseFilters(query)?.find(([c, op]) => c === "id" && (op === "eq" || op === "in"));
  if (!t) return [];
  return t[1] === "eq" ? [unquote(decode(t[2]))] : t[2].replace(/^\(|\)$/g, "").split(",").map((v) => unquote(decode(v)));
}

// ─────────────────────────────── query helpers ───────────────────────────────

export const BATCH_SIZE = 100;
/** `seedEnsureMany` reads a table whole up to this many rows, to find stored rows that match no planned row. */
const WHOLE_TABLE = 1000;

/** Splits `rows` into groups of at most `size`. */
export function chunk<T>(rows: ReadonlyArray<T>, size = BATCH_SIZE): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

const preview = (keys: ReadonlyArray<string>, n = 20): string =>
  keys.slice(0, n).join(", ") + (keys.length > n ? `, … +${keys.length - n} more` : "");

/** PostgREST `in.()` value quoting: plain when safe, else double-quoted with `\` and `"` escaped. */
const PG_PLAIN = /^[A-Za-z0-9_$.\-:@]+$/;
export const pgQuote = (v: string | number): string => {
  const s = String(v);
  return PG_PLAIN.test(s) ? s : `"${s.replace(/[\\"]/g, "\\$&")}"`;
};

/**
 * `col=in.(v1,v2,…)` for a multi-key read. Values are quoted per `pgQuote`, then percent-encoded, so a
 * `&`, `,`, `+`, `#`, `%`, quote or space inside a value ("AT&T", "Salesforce, Inc.") never breaks the
 * query string. Throws on an empty list.
 */
export function inFilter(column: string, values: ReadonlyArray<string | number>): string {
  if (!values.length) throw new Error(`inFilter ${column}: empty value list`);
  return `${column}=in.(${values.map((v) => encodeURIComponent(pgQuote(v))).join(",")})`;
}

const tableOf = (path: string): string => {
  const t = path.split("?")[0];
  return t.startsWith("/") ? t : `/${t}`;
};

// ─────────────────────────────── argument checks ───────────────────────────────
// bun does not type-check a script, so every exported helper checks the shape of what it was given and names its
// signature and a right call; a wrong call then halts with what to write, not with a misleading later failure.

const isPath = (p: unknown): boolean => typeof p === "string" && p.replace(/^\//, "") !== "";
const isRows = (rows: unknown): boolean => Array.isArray(rows) && rows.every((r) => !!r && typeof r === "object" && !Array.isArray(r));
const isStrings = (xs: unknown): boolean => Array.isArray(xs) && xs.every((x) => typeof x === "string" && x !== "");
const isCount = (n: unknown): boolean => typeof n === "number" && Number.isFinite(n);
const show = (v: unknown): string => (JSON.stringify(v) ?? String(v)).slice(0, 80);

/** Throws `<signature>: <every problem>. A right call: <example>` when a check fails. */
function checkArgs(signature: string, example: string, checks: ReadonlyArray<readonly [ok: boolean, problem: string]>): void {
  const bad = checks.filter(([ok]) => !ok).map(([, problem]) => problem);
  if (bad.length) throw new Error(`${signature}: ${bad.join("; ")}. A right call: ${example}`);
}

/** The entries of `list` that fail `ok`, shown with their index, for a message (at most three). */
const badEntries = (list: ReadonlyArray<unknown>, ok: (x: unknown) => boolean): string =>
  list.map((x, i) => [x, i] as const).filter(([x]) => !ok(x)).slice(0, 3).map(([x, i]) => `[${i}] ${show(x)}`).join(", ");

/** The keys of `rows` as strings (their `_ref` for `REF`); throws on an empty or repeated key. */
function keysOf(who: string, table: string, keyField: string, rows: ReadonlyArray<Row>): string[] {
  const keys = rows.map((r, i) => {
    const k = r[keyField];
    if (k === undefined || k === null || k === "") {
      throw new Error(keyField === REF
        ? `${who} ${table}: row ${i} has no _ref; give every planned row of this table a _ref name (it is never sent)`
        : `${who} ${table}: row ${i} has an empty "${keyField}"`);
    }
    return String(k);
  });
  if (new Set(keys).size !== keys.length) {
    throw new Error(`${who} ${table}: "${keyField}" repeats among the rows; every seeded row needs its own ${keyField}`);
  }
  return keys;
}

const withoutRef = (r: Row): Row => { const { [REF]: _drop, ...rest } = r; return rest; };

/** The entry of `pool` nearest to `name` by edit distance, when it is at most 3 edits away. */
function closest(name: string, pool: ReadonlyArray<string>): string | undefined {
  const distance = (a: string, b: string): number => {
    let row = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      const next = [i];
      for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      row = next;
    }
    return row[b.length];
  };
  let best: string | undefined;
  let bestDistance = 4;
  for (const p of new Set(pool)) {
    const d = distance(name, p);
    if (d < bestDistance) [best, bestDistance] = [p, d];
  }
  return best;
}

// ─────────────────────────────── postgrestRequest ───────────────────────────────

/**
 * Loud `postgrestRequest` call: reads and writes of business records. The payload field is `body`, not
 * `data` (`data` is the typed-tool shape); this helper owns that difference. Throws on any non-zero exit.
 * `single` adds `--single` (one-row body only: the CLI rejects it for an array body, use `postMany`).
 * Returns parsed JSON: an array, or the bare object with `single`.
 */
export async function pgRequest(method: string, path: string, body?: unknown, single = false): Promise<any> {
  if (single && Array.isArray(body)) {
    throw new Error(`pgRequest ${method} ${path}: --single cannot be combined with an array body (SINGLE_ARRAY_INPUT); use postMany() for a bulk insert`);
  }
  const [table, query = ""] = path.split("?");
  const key = `pg:${table}`;
  if (isCheckRun() && method !== "GET") {
    let out: any[] = [];
    if (method === "POST") {
      out = (Array.isArray(body) ? body : [body]).map((r: any) => ({ ...r, id: r?.id ?? -(++dryId) }));
      dryRows.set(key, [...(dryRows.get(key) ?? []), ...out]);
    } else {
      out = dryMatch(key, query);
      if (method === "PATCH") {
        for (const r of out) Object.assign(r, body);
        const id = parseFilters(query)?.find(([c, op]) => c === "id" && op === "eq")?.[2];
        if (!out.length && id !== undefined) out = [{ ...(body as object), id: decode(id) }];   // a live row
      } else {
        dryRows.set(key, (dryRows.get(key) ?? []).filter((r) => !out.includes(r)));
        const gone = dryDeleted.get(key) ?? new Set<string>();
        const ids = idsIn(query);
        for (const id of ids) gone.add(id);
        dryDeleted.set(key, gone);
        out = [...out, ...ids.filter((id) => !out.some((r) => String(r.id) === id)).map((id) => ({ id }))];   // live rows, hidden from later reads
      }
    }
    writeCount++;
    say(`  [check run] ${method} ${table}: ${out.length} row(s), not sent`);
    return single ? out[0] ?? null : out;
  }
  let sendPath = path;
  const gone = isCheckRun() ? dryDeleted.get(key) : undefined;
  if (isCheckRun()) {
    // The ids a check pass gave its own rows (-1, -2, …) never go to the host: a uuid key would refuse them.
    // A filter left with no live value can only match recorded rows, so the host is not asked at all.
    let live = true;
    const parts = query.split("&").filter(Boolean).map((p) => {
      const at = p.indexOf("=");
      const [col, rest] = at < 0 ? [p, ""] : [p.slice(0, at), p.slice(at + 1)];
      if (rest.startsWith("in.(")) {
        const values = rest.slice(4, -1).split(",").filter((v) => !/^-\d+$/.test(unquote(decode(v))));
        if (!values.length) live = false;
        return `${col}=in.(${values.join(",")})`;
      }
      if (rest.startsWith("eq.") && /^-\d+$/.test(decode(rest.slice(3)))) live = false;
      if (col === "select" && gone?.size && !rest.split(",").includes("id")) return `${p},id`;   // read the id, so a row this pass deleted can be hidden
      return p;
    });
    if (!live) return dryMatch(key, query);
    sendPath = parts.length ? `${table}?${parts.join("&")}` : table;
  }
  const argv = single
    ? ["semantius", "--single", "call", "crud", "postgrestRequest"]
    : ["semantius", "call", "crud", "postgrestRequest"];
  const payload: Row = { method, path: sendPath };
  if (body !== undefined) payload.body = body;
  const { code, out, err } = await transport(argv, JSON.stringify(payload));
  if (isCheckRun()) {   // a GET: live rows not deleted by this pass, plus the rows this pass inserted
    if (code !== 0) throw new Error(`pgRequest ${method} ${path} failed (exit ${code}): ${err}`);
    const live = out.trim() ? JSON.parse(out) : [];
    const kept = (Array.isArray(live) ? live : [live]).filter((r: any) => !gone?.has(String(r?.id)));
    return [...kept, ...dryMatch(key, query)];
  }
  if (code !== 0) throw new Error(`pgRequest ${method} ${path} failed (exit ${code}): ${err}`);
  if (method !== "GET") writeCount++;
  return out.trim() ? JSON.parse(out) : null;
}

// ─────────────────────────────── table descriptions ───────────────────────────────

type FieldMeta = {
  field_name: string; format: string; input_type: string; input_type_rule: unknown;
  enum_values: unknown; default_value: unknown; ctype: string; reference_table: string; precision?: number;
};
type TableMeta = { table: string; entity: any; managed: boolean; fields: Map<string, FieldMeta>; base?: TableMeta };

const ENTITY_COLS = "table_name,module_id,entity_type,id_type,id_refentity,label_column,computed_fields,validation_rules,select_rule,edit_permission,managed";
const FIELD_COLS = "table_name,field_name,format,input_type,input_type_rule,enum_values,default_value,ctype,reference_table,precision";
const metaCache = new Map<string, TableMeta>();

/** The entity and fields of `table`, read once with every other entity of its module (three reads per module). */
async function metaOf(table: string): Promise<TableMeta> {
  const hit = metaCache.get(table);
  if (hit) return hit;
  const name = table.slice(1);
  const [entity] = (await pgRequest("GET", `/entities?select=${ENTITY_COLS}&table_name=eq.${encodeURIComponent(name)}`)) ?? [];
  if (!entity) throw new Error(`${table} is not an entity on this host; check the table name (read_entity lists them)`);
  const entities: any[] = entity.module_id === null || entity.module_id === undefined
    ? [entity]
    : (await pgRequest("GET", `/entities?select=${ENTITY_COLS}&module_id=eq.${encodeURIComponent(String(entity.module_id))}`)) ?? [];
  if (!entities.some((e) => e?.table_name === name)) entities.push(entity);
  const fields: any[] = [];
  for (const part of chunk(entities.map((e) => String(e.table_name)), 40)) {
    fields.push(...((await pgRequest("GET", `/fields?select=${FIELD_COLS}&${inFilter("table_name", part)}`)) ?? []));
  }
  for (const e of entities) {
    const t = `/${e.table_name}`;
    if (metaCache.has(t)) continue;
    metaCache.set(t, {
      table: t, entity: e, managed: e.managed !== false,
      fields: new Map(fields.filter((f) => f.table_name === e.table_name).map((f) => [String(f.field_name), f as FieldMeta])),
    });
  }
  const meta = metaCache.get(table)!;
  if (["is_a", "has_a"].includes(String(meta.entity.id_type)) && meta.entity.id_refentity && !meta.base) {
    meta.base = await metaOf(`/${meta.entity.id_refentity}`);
  }
  return meta;
}

/** Own fields plus, for an `is_a` / `has_a` entity, the fields of its base. */
const fieldsOf = (m: TableMeta): Map<string, FieldMeta> => (m.base ? new Map([...fieldsOf(m.base), ...m.fields]) : m.fields);
const rulesOf = (m: TableMeta): any[] => [
  ...(Array.isArray(m.entity?.computed_fields) ? m.entity.computed_fields : []), ...(m.base ? rulesOf(m.base) : []),
];
const validationsOf = (m: TableMeta): any[] => (Array.isArray(m.entity?.validation_rules) ? m.entity.validation_rules : []);
const emptyRule = (r: unknown): boolean => !r || (typeof r === "object" && !Array.isArray(r) && Object.keys(r as object).length === 0);

/** A rule that reads its own field keeps what an insert sends there (an approval stamp on a row past its step). */
const keepsSent = (rule: any, col: string): boolean => {
  const t = JSON.stringify(rule?.jsonlogic ?? null);
  return t.includes(`"var":"${col}"`) || t.includes(`"var":["${col}"`);
};

/** Why the platform writes `col` (empty when the seed may send it). `keptStamps` admits a stamp an insert keeps. */
function platformWrites(m: TableMeta, col: string, keptStamps: boolean): string {
  const f = fieldsOf(m).get(col);
  if (f && ["audit", "core"].includes(f.ctype)) return "the platform writes it";
  if (f?.ctype === "rollup") return "it is a rollup column";
  const rule = rulesOf(m).find((r) => r?.name === col);
  if (rule) return keptStamps && keepsSent(rule, col) ? "" : "a computed_fields rule fills it";
  if (f?.ctype === "computed") return "a computed_fields rule fills it";
  return "";
}

const MODE_INSERT = JSON.stringify({ "==": [{ var: "$mode" }, "insert"] });

/** The states in which `rule` keeps a stamp an insert sends (the shape of `rbac.md` → "Controls on a gate", control 5), or null. */
function keptStates(rule: any): string[] | null {
  const own = JSON.stringify({ "!=": [{ var: rule?.name }, null] });
  let found: string[] | null = null;
  const walk = (n: any): void => {
    if (found || !n || typeof n !== "object") return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (Array.isArray(n.and)) {
      const parts = n.and.map((x: any) => JSON.stringify(x));
      const states = n.and.find((x: any) => Array.isArray(x?.in) && JSON.stringify(x.in[0]) === '{"var":"workflow_state"}' && Array.isArray(x.in[1]));
      if (parts.includes(MODE_INSERT) && parts.includes(own) && states) { found = states.in[1].map(String); return; }
    }
    Object.values(n).forEach(walk);
  };
  walk(rule?.jsonlogic);
  return found;
}

/** A rule that stamps the requester: `{"if": [$mode == insert, $user_id, …]}`. */
const isRequesterStamp = (rule: any): boolean => {
  const j = rule?.jsonlogic;
  return Array.isArray(j?.if) && JSON.stringify(j.if[0]) === MODE_INSERT && JSON.stringify(j.if[1]) === '{"var":"$user_id"}';
};

/** The permission a restricted create checks: `{"if": [$mode == insert, {"has_permission": P}, true]}`, or null. */
function restrictedCreate(v: any): string | null {
  const j = v?.jsonlogic;
  if (!Array.isArray(j?.if) || j.if.length !== 3 || JSON.stringify(j.if[0]) !== MODE_INSERT || j.if[2] !== true) return null;
  const p = j.if[1]?.has_permission ?? j.if[1]?.require_permission;
  return typeof p === "string" ? p : null;
}

/** Whether a select_rule shows every row to a holder of `perms`: true, false, or null when it depends on the row. */
function showsEveryRow(rule: any, perms: Set<string>): boolean | null {
  if (rule === true || rule === false) return rule;
  if (!rule || typeof rule !== "object" || Array.isArray(rule)) return null;
  const [op] = Object.keys(rule);
  const args = Array.isArray(rule[op]) ? rule[op] : [rule[op]];
  if (op === "has_permission") return perms.has(String(args[0]));
  if (op === "!") { const v = showsEveryRow(args[0], perms); return v === null ? null : !v; }
  if (op === "and" || op === "or") {
    let open = false;
    for (const a of args) {
      const v = showsEveryRow(a, perms);
      if (v === (op === "or")) return v;
      if (v === null) open = true;
    }
    return open ? null : op === "and";
  }
  return null;
}

let me: { id: string; perms: Set<string> } | undefined;

/** The user running the seed: id and effective permissions, read once. */
async function currentUser(): Promise<{ id: string; perms: Set<string> }> {
  if (!me) {
    const { code, out, err } = await transport(["semantius", "call", "crud", "getCurrentUser"], "{}");
    if (code !== 0) throw new Error(`getCurrentUser failed (exit ${code}): ${err}`);
    const j = JSON.parse(out);
    me = { id: String(j.user_id ?? ""), perms: new Set(Array.isArray(j.permissions) ? j.permissions.map(String) : []) };
  }
  return me;
}

// ─────────────────────────────── values ───────────────────────────────

const NULLABLE = new Set(["reference", "date", "date-time"]);
const NUMBER_FORMATS = new Set(["number", "integer", "int32", "int64", "float", "double", "rating"]);
const OPAQUE = new Set(["json", "object", "array", "jsonlogic", "boolean", "uuid", "time", "duration", "binary"]);
const UNMATCHABLE = new Set(["date-time", "float", "double", "json", "object", "array", "jsonlogic", "binary", "time", "duration", "password"]);

/** Whether `v` is the empty value of `format` (what a required field may not hold). */
function isEmpty(format: string, v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (format === "rating") return v === 0;
  if (NUMBER_FORMATS.has(format) || OPAQUE.has(format)) return false;
  return v === "";
}

const enumEntries = (f: FieldMeta): Array<{ value: string; label: string }> =>
  (Array.isArray(f.enum_values) ? f.enum_values : []).map((e: any) =>
    e && typeof e === "object" ? { value: String(e.value), label: String(e.label ?? e.value) } : { value: String(e), label: String(e) });

const UNKNOWN = Symbol("unknown");
const truthy = (v: unknown): boolean => (Array.isArray(v) ? v.length > 0 : !!v);

/** The plain JsonLogic of an input_type_rule (`if, ==, !=, ===, !==, in, and, or, !, !!, var`) on a row; UNKNOWN for anything else. */
function evalPlain(rule: any, row: Row): any {
  if (rule === null || typeof rule !== "object") return rule;
  if (Array.isArray(rule)) return rule.map((x) => evalPlain(x, row));
  const keys = Object.keys(rule);
  if (keys.length !== 1) return UNKNOWN;
  const op = keys[0];
  const args: any[] = Array.isArray(rule[op]) ? rule[op] : [rule[op]];
  const ev = (x: any) => evalPlain(x, row);
  switch (op) {
    case "var": {
      const name = args[0];
      if (typeof name !== "string" || name.startsWith("$") || name.includes(".")) return UNKNOWN;
      return row[name] ?? args[1] ?? null;
    }
    case "if": {
      for (let i = 0; i + 1 < args.length; i += 2) {
        const c = ev(args[i]);
        if (c === UNKNOWN) return UNKNOWN;
        if (truthy(c)) return ev(args[i + 1]);
      }
      return args.length % 2 ? ev(args[args.length - 1]) : null;
    }
    case "==": case "===": case "!=": case "!==": {
      const [a, b] = args.map(ev);
      if (a === UNKNOWN || b === UNKNOWN) return UNKNOWN;
      const same = op.length === 3 ? a === b : a == b;   // eslint-disable-line eqeqeq
      return op.startsWith("=") ? same : !same;
    }
    case "in": {
      const [a, b] = args.map(ev);
      if (a === UNKNOWN || b === UNKNOWN) return UNKNOWN;
      return Array.isArray(b) ? b.some((x) => x == a) : typeof b === "string" ? b.includes(String(a)) : false;   // eslint-disable-line eqeqeq
    }
    case "and": case "or": {
      let last: any = op === "and";
      for (const x of args) {
        const v = ev(x);
        if (v === UNKNOWN) return UNKNOWN;
        if (truthy(v) === (op === "or")) return v;
        last = v;
      }
      return last;
    }
    case "!": case "!!": {
      const v = ev(args[0]);
      return v === UNKNOWN ? UNKNOWN : op === "!" ? !truthy(v) : truthy(v);
    }
    default: return UNKNOWN;
  }
}

/** A value as the platform compares it: a date by its day, a number as a number; null when absent. */
function norm(m: TableMeta, col: string, v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const field = fieldsOf(m).get(col);
  const f = field?.format;
  if (f === "date") return String(v).slice(0, 10);
  // a number is stored as NUMERIC(18, precision): compare it rounded the same way
  if (f === "number") return String(Number(Number(v).toFixed(typeof field?.precision === "number" ? field.precision : 2)));
  if ((f && NUMBER_FORMATS.has(f)) || (!f && typeof v === "number")) return String(Number(v));
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}

// ─────────────────────────────── rows before a write ───────────────────────────────

const EMAIL_IN_TEXT = /[^\s@<>"',;:()[\]]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g;

/**
 * Every email address in a seeded row sits at a subdomain of example.com (`exampleDomain("Adobe")` →
 * "adobe.example.com"), whatever company the row names, so a sample address can never reach a real inbox.
 * Throws naming the row, the column and the address. Looks inside every text value, notes included.
 */
export function assertExampleEmails(table: string, rows: ReadonlyArray<Row>): void {
  const bad: string[] = [];
  rows.forEach((row, i) => {
    for (const [col, v] of Object.entries(row)) {
      if (typeof v !== "string") continue;
      for (const m of v.matchAll(EMAIL_IN_TEXT)) {
        if (!m[1].toLowerCase().endsWith(".example.com")) bad.push(`row ${i} ${col}: ${m[0]}`);
      }
    }
  });
  if (bad.length) {
    const bare = bad.some((b) => /@example\.com$/i.test(b));
    throw new Error(
      `${table}: ${bad.length} email address(es) not at a subdomain of example.com:\n  - ${bad.join("\n  - ")}\n` +
      `Build each one with exampleDomain(company), e.g. \`support@\${exampleDomain("Adobe")}\` → support@adobe.example.com.` +
      (bare
        ? ` example.com itself is not enough: a person's address takes the company they work for, or any made-up one, ` +
          `e.g. \`ana.silva@\${exampleDomain("Globex")}\` → ana.silva@globex.example.com.`
        : ""),
    );
  }
}

/** Emails, no `_` column, the same keys on every row: checks that need no read. */
function assertShape(who: string, table: string, rows: ReadonlyArray<Row>): void {
  assertExampleEmails(table, rows);
  const shapeOf = (r: Row): string => Object.keys(r).filter((k) => r[k] !== undefined).sort().join(",");
  const shape = shapeOf(rows[0]);
  const underscored = shape.split(",").filter((k) => k.startsWith("_"));
  if (underscored.length) {
    throw new Error(`${who} ${table}: ${underscored.join(", ")} is never sent (a column cannot start with "_"); a planned _ref goes to seedEnsureMany with the key "_ref"`);
  }
  rows.forEach((r, i) => {
    const s = shapeOf(r);
    if (s !== shape) {
      throw new Error(
        `${who} ${table}: row ${i} keys [${s}] differ from row 0 [${shape}]; a bulk insert needs identical keys ` +
        `on every row (send null / "" / 0 explicitly; never omit a key or leave it undefined)`,
      );
    }
  });
}

/**
 * The rows against the table's description, before anything is sent, in both passes. `names` labels each
 * row in the messages. An unmanaged table (its DDL is kept outside the platform) is checked by a read with
 * `limit=0` in the check pass instead.
 */
async function checkRows(who: string, table: string, rows: ReadonlyArray<Row>, names: ReadonlyArray<string>): Promise<void> {
  const m = await metaOf(table);
  if (!m.managed) {
    if (isCheckRun()) {
      const columns = Object.keys(rows[0]).filter((k) => rows[0][k] !== undefined);
      await pgRequest("GET", `${table}?select=${columns.join(",")}&limit=0`);   // a missing table or column fails here
    }
    return;
  }
  const F = fieldsOf(m);
  const problems: string[] = [];
  const idType = String(m.entity.id_type ?? "auto_increment");
  const cols = Object.keys(rows[0]).filter((k) => rows[0][k] !== undefined);
  const sendable = cols.filter((c) => {
    if (c === "id") {
      if (!["bigint", "text", "has_a"].includes(idType)) problems.push(`id: never send it; the platform assigns ${idType} ids, and a child takes its parent's id from idsByKey`);
      return false;
    }
    const f = F.get(c);
    if (!f) {
      const near = closest(c, [...F.keys()]);
      problems.push(`${c}: not a field of ${table}${near ? ` (did you mean ${near}?)` : ""}; never add a field to the schema for a seed`);
      return false;
    }
    const why = platformWrites(m, c, true);
    if (why) { problems.push(`${c}: ${why}, so the seed never sends it`); return false; }
    return true;
  });
  rows.forEach((row, i) => {
    const name = names[i] ?? `row ${i}`;
    for (const c of sendable) {
      const f = F.get(c)!;
      const v = row[c];
      if (v === null && !NULLABLE.has(f.format)) {
        problems.push(`${name}: ${c} is null; only a reference, date or date-time column takes null, so send ${NUMBER_FORMATS.has(f.format) ? "0" : '""'}`);
        continue;
      }
      const byRule = emptyRule(f.input_type_rule) ? undefined : evalPlain(f.input_type_rule, row);
      const required = byRule === undefined ? f.input_type === "required" : byRule === "required";
      if (required && isEmpty(f.format, v)) {
        problems.push(`${name}: ${c} is required${byRule === "required" ? " for this row (its input_type_rule)" : ""}; send a value`);
        continue;
      }
      if (f.format === "enum" && !isEmpty("enum", v)) {
        const entries = enumEntries(f);
        if (entries.length && !entries.some((e) => e.value === String(v))) {
          // the label, or a spelling variant of a value or label: compare without case, separators or doubled letters
          const squash = (s: string): string => s.toLowerCase().replace(/[\s_-]+/g, "").replace(/(.)\1+/g, "$1");
          const label = entries.find((e) => e.label.toLowerCase() === String(v).toLowerCase());
          const near = label ?? entries.find((e) => squash(e.label) === squash(String(v)) || squash(e.value) === squash(String(v)));
          problems.push(
            `${name}: ${c} "${v}" is not one of its values (${entries.map((e) => e.value).join(", ")})` +
            (label ? `; send the value "${label.value}", not the label` : near ? `; did you mean "${near.value}"?` : ""),
          );
        }
      }
    }
  });
  const sent = new Set(cols);
  // a field its input_type_rule makes required for a row must be sent, not only filled when sent
  const ruled = [...F.values()].filter((f) => !sent.has(f.field_name) && !emptyRule(f.input_type_rule) && !platformWrites(m, f.field_name, false));
  rows.forEach((row, i) => {
    for (const f of ruled) {
      if (evalPlain(f.input_type_rule, row) === "required") problems.push(`${names[i] ?? `row ${i}`}: ${f.field_name} is required for this row (its input_type_rule) and not sent; send it on every row`);
    }
  });
  const unsentRequired = (meta: TableMeta): FieldMeta[] => [...meta.fields.values()].filter((f) =>
    !sent.has(f.field_name) && f.input_type === "required" && emptyRule(f.input_type_rule) && String(f.default_value ?? "") === "" &&
    !["id", "audit", "core", "rollup", "computed"].includes(f.ctype) && !platformWrites(m, f.field_name, false));
  const missing = [...unsentRequired(m), ...(m.base && (idType === "is_a" || !sent.has("id")) ? unsentRequired(m.base) : [])];
  for (const f of missing) problems.push(`${f.field_name}: required, with no default, and not sent; send it on every row`);
  await checkGates(table, m, rows, names, problems);
  if (problems.length) {
    throw new Error(
      `${who} ${table}: ${problems.length} problem(s) found before anything was sent:\n  - ${problems.slice(0, 15).join("\n  - ")}` +
      (problems.length > 15 ? `\n  - … +${problems.length - 15} more` : "") +
      `\nRun \`bun ${libPath()} --describe ${table.slice(1)}\` for what this table takes, then fix the plan.`,
    );
  }
}

/** The approval stamps, the approver, and whether the user running the seed may create and read these rows. */
async function checkGates(table: string, m: TableMeta, rows: ReadonlyArray<Row>, names: ReadonlyArray<string>, problems: string[]): Promise<void> {
  const F = fieldsOf(m);
  const rules = rulesOf(m);
  const stamps = rules.map((r) => ({ col: String(r?.name), states: keptStates(r) })).filter((s): s is { col: string; states: string[] } => !!s.states);
  let past = 0;
  rows.forEach((row, i) => {
    const hit = stamps.filter((s) => s.states.includes(String(row.workflow_state)));
    if (hit.length) past++;
    for (const s of hit) {
      if (isEmpty(F.get(s.col)?.format ?? "text", row[s.col])) {
        problems.push(`${names[i]} (${row.workflow_state}): ${s.col} is empty; a row seeded at or past the approval sends its stamp (seed-data.md → "Approval stamps on rows past the step")`);
      }
    }
    // the rule keeps a stamp only on rows in its states; anywhere else the platform stores null
    for (const s of stamps.filter((x) => !hit.includes(x))) {
      if (!isEmpty(F.get(s.col)?.format ?? "text", row[s.col])) {
        problems.push(`${names[i]} (${row.workflow_state}): ${s.col} is sent, but the platform keeps it only on rows in ${s.states.join(", ")}; send null`);
      }
    }
  });
  const creates = validationsOf(m).map(restrictedCreate).filter((p): p is string => !!p);
  const select = m.entity.select_rule;
  const narrows = !emptyRule(select);
  if (!past && !creates.length && !narrows) return;
  const user = await currentUser();
  const edit = String(m.entity.edit_permission ?? "");
  const admin = edit.includes(":") ? `${edit.split(":")[0]}:admin` : "";
  if (past && admin && !user.perms.has(admin)) {
    problems.push(`${past} row(s) are at or past an approval, which only an admin may create, and the user running the seed does not hold ${admin}; seed them before the approval, or run as the module's admin`);
  }
  if (rules.some(isRequesterStamp)) {
    for (const s of stamps) {
      if (F.get(s.col)?.reference_table !== "users") continue;
      rows.forEach((row, i) => {
        if (row[s.col] !== null && row[s.col] !== undefined && String(row[s.col]) === user.id) {
          problems.push(`${names[i]}: ${s.col} names the user running the seed, who is the requester of every row it inserts, and a requester never approves their own record; name another user read from users`);
        }
      });
    }
  }
  for (const p of creates) if (!user.perms.has(p)) problems.push(`only holders of ${p} may create ${table} records, and the user running the seed does not hold it`);
  if (narrows && showsEveryRow(select, user.perms) !== true) {
    problems.push(`its select_rule limits which rows the user running the seed sees, so the read-back would miss rows; run the seed as the module's admin`);
  }
}

// ─────────────────────────────── keyed reads ───────────────────────────────

type Keyer = { keys: string[]; select: string[]; reads: string[]; keyOf: (stored: any) => string | undefined };

/**
 * How the stored rows of `rows` are found: by `keyField` (an `in.()` read), or for `REF` by the tuple of the
 * values the rows send that compare exactly (references, text, enums, whole numbers, dates).
 */
async function keyer(who: string, table: string, keyField: string, rows: ReadonlyArray<Row>, columns: ReadonlyArray<string>): Promise<Keyer> {
  const keys = keysOf(who, table, keyField, rows);
  if (keyField !== REF) {
    const select = [...new Set([keyField, ...columns])];
    return { keys, select, reads: chunk(keys).map((part) => inFilter(keyField, part)), keyOf: (r) => String(r[keyField]) };
  }
  const m = await metaOf(table);
  const send = rows.map(withoutRef);
  const F = fieldsOf(m);
  const cols = Object.keys(send[0] ?? {}).filter((c) => send[0][c] !== undefined && !UNMATCHABLE.has(F.get(c)?.format ?? "")).sort();
  if (!cols.length) throw new Error(`${who} ${table}: its rows send no column a _ref can be matched by (a reference, text, enum, whole number or date)`);
  const tuple = (r: any): string => JSON.stringify(cols.map((c) => norm(m, c, r[c])));
  const byTuple = new Map<string, string>();
  send.forEach((r, i) => {
    const t = tuple(r);
    const other = byTuple.get(t);
    if (other !== undefined) throw new Error(`${who} ${table}: "${other}" and "${keys[i]}" send the same values (${cols.join(", ")}), so they cannot be told apart; make one of them differ`);
    byTuple.set(t, keys[i]);
  });
  const rank = (c: string): number => (["reference", "parent"].includes(F.get(c)?.format ?? "") ? 0 : F.get(c)?.format === "enum" ? 2 : 1);
  const by = cols
    .filter((c) => send.every((r) => r[c] !== null && r[c] !== undefined && r[c] !== ""))
    .sort((a, b) => rank(a) - rank(b) || new Set(send.map((r) => String(r[b]))).size - new Set(send.map((r) => String(r[a]))).size)[0];
  const reads = by ? chunk([...new Set(send.map((r) => String(r[by])))]).map((part) => inFilter(by, part)) : ["limit=1000"];
  return { keys, select: [...new Set(["id", ...cols, ...columns])], reads, keyOf: (r) => byTuple.get(tuple(r)) };
}

/** The stored rows of each planned key. */
async function readKeyed(k: Keyer, table: string): Promise<Map<string, any[]>> {
  const stored = new Map<string, any[]>();
  for (const q of k.reads) {
    for (const r of await pgRequest("GET", `${table}?select=${k.select.join(",")}&${q}`)) {
      const key = k.keyOf(r);
      if (key !== undefined) stored.set(key, [...(stored.get(key) ?? []), r]);
    }
  }
  return stored;
}

/** The columns where a stored row differs from its planned row (date-times, floats and JSON are not compared). */
function driftOf(m: TableMeta, planned: Row, stored: any): string[] {
  const F = fieldsOf(m);
  const out: string[] = [];
  for (const [c, v] of Object.entries(planned)) {
    if (v === undefined || c === "id" || !(c in stored)) continue;
    if (UNMATCHABLE.has(F.get(c)?.format ?? "")) continue;
    if ((norm(m, c, v) ?? "") !== (norm(m, c, stored[c]) ?? "")) out.push(`${c} stored ${JSON.stringify(stored[c])}, planned ${JSON.stringify(v)}`);
  }
  return out;
}

// ─────────────────────────────── inserts ───────────────────────────────

/** One POST per at most `size` rows; throws on a short RETURNING. */
async function sendRows(table: string, rows: ReadonlyArray<Row>, size = BATCH_SIZE): Promise<any[]> {
  if (!rows.length) return [];
  rowsInserted = true;
  const out: any[] = [];
  for (const part of chunk(rows, size)) {
    const res = await pgRequest("POST", table, part);
    if (!Array.isArray(res) || res.length !== part.length) {
      throw new Error(
        `postMany ${table}: sent ${part.length} row(s), PostgREST returned ${Array.isArray(res) ? res.length : typeof res} ` +
        `(RETURNING suppressed by RLS, or a partial insert); halting`,
      );
    }
    out.push(...res);
    if (!isCheckRun()) say(`  ✓ POST ${table}: ${part.length} row(s) in one call`);
  }
  return out;
}

/**
 * Bulk insert: ONE POST with an array `body` per at most `size` rows. Every row carries the same keys: a column
 * you send on one row you send on every row. The rows are checked before anything is sent (`checkRows`). Returns
 * the inserted rows with their ids; treat that array as a count and a pool, not as a map from your rows to ids:
 * a parent's id comes from `idsByKey`. Bare INSERT: a re-run appends a second set, so every table goes through
 * `seedEnsureMany`, a junction included (key `_ref`).
 */
export async function postMany(path: string, rows: ReadonlyArray<Row>, size = BATCH_SIZE): Promise<any[]> {
  site();
  checkArgs("postMany(path, rows, size?)", 'postMany("/vendors", vendorRows)', [
    [isPath(path), `path is ${JSON.stringify(path)}; it is the table as "/<table_name>"`],
    [isRows(rows), "rows is a list of row objects"],
    [Number.isInteger(size) && size > 0, `size is ${JSON.stringify(size)}; leave it out, or give a whole number above 0`],
  ]);
  const table = tableOf(path);
  if (!rows.length) { await compareStates(table, []); return []; }
  assertShape("postMany", table, rows);
  await checkRows("postMany", table, rows, rows.map((_, i) => `row ${i}`));
  await settleStateTables();
  await compareStates(table, rows);
  samePlanAsCheck(table, `post ${rows.length}`);
  const out = await sendRows(table, rows, size);
  recordStates(table, out, out.map((r) => r?.id));   // each returned row carries its own id and state
  return out;
}

/** The key advice for `table`: its label column when the seed sends it, `_ref` when the platform computes it. */
function keyAdvice(m: TableMeta): string {
  if (m.entity.entity_type === "junction") return `key on "_ref": give every planned row a _ref name, which is never sent (the platform composes a junction's label)`;
  const label = String(m.entity.label_column ?? "");
  return label && !platformWrites(m, label, false)
    ? `key on its label column "${label}"`
    : `key on "_ref": give every planned row a _ref name, which is never sent${label ? ` (the platform computes ${label})` : ""}`;
}

/** Halts when `keyField` is not a column the seed sends: a column the platform writes, a missing field, or `id` the platform assigns. */
async function assertSeedOwnsKey(table: string, keyField: string): Promise<void> {
  const m = await metaOf(table);
  if (keyField === "id") {
    if (!["bigint", "text"].includes(String(m.entity.id_type))) throw new Error(`seedEnsureMany ${table}: "id" cannot be the key, because the platform assigns it; ${keyAdvice(m)}.`);
    return;
  }
  if (m.entity.entity_type === "junction") {
    throw new Error(`seedEnsureMany ${table}: "${keyField}" cannot be the key of a junction; ${keyAdvice(m)}.`);
  }
  const why = platformWrites(m, keyField, false);
  if (why) {
    throw new Error(
      `seedEnsureMany ${table}: "${keyField}" cannot be the key, because ${why}: the platform overwrites what the seed sends, ` +
      `so the rows stored never match the rows in the plan; ${keyAdvice(m)}.`,
    );
  }
  if (m.managed && !fieldsOf(m).has(keyField)) {
    throw new Error(`seedEnsureMany ${table}: "${keyField}" is not a field of ${table}; ${keyAdvice(m)}. Never add a field to the schema to key a seed.`);
  }
}

/** A drift halt: rows already stored differ from the plan. */
class SeedDriftError extends Error {}

/**
 * The insert for every table. `keyField` is the table's label column when the seed sends it, otherwise `"_ref"`
 * (every row then carries a `_ref` name, never sent, and stored rows are matched on the values the rows send).
 * Checks the rows before anything is read or sent, reads the rows already stored under those keys, halts when one
 * differs from its planned row, posts only the missing rows in one POST, and returns ALL rows with ids in INPUT
 * order (with their `_ref`), so a re-run after a halt converges. Use it only on entities the build just created.
 */
export async function seedEnsureMany(path: string, rows: ReadonlyArray<Row>, keyField: string): Promise<any[]> {
  site();
  checkArgs("seedEnsureMany(path, rows, keyField)", 'seedEnsureMany("/vendors", vendorRows, "vendor_name")', [
    [isPath(path), `path is ${JSON.stringify(path)}; it is the table as "/<table_name>"`],
    [isRows(rows), "rows is a list of row objects"],
    [typeof keyField === "string" && keyField !== "", `keyField is ${JSON.stringify(keyField)}; it is the label column, or "_ref"`],
  ]);
  const table = tableOf(path);
  if (!rows.length) { await compareStates(table, []); return []; }
  const planKeys = keysOf("seedEnsureMany", table, keyField, rows);
  if (keyField !== REF) await assertSeedOwnsKey(table, keyField);
  const send = keyField === REF ? rows.map(withoutRef) : [...rows];
  assertShape("seedEnsureMany", table, send);
  await checkRows("seedEnsureMany", table, send, planKeys);
  await settleStateTables();
  await compareStates(table, send);
  samePlanAsCheck(table, `ensure ${keyField}: ${planKeys.join("\u0001")}`);
  const m = await metaOf(table);
  const cols = Object.keys(send[0]).filter((c) => send[0][c] !== undefined);
  const k = await keyer("seedEnsureMany", table, keyField, rows, ["id", ...cols]);
  // Read the whole table (a table this build created holds only seeded rows): a stored row that matches no planned
  // row is one whose key or values changed in the script after a run landed it, and inserting beside it would duplicate it.
  const planned = new Set(k.keys);
  const all: any[] = await pgRequest("GET", `${table}?select=${k.select.join(",")}&order=id&limit=${WHOLE_TABLE}`);
  let stored = new Map<string, any[]>();
  const stale: any[] = [];
  if (all.length >= WHOLE_TABLE) {
    stored = await readKeyed(k, table);   // too large to read whole: match by key only
    say(`  ${tag()}${table}: more than ${WHOLE_TABLE - 1} stored rows, so rows changed after an earlier run are not detected`);
  } else {
    for (const r of all) {
      const key = k.keyOf(r);
      if (key !== undefined && planned.has(key)) stored.set(key, [...(stored.get(key) ?? []), r]);
      else stale.push(r);
    }
  }
  if (stale.length) {
    const show = (r: any) => `id ${r.id}: ${k.select.filter((c) => c !== "id").slice(0, 4).map((c) => `${c} ${JSON.stringify(r[c])}`).join(", ")}`;
    throw new SeedDriftError(
      `seedEnsureMany ${table}: ${stale.length} stored row(s) match no planned row, because a key or a value changed in the script after a run landed them:\n  - ` +
      `${stale.slice(0, 8).map(show).join("\n  - ")}${stale.length > 8 ? `\n  - … +${stale.length - 8} more` : ""}\n` +
      `clearSeeded ${table} and every table seeded after it (children first), then run the seed again.`,
    );
  }
  const twice = k.keys.filter((key) => (stored.get(key)?.length ?? 0) > 1);
  if (twice.length) throw new Error(`seedEnsureMany ${table}: ${preview(twice)} match more than one stored row; clearSeeded the table, then seed again`);
  const drift = k.keys.flatMap((key, i) => {
    const s = stored.get(key)?.[0];
    return s ? driftOf(m, send[i], s).map((d) => `${key}: ${d}`) : [];
  });
  if (drift.length) {
    throw new SeedDriftError(
      `seedEnsureMany ${table}: ${drift.length} value(s) of rows already stored differ from the plan:\n  - ${drift.slice(0, 12).join("\n  - ")}` +
      (drift.length > 12 ? `\n  - … +${drift.length - 12} more` : "") + "\n" +
      `clearSeeded ${table} and every table seeded after it (children first), then run the seed again; for one or two rows, patchById them instead.`,
    );
  }
  const byKey = new Map<string, any>(k.keys.map((key) => [key, stored.get(key)?.[0]]));
  const missing = k.keys.map((key, i) => (byKey.get(key) ? -1 : i)).filter((i) => i >= 0);
  for (const r of await sendRows(table, missing.map((i) => send[i]))) {
    const key = k.keyOf(r);
    if (key !== undefined) byKey.set(key, r);
  }
  const still = k.keys.filter((key) => !byKey.get(key));
  if (still.length) throw new Error(`seedEnsureMany ${table}: ${still.length} row(s) neither found nor returned by the insert: ${preview(still)}`);
  recordStates(table, send, k.keys.map((key) => byKey.get(key)?.id), k.keys);   // matched by key, never by position
  return k.keys.map((key) => (keyField === REF ? { ...byKey.get(key), [REF]: key } : byKey.get(key)));
}

/**
 * Rows of an existing entity the seed points at, such as `users`: `await readRows("/users?select=id,display_name&limit=20")`.
 * A child uses a chosen row's own `id` and names that row's label in `parentLabels`. A read, never a write.
 */
export async function readRows(path: string): Promise<any[]> {
  site();
  checkArgs("readRows(path)", 'readRows("/users?select=id,display_name&limit=20")', [[isPath(path), `path is ${show(path)}; it is a read path such as "/users?select=id,display_name"`]]);
  const res = await pgRequest("GET", path.startsWith("/") ? path : `/${path}`);
  return Array.isArray(res) ? res : res ? [res] : [];
}

/** The user running the seed: the requester of every row it inserts, so never the approver of one. */
export async function seedUser(): Promise<{ id: string | number; permissions: string[] }> {
  const u = await currentUser();
  return { id: /^\d+$/.test(u.id) ? Number(u.id) : u.id, permissions: [...u.perms] };
}

/** Updates ONE record by id: `PATCH <table>?id=eq.<id>` with `body`. Throws unless exactly one row came back. */
export async function patchById(table: string, id: string | number, body: Row): Promise<any> {
  site();
  checkArgs("patchById(table, id, body)", 'patchById("/contracts", contractId("Figma Organization"), { notes: "Renews automatically." })', [
    [isPath(table), `table is ${show(table)}; it is the table as "/<table_name>"`],
    [(typeof id === "string" && id !== "") || typeof id === "number", `id is ${show(id)}; it is the row's id, from idsByKey`],
    [!!body && typeof body === "object" && !Array.isArray(body) && Object.keys(body).length > 0, "body is an object with the columns to change"],
  ]);
  const res = await pgRequest("PATCH", `${tableOf(table)}?id=eq.${encodeURIComponent(String(id))}`, body);
  if (!Array.isArray(res) || res.length !== 1) {
    throw new Error(`patchById ${table}: expected 1 row back, got ${Array.isArray(res) ? res.length : typeof res}`);
  }
  return res[0];
}

/**
 * Empties tables this build seeded, so a changed script can seed them again. `tables` is in delete order,
 * children first, each with the row count it holds:
 *   await clearSeeded([["/contracts", 4], ["/vendors", 3]]);
 * Every table is counted before the first delete, and a count that differs halts with nothing deleted, because
 * the other rows are not the seed's. Deletes by id, at most `BATCH_SIZE` per call. In a check pass the counts are
 * read and the deletes are recorded, never sent, and later reads no longer see those rows. Use it only on entities
 * the build created.
 */
export async function clearSeeded(tables: ReadonlyArray<readonly [path: string, expected: number]>): Promise<void> {
  site();
  const isTable = (x: unknown) => Array.isArray(x) && x.length === 2 && isPath(x[0]) && Number.isInteger(x[1]) && x[1] >= 0;
  checkArgs("clearSeeded(tables)", 'clearSeeded([["/contracts", 4], ["/vendors", 3]])', [
    [Array.isArray(tables) && tables.length > 0 && tables.every(isTable), `tables holds ${Array.isArray(tables) ? badEntries(tables, isTable) || "nothing" : show(tables)}; each entry is ["/<table_name>", the rows it holds], children first`],
  ]);
  clearStarted = true;
  const ids = new Map<string, Array<string | number>>();
  const wrong: string[] = [];
  for (const [path, expected] of tables) {
    const table = tableOf(path);
    const rows: any[] = await pgRequest("GET", `${table}?select=id`);
    if (rows.length !== expected) wrong.push(`${table} holds ${rows.length} row(s), expected ${expected}`);
    ids.set(table, rows.map((r) => r.id));
  }
  if (wrong.length) {
    throw new Error(
      `clearSeeded: nothing deleted, ${wrong.length} table(s) do not hold the expected rows:\n  - ${wrong.join("\n  - ")}\n` +
      `The other rows are not the seed's. Stop and tell the user; do not copy these numbers into the script.`,
    );
  }
  for (const [table, rowIds] of ids) {
    for (const part of chunk(rowIds)) {
      const res = await pgRequest("DELETE", `${table}?${inFilter("id", part)}`);
      if (!isCheckRun() && (!Array.isArray(res) || res.length !== part.length)) {
        throw new Error(
          `clearSeeded ${table}: asked to delete ${part.length} row(s), PostgREST returned ${Array.isArray(res) ? res.length : typeof res} ` +
          `(a parent listed before its child, or RLS); halting`,
        );
      }
    }
    say(`  ${tag()}✓ ${table}: ${rowIds.length} row(s) ${isCheckRun() ? "to delete" : "deleted"}`);
  }
}

// ─────────────────────────────── relationships ───────────────────────────────

/** Per table, `_ref` → stored label of every row `idsByKey` read back by its `_ref` in this pass. */
const refLabels = new Map<string, Map<string, string>>();

/** The table that `fk` of `table` points at, as "/<table>"; undefined when no `_ref` was read back in this pass. */
async function refTableOf(table: string, fk: string): Promise<string | undefined> {
  if (!refLabels.size) return undefined;
  const ref = fieldsOf(await metaOf(table)).get(fk)?.reference_table;
  return ref ? `/${ref}` : undefined;
}

/** The label to compare for `want`, a parent in `parentTable`: its stored label when `want` is a `_ref` read back from that table, else `want`. */
const asLabel = (parentTable: string | undefined, want: string): string =>
  (parentTable ? refLabels.get(parentTable)?.get(want) : undefined) ?? want;

/**
 * Turns a parent's key (its label, or its `_ref`) into its id, read back from the platform:
 *   const vendorId = await idsByKey("/vendors", "vendor_name", vendorRows);
 *   vendor_id: vendorId("Adobe")
 * The function throws on a key that was not seeded, so a typo is a halt, not a wrong id. Throws here when a
 * seeded key is absent from the table or matches more than one row. For a table keyed on `_ref`, it also
 * remembers each row's stored label, so `assertParents` and `assertJunction` take the parent's `_ref` as the
 * child rows name it. `labelOf(key)` gives the parent's stored `_label`; a check pass gives the key back.
 */
export async function idsByKey(
  path: string, keyField: string, rows: ReadonlyArray<Row>,
): Promise<((key: string) => string | number) & { labelOf: (key: string) => string }> {
  site();
  checkArgs("idsByKey(path, keyField, rows)", 'idsByKey("/vendors", "vendor_name", vendorRows)', [
    [isPath(path), `path is ${show(path)}; it is the table as "/<table_name>"`],
    [typeof keyField === "string" && keyField !== "", `keyField is ${show(keyField)}; it is the key the rows were seeded with (the label column, or "_ref")`],
    [isRows(rows), "rows is the list of planned rows seeded into that table"],
  ]);
  const table = tableOf(path);
  const k = await keyer("idsByKey", table, keyField, rows, ["id", "_label"]);
  const found = await readKeyed(k, table);
  const absent = k.keys.filter((key) => !found.has(key));
  if (absent.length) throw new Error(`idsByKey ${table}: ${absent.length} seeded ${keyField} value(s) not found on read-back: ${preview(absent)}`);
  const repeated = k.keys.filter((key) => found.get(key)!.length > 1);
  if (repeated.length) throw new Error(`idsByKey ${table}: ${keyField} matches more than one row for ${preview(repeated)}; clear the earlier rows with clearSeeded or rename`);
  if (keyField === REF) {
    const labels = refLabels.get(table) ?? new Map<string, string>();
    for (const key of k.keys) {
      const label = found.get(key)![0]._label;
      if (label !== undefined && label !== null) labels.set(key, String(label));
    }
    refLabels.set(table, labels);
  }
  const rowOf = (key: string) => {
    const hit = found.get(key);
    if (!hit) throw new Error(`idsByKey ${table}: no seeded ${keyField} "${key}"; seeded: ${preview(k.keys)}`);
    return hit[0];
  };
  return Object.assign((key: string) => rowOf(key).id, {
    labelOf: (key: string): string => (isCheckRun() && rowOf(key)._label === undefined ? key : String(rowOf(key)._label ?? "")),
  });
}

const SPINE = " › ";

/**
 * Reads the child rows back with their `<fkField>_label` and compares each with the parent the script meant.
 * `rows` are the child rows as planned (keyed by `keyField`, their label column or `_ref`); `parentLabels[i]`
 * names the parent intended for `rows[i]` by its key, as the child rows do: its label, or its `_ref` when it is
 * keyed on one (compared with the label `idsByKey` read back for that `_ref`), or `null` for a row whose optional
 * relationship is meant to be empty. A composed label shows ancestors first ("Region › Vendor"); a label that
 * ends with the intended one after " › " matches. Throws naming every wrong row. On a real pass only.
 */
export async function assertParents(
  path: string, keyField: string, fkField: string,
  rows: ReadonlyArray<Row>, parentLabels: ReadonlyArray<string | null>,
): Promise<void> {
  site();
  checkArgs("assertParents(path, keyField, fkField, rows, parentLabels)",
    'assertParents("/contracts", "contract_name", "vendor_id", contractRows, plan.map((p) => p.vendor))', [
    [isPath(path), `path is ${show(path)}; it is the child table as "/<table_name>"`],
    [typeof keyField === "string" && keyField !== "", `keyField is ${show(keyField)}; it is the child's key (its label column, or "_ref")`],
    [typeof fkField === "string" && fkField !== "", `fkField is ${show(fkField)}; it is the child's relationship field, such as "vendor_id"`],
    [isRows(rows), "rows is the list of planned child rows"],
    [Array.isArray(parentLabels) && parentLabels.every((l) => l === null || typeof l === "string"),
      `parentLabels holds ${Array.isArray(parentLabels) ? badEntries(parentLabels, (l) => l === null || typeof l === "string") : show(parentLabels)}; each entry is the intended parent's key from the plan (its label, or its _ref when it is keyed on one), or null for an empty relationship, never an id`],
  ]);
  const table = tableOf(path);
  if (rows.length !== parentLabels.length) {
    throw new Error(`assertParents ${table}.${fkField}: ${rows.length} row(s) but ${parentLabels.length} intended parent label(s)`);
  }
  keysOf("assertParents", table, keyField, rows);
  parentLabels.forEach((l, i) => {
    if (l === "") throw new Error(`assertParents ${table}.${fkField}: row ${i} has no intended parent label (null means the relationship is meant to be empty)`);
  });
  if (isCheckRun()) {
    say(`  [check run] ${table}.${fkField}: parent labels are read back on the real run`);
    return;
  }
  const column = `${fkField}_label`;
  const k = await keyer("assertParents", table, keyField, rows, [column]);
  const stored = await readKeyed(k, table);
  const parentTable = await refTableOf(table, fkField);
  const wrong: string[] = [];
  k.keys.forEach((key, i) => {
    const got = stored.get(key)?.[0]?.[column];
    const text = got === undefined ? undefined : String(got ?? "");
    const named = parentLabels[i];
    const want = named === null ? null : asLabel(parentTable, named);
    const matches = text !== undefined && (want === null ? text === "" : text === want || text.endsWith(`${SPINE}${want}`));
    const intended = want === null ? "no parent" : `parent "${want}"${want !== named ? ` (_ref "${named}")` : ""}`;
    if (!matches) wrong.push(`${key}: intended ${intended}, stored "${text ?? "(row not found)"}"`);
  });
  if (wrong.length) {
    throw new Error(
      `assertParents ${table}.${fkField}: ${wrong.length} of ${k.keys.length} row(s) name the wrong parent:\n  - ${wrong.join("\n  - ")}\n` +
      `Fix each with patchById (or clearSeeded and seed again), then check again.`,
    );
  }
  say(`  ✓ ${table}.${fkField}: all ${k.keys.length} row(s) name the intended parent`);
}

/**
 * Checks a connecting record (junction) table as a set of rows: reads every row back with both `<fkA>_label`
 * and `<fkB>_label` and compares them with the pairs the script meant; every intended pair must be there and
 * nothing else. Each side names its parent by its key, as `assertParents` does: its label, or its `_ref` when it
 * is keyed on one. Meant for a table this script just created. Real pass only, like `assertParents`.
 *   await assertJunction("/seats", "application_id", "user_id", [["Slack", "Maria Lopez"], ["Figma", "Tom Becker"]]);
 */
export async function assertJunction(
  path: string, fkA: string, fkB: string, pairs: ReadonlyArray<readonly [string, string]>,
): Promise<void> {
  site();
  const isPair = (x: unknown) => Array.isArray(x) && x.length === 2 && x.every((v) => typeof v === "string");
  checkArgs("assertJunction(path, fkA, fkB, pairs)", 'assertJunction("/seats", "application_id", "user_id", [["Slack", "Maria Lopez"]])', [
    [isPath(path), `path is ${show(path)}; it is the connecting record's table as "/<table_name>"`],
    [typeof fkA === "string" && fkA !== "" && typeof fkB === "string" && fkB !== "", "fkA and fkB are its two parent fields"],
    [Array.isArray(pairs) && pairs.every(isPair), `pairs holds ${Array.isArray(pairs) ? badEntries(pairs, isPair) : show(pairs)}; each pair is [label of A, label of B]`],
  ]);
  const table = tableOf(path);
  pairs.forEach(([a, b], i) => { if (!a || !b) throw new Error(`assertJunction ${table}: pair ${i} has an empty label`); });
  if (isCheckRun()) {
    say(`  [check run] ${table}.${fkA}/${fkB}: pairs are read back on the real run`);
    return;
  }
  const [colA, colB] = [`${fkA}_label`, `${fkB}_label`];
  const stored: Array<{ a: string; b: string }> = (await pgRequest("GET", `${table}?select=${colA},${colB}`))
    .map((r: Row) => ({ a: String(r[colA] ?? ""), b: String(r[colB] ?? "") }));
  const same = (got: string, want: string) => got === want || got.endsWith(`${SPINE}${want}`);
  const [tableA, tableB] = [await refTableOf(table, fkA), await refTableOf(table, fkB)];
  const missing: string[] = [];
  for (const [a, b] of pairs.map(([a, b]) => [asLabel(tableA, a), asLabel(tableB, b)] as const)) {
    const at = stored.findIndex((s) => same(s.a, a) && same(s.b, b));
    if (at < 0) missing.push(`${a} + ${b}`); else stored.splice(at, 1);
  }
  if (missing.length || stored.length) {
    throw new Error(
      `assertJunction ${table}.${fkA}/${fkB}:` +
      (missing.length ? `\n  - ${missing.length} intended pair(s) not stored: ${missing.join("; ")}` : "") +
      (stored.length ? `\n  - ${stored.length} stored row(s) not intended: ${stored.map((s) => `${s.a} + ${s.b}`).join("; ")}` : "") +
      `\nFix with patchById (or clearSeeded and seed again), then check again.`,
    );
  }
  say(`  ✓ ${table}.${fkA}/${fkB}: all ${pairs.length} row(s) name the intended parents`);
}

// ─────────────────────────────── generators ───────────────────────────────

/**
 * Seeded random generator, one per table: `const r = rng("contracts")`. The seed is fixed (42) and the table
 * name gives each table its own sequence, so a re-run of the UNCHANGED script draws the same values, and each
 * pass of one run restarts every stream (dates from `days()` and `at()` are relative to the run day). Never
 * `Math.random()`.
 *   - `r.pick(pool)`         one random entry; repeats are fine (job title, email local part)
 *   - `r.int(min, max)`      an integer in [min, max] (house number, quantity, amount, day offset)
 *   - `r.chance(p)`          true with probability p (booleans with a realistic mix)
 *   - `r.deal(pool, n)`      n entries, shuffled, every pool entry once before any repeats: enum values (each
 *                            value appears once n >= the value count; repeat a value in the pool to weight
 *                            it), parents dealt to children, places
 *   - `r.distinct(pool, n)`  n DIFFERENT entries; throws when the pool has fewer than n (names, labels)
 *   - `r.tuples(n, pools)`   n DISTINCT combinations, each part dealt (first + last name, two-word names);
 *                            throws when the pools cannot give n combinations
 */
export function rng(stream: string, seed = 42) {
  checkArgs("rng(stream, seed?)", 'rng("contracts")', [
    [typeof stream === "string" && stream !== "", `stream is ${show(stream)}; it names the table the values are for`],
    [Number.isInteger(seed), `seed is ${show(seed)}; leave it out`],
  ]);
  let s = 0;
  const restart = (): void => {
    s = seed >>> 0;
    for (let k = 0; k < stream.length; k++) s = Math.imul(s ^ stream.charCodeAt(k), 0x01000193) >>> 0;
  };
  restart();
  streams.add(restart);
  const next = (): number => {   // mulberry32
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const nonEmpty = (pool: readonly unknown[], what: string) => {
    if (!pool.length) throw new Error(`rng("${stream}").${what}: empty pool`);
  };
  const int = (min: number, max: number): number => min + Math.floor(next() * (max - min + 1));
  const chance = (p: number): boolean => next() < p;
  const pick = <T>(pool: readonly T[]): T => {
    nonEmpty(pool, "pick");
    return pool[Math.floor(next() * pool.length)];
  };
  const deal = <T>(pool: readonly T[], n: number): T[] => {
    nonEmpty(pool, "deal");
    const out: T[] = [];
    while (out.length < n) {
      const round = [...pool];
      for (let k = round.length - 1; k > 0; k--) {
        const j = Math.floor(next() * (k + 1));
        [round[k], round[j]] = [round[j], round[k]];
      }
      out.push(...round);
    }
    return out.slice(0, n);
  };
  const distinct = <T>(pool: readonly T[], n: number): T[] => {
    const values = [...new Set(pool)];
    if (values.length < n) {
      throw new Error(`rng("${stream}").distinct: ${n} different entries asked, the pool has ${values.length}; build them with r.tuples`);
    }
    return deal(values, n);
  };
  const tuples = <T>(n: number, pools: ReadonlyArray<readonly T[]>): T[][] => {
    pools.forEach((p) => nonEmpty(p, "tuples"));
    const sets = pools.map((p) => [...new Set(p)]);   // a repeated pool entry is not a second value
    const space = sets.reduce((acc, p) => acc * p.length, 1);
    if (space < n) {
      throw new Error(`rng("${stream}").tuples: ${n} distinct combinations asked, the pools give only ${space}; add pool entries`);
    }
    const key = (t: T[]) => JSON.stringify(t);
    const seen = new Set<string>();
    const firstFree = (): T[] => {   // near exhaustion: walk the combinations in order
      for (let idx = 0; ; idx++) {
        let q = idx;
        const t = sets.map((p) => { const v = p[q % p.length]; q = Math.floor(q / p.length); return v; });
        if (!seen.has(key(t))) return t;
      }
    };
    const columns = sets.map((p) => deal(p, n));
    const out: T[][] = [];
    for (let k = 0; k < n; k++) {
      let t = columns.map((c) => c[k]);
      for (let tries = 0; seen.has(key(t)) && tries < 100; tries++) t = sets.map((p) => pick(p));
      if (seen.has(key(t))) t = firstFree();
      seen.add(key(t));
      out.push(t);
    }
    return out;
  };
  return { next, int, chance, pick, deal, distinct, tuples };
}

const LATIN: Record<string, string> = { "ø": "o", "æ": "ae", "œ": "oe", "ß": "ss", "ł": "l", "đ": "d", "ð": "d", "þ": "th", "ı": "i" };

/**
 * Lowercase ASCII token for email local parts and domains: letters without a decomposed form transliterated
 * (ø → o, æ → ae, ß → ss, ł → l, đ → d), accents stripped, everything but a-z / 0-9 dropped.
 * `slugify("Søren Østergaard")` → "sorenostergaard". Throws when nothing Latin is left (`李伟`): such a name
 * carries a Latin form for its email.
 */
export function slugify(s: string): string {
  const out = s.toLowerCase()
    .replace(/[øæœßłđðþı]/g, (c) => LATIN[c])
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]/g, "");
  if (!out) throw new Error(`slugify("${s}"): no Latin letters left; give the name a Latin form for its email`);
  return out;
}

/** Email / web domain for an invented company: `exampleDomain("Beacon Foods")` → "beaconfoods.example.com". Subdomains of example.com are reserved and never receive mail. */
export const exampleDomain = (companyName: string): string => `${slugify(companyName)}.example.com`;

/** Token for a code-like `unique_value` field the model already has (account code, SKU): `uniq("ACCT-", i)` → "ACCT-0", "ACCT-1", … Never on a field a person reads as a name, and never a reason to add a field. */
export const uniq = (base: string, i: number, suffix = ""): string => `${base}${i}${suffix}`;

/** A date `d` days from today (negative for the past) as `YYYY-MM-DD`: `days(-30)`, `days(rng.int(60, 400))`. */
export const days = (d: number): string => {
  checkArgs("days(n)", "days(-30)", [[isCount(d), `n is ${show(d)}; it is a number of days from today`]]);
  return new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);
};

/** A date-time `d` days from today at `hhmm` UTC: `at(-3, "09:30")` → "2026-11-09T09:30:00Z". Built from the day, never the clock, so both passes plan the same rows. */
export const at = (d: number, hhmm = "09:00"): string => {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(hhmm)) throw new Error(`at(${d}, "${hhmm}"): the time is HH:MM, from 00:00 to 23:59`);
  return `${days(d)}T${hhmm}:00Z`;
};

// ─────────────────────────────── guards ───────────────────────────────

/** Every table landed but the numbers must change, so a plain re-run keeps the old rows. */
class SeedPlanError extends Error {}

/**
 * Scale guard, before the first write: a parent's stored figure that its child rows itemize (seats purchased over
 * seat rows) stays between the number of those rows and twice that, because a small dataset cannot carry a real
 * company's numbers. Each entry is the parent's label, its figure and its number of child rows:
 *   assertItemized("subscriptions.seats_purchased", plan.map((p) => [p.name, p.seats_purchased, p.seats.length]));
 * Throws naming every parent outside the range. It reads nothing, so a check pass applies it the same way.
 */
export function assertItemized(column: string, parents: ReadonlyArray<readonly [label: string, figure: number, children: number]>): void {
  site();
  const isEntry = (x: unknown) => Array.isArray(x) && x.length === 3 && typeof x[0] === "string" && isCount(x[1]) && isCount(x[2]);
  checkArgs("assertItemized(column, parents)", 'assertItemized("subscriptions.seats_purchased", plan.map((p) => [p.name, p.seats_purchased, p.seats.length]))', [
    [typeof column === "string" && column !== "", `column is ${show(column)}; it is "<table>.<figure column>"`],
    [Array.isArray(parents) && parents.every(isEntry), `parents holds ${Array.isArray(parents) ? badEntries(parents, isEntry) : show(parents)}; each entry is [parent label, figure, number of child rows]`],
  ]);
  beforeFirstWrite(`assertItemized ${column}`);
  if (!parents.length) throw new Error(`assertItemized ${column}: no parents given`);
  const wrong = parents
    .filter(([, figure, children]) => !(figure >= children && figure <= children * 2))
    .map(([label, figure, children]) => `${label}: ${figure} over ${children} child row(s), expected ${children} to ${children * 2}`);
  if (wrong.length) {
    throw new Error(
      `SEED SCALE FAILURE, ${column}: ${wrong.length} of ${parents.length} parent(s) out of scale:\n  - ${wrong.join("\n  - ")}\n` +
      `Set each figure from the parent's child rows in the plan.`,
    );
  }
  say(`  ${tag()}✓ ${column}: ${parents.length} parent(s) at the scale of their child rows`);
}

type StateRules = Readonly<Record<string, { only?: ReadonlyArray<string>; needs?: ReadonlyArray<string> }>>;

/** A state check of this pass: its plan, and the relationship field of its child once the tables are read. */
type StateCheck = {
  name: string; parent: string; child: string; rules: StateRules;
  plan: Map<string, { state: string; children: string[] }>;
  fk?: string; compared: boolean;
};
const stateChecks: StateCheck[] = [];
/** `table` (no slash) → row id → the row's key (label or `_ref`, when seeded with one) and its workflow_state. */
const seededStates = new Map<string, Map<string, { key?: string; state: string }>>();

const quoted = (xs: ReadonlyArray<unknown>): string => xs.map((x) => JSON.stringify(x)).join(", ");
const STATE_RULE_SHAPE =
  'A rule is { only: [...], needs: [...] }, each a list of child states written as strings: only: ["draft", "sent"] allows ' +
  'child rows in those states, only: [] allows no child rows, and needs: ["accepted"] asks for at least one child in one of ' +
  "them. A parent with no child rows passes every only.";

/** What is wrong with the arguments of `assertStatesAgree`, each with the call that would be right. */
function stateArgProblems(name: unknown, parents: unknown, rules: unknown): string[] {
  const out: string[] = [];
  if (typeof name !== "string" || !/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(name)) {
    out.push(`the name ${JSON.stringify(name)} is "<parent table>.<child table>", e.g. "applications.offers"`);
  }
  if (!Array.isArray(parents)) {
    out.push(`parents is a list of [label, state, child states] entries, e.g. [["Ana Silva", "hired", ["accepted"]]]`);
  } else {
    parents.forEach((p, i) => {
      const ok = Array.isArray(p) && p.length === 3 && typeof p[0] === "string" && typeof p[1] === "string" &&
        Array.isArray(p[2]) && p[2].every((s: unknown) => typeof s === "string");
      if (!ok && out.length < 6) {
        out.push(`parents[${i}] is ${JSON.stringify(p)?.slice(0, 80)}; an entry is [label, state, child states], e.g. ["Ana Silva", "hired", ["accepted"]]`);
      }
    });
  }
  if (!rules || typeof rules !== "object" || Array.isArray(rules)) {
    out.push(`rules maps each parent state to its rule, e.g. { applied: { only: [] }, hired: { needs: ["accepted"] } }`);
    return out;
  }
  for (const [state, rule] of Object.entries(rules as Record<string, unknown>)) {
    if (!rule || typeof rule !== "object" || Array.isArray(rule)) {
      out.push(`rules.${state} is ${JSON.stringify(rule)}; a rule is an object such as { only: ["draft", "sent"] }`);
      continue;
    }
    for (const [key, list] of Object.entries(rule as Record<string, unknown>)) {
      if (key !== "only" && key !== "needs") { out.push(`rules.${state} has "${key}"; a rule takes only "only" and "needs"`); continue; }
      if (!Array.isArray(list)) { out.push(`rules.${state}.${key} is ${JSON.stringify(list)}; write it as a list of states, e.g. ${key}: ["sent"]`); continue; }
      const bad = list.filter((s) => typeof s !== "string");
      if (bad.length) {
        const flat = [...new Set((list as unknown[]).flat(Infinity).filter((s): s is string => typeof s === "string"))];
        out.push(`rules.${state}.${key} holds ${quoted(bad)}, which are not states; ${key} lists child states, one string each: write ${key}: [${quoted(flat)}]`);
      }
    }
  }
  return out;
}

/** The problems of one parent whose state is `state` and whose child rows are in `children`. */
function agreementProblems(who: string, state: string, children: ReadonlyArray<string>, rules: StateRules): string[] {
  const rule = rules[state];
  if (!rule) return [];
  const out: string[] = [];
  const outside = rule.only ? [...new Set(children.filter((c) => !rule.only!.includes(c)))] : [];
  if (outside.length) {
    out.push(`${who} (${JSON.stringify(state)}): child state ${quoted(outside)} not allowed; ${rule.only!.length ? `allowed: ${quoted(rule.only!)}` : "no child rows allowed"}`);
  }
  if (rule.needs && !children.some((c) => rule.needs!.includes(c))) {
    out.push(`${who} (${JSON.stringify(state)}): needs a child in ${rule.needs.map((s) => JSON.stringify(s)).join(" or ")}, has ${children.length ? quoted(children) : "none"}`);
  }
  return out;
}

/** A plan check (it reads nothing) belongs before the first write of the pass, so a mistake in the plan halts at once. */
function beforeFirstWrite(who: string): void {
  if (mode && writeCount > 0) {
    throw new Error(
      `${who}: called after ${writeCount} write call(s) of this pass. Call it before the first write, right after the plan at ` +
      `the top of runSeed's body: it reads nothing, so there a mistake in the plan halts at once instead of after the tables are read.`,
    );
  }
}

/**
 * Lifecycle guard, before the first write: a parent's state and the states of its child rows tell one story (a
 * hired application has an accepted offer; an application still at applied has no offer). `name` is
 * "<parent table>.<child table>", for two tables that both carry `workflow_state`. Each entry is the parent's key
 * (its label, or its `_ref`), its state and its child rows' states; `rules` maps a parent state to the child states
 * it allows (`only`, a list of strings; `[]` for no child rows) and the child states it needs at least one of (`needs`):
 *   assertStatesAgree("applications.offers", plan.map((a) => [a.name, a.state, a.offers.map((o) => o.state)]), {
 *     applied: { only: [] },
 *     hired: { needs: ["accepted"], only: ["accepted"] },
 *   });
 * A parent state the rules do not name allows any children; a rule whose state no parent has halts (a typo, or a
 * state the plan never deals). Throws naming every parent that disagrees, and on arguments of the wrong shape with the
 * call that would be right. It reads nothing. Inside `runSeed` it also registers the check: the first insert of the pass
 * checks both tables, and the insert of the child table compares the rows actually sent with this plan and these rules.
 */
export function assertStatesAgree(
  name: string,
  parents: ReadonlyArray<readonly [label: string, state: string, childStates: ReadonlyArray<string>]>,
  rules: StateRules,
): void {
  site();
  // Everything knowable now goes in one halt: the shape, a late call, and (once the module's tables are read) the tables.
  const shape = stateArgProblems(name, parents, rules);
  const problems = [...shape];
  if (mode && writeCount > 0) {
    problems.push(`it is called after ${writeCount} write call(s) of this pass. Call it before the first write, right after the plan at the top of runSeed's body: it reads nothing, so there a mistake in the plan halts at once instead of after the tables are read`);
  }
  if (typeof name === "string" && name.includes(".")) {
    const [parent, child] = name.split(".");
    const pm = metaCache.get(`/${parent}`), cm = metaCache.get(`/${child}`);
    if (pm && cm) problems.push(...stateTableProblems(parent, child, pm, cm).problems);
  }
  if (problems.length) {
    throw new Error(`assertStatesAgree ${String(name)}: ${problems.length} problem(s):\n  - ${problems.join("\n  - ")}${shape.length ? `\n${STATE_RULE_SHAPE}` : ""}`);
  }
  if (!parents.length) throw new Error(`assertStatesAgree ${name}: no parents given`);
  if (!Object.keys(rules).length) throw new Error(`assertStatesAgree ${name}: no rules given; name each parent state that limits its children`);
  const emptyNeeds = Object.keys(rules).filter((s) => rules[s].needs?.length === 0);
  if (emptyNeeds.length) throw new Error(`assertStatesAgree ${name}: "needs" is empty for ${emptyNeeds.join(", ")}; name the child states, or leave "needs" out`);
  const states = new Set(parents.map(([, state]) => state));
  const unused = Object.keys(rules).filter((s) => !states.has(s));
  if (unused.length) throw new Error(`assertStatesAgree ${name}: no parent is in state ${unused.join(", ")}; fix the state name, give a parent that state in the plan, or drop that rule`);
  const twice = [...new Set(parents.map(([label]) => label).filter((l, i, all) => all.indexOf(l) !== i))];
  if (twice.length) throw new Error(`assertStatesAgree ${name}: ${quoted(twice)} appear more than once among the parents; list each parent once, with all its child states`);
  const wrong = parents.flatMap(([label, state, children]) => agreementProblems(JSON.stringify(label), state, children, rules));
  if (wrong.length) {
    throw new Error(
      `SEED LIFECYCLE FAILURE, ${name}: ${wrong.length} problem(s):\n  - ${wrong.join("\n  - ")}\n` +
      `Set each parent's state and its children's states together in the plan. Fix the plan's rows, or the shape of a rule; ` +
      `never widen a rule until it passes: that leaves the contradiction in the data.`,
    );
  }
  if (mode) {
    const [parent, child] = name.split(".");
    stateChecks.push({
      name, parent, child, rules, compared: false,
      plan: new Map(parents.map(([label, state, children]) => [label, { state, children: [...children].sort() }])),
    });
  }
  say(`  ${tag()}✓ ${name}: ${parents.length} parent(s) agree with their children`);
}

/** The `workflow_state` default of `table`, for a row that does not send one. */
const defaultState = (table: string): string => String(metaCache.get(`/${table}`)?.fields.get("workflow_state")?.default_value ?? "");

/** What is wrong with the two tables of a state check: both carry workflow_state, and the child has one relationship field to the parent. */
function stateTableProblems(parent: string, child: string, pm: TableMeta, cm: TableMeta): { problems: string[]; fk?: string } {
  const problems: string[] = [];
  for (const [t, m] of [[parent, pm], [child, cm]] as const) {
    const F = fieldsOf(m);
    if (!F.has("workflow_state")) {
      const enums = [...F.values()].filter((f) => f.format === "enum").map((f) => f.field_name);
      problems.push(
        `${t} has no workflow_state${enums.length ? ` (its states are in ${enums.join(", ")})` : ""}. ` +
        `The check pairs a parent and a child table that both carry workflow_state, so remove this check`,
      );
    }
  }
  const fks = [...fieldsOf(cm).values()].filter((f) => ["reference", "parent"].includes(f.format) && f.reference_table === parent).map((f) => f.field_name);
  if (fks.length !== 1) {
    problems.push(`${child} has ${fks.length ? `${fks.length} relationship fields to ${parent} (${fks.join(", ")}), so the check cannot tell which one counts` : `no relationship field to ${parent}`}`);
  }
  return { problems, fk: fks.length === 1 ? fks[0] : undefined };
}

/** At an insert: both tables of every state check exist and carry workflow_state, and the child relates to the parent. */
async function settleStateTables(): Promise<void> {
  for (const c of stateChecks) {
    if (c.fk) continue;
    const meta = async (t: string) => {
      try { return await metaOf(`/${t}`); } catch {
        throw new Error(`assertStatesAgree ${c.name}: ${t} is not an entity on this host; the name is "<parent table>.<child table>"`);
      }
    };
    const { problems, fk } = stateTableProblems(c.parent, c.child, await meta(c.parent), await meta(c.child));
    if (problems.length) throw new Error(`assertStatesAgree ${c.name}: ${problems.join("; ")}.`);
    c.fk = fk;
  }
}

/** After an insert: the key and workflow_state of each row, so a later child insert can be compared with its parents. */
function recordStates(table: string, rows: ReadonlyArray<Row>, ids: ReadonlyArray<unknown>, keys?: ReadonlyArray<string>): void {
  const name = table.slice(1);
  if (!metaCache.get(table)?.fields.has("workflow_state")) return;
  const byId = seededStates.get(name) ?? new Map();
  rows.forEach((r, i) => {
    if (ids[i] === undefined || ids[i] === null) return;
    byId.set(String(ids[i]), { key: keys?.[i], state: String(r.workflow_state ?? defaultState(name)) });
  });
  seededStates.set(name, byId);
}

/**
 * Before the child rows of a state check are sent: their states, read from the rows themselves, against the rules and
 * against the plan the check was given. A plan built apart from the rows (a hand-made list) cannot pass for them.
 */
async function compareStates(table: string, rows: ReadonlyArray<Row>): Promise<void> {
  const checks = stateChecks.filter((c) => c.child === table.slice(1));
  if (!checks.length) return;
  await settleStateTables();
  const problems: string[] = [];
  for (const c of checks) {
    c.compared = true;
    const fk = c.fk!;
    const parents = new Map(seededStates.get(c.parent) ?? []);
    const unknown = [...new Set(rows.map((r) => r[fk]).filter((v) => v !== null && v !== undefined && !parents.has(String(v))).map(String))];
    for (const part of chunk(unknown)) {
      for (const r of await pgRequest("GET", `/${c.parent}?select=id,workflow_state&${inFilter("id", part)}`)) parents.set(String(r.id), { state: String(r.workflow_state) });
    }
    const byParent = new Map<string, string[]>();
    for (const r of rows) {
      if (r[fk] === null || r[fk] === undefined) continue;
      const pid = String(r[fk]);
      byParent.set(pid, [...(byParent.get(pid) ?? []), String(r.workflow_state ?? defaultState(c.child))]);
    }
    const who = (pid: string) => (parents.get(pid)?.key !== undefined ? JSON.stringify(parents.get(pid)!.key) : `${c.parent} ${pid}`);
    // the plan against the rows: the same parents, in the same states, with the same child states
    const seeded = [...(seededStates.get(c.parent) ?? [])];
    const keyed = seeded.filter(([, p]) => p.key !== undefined);
    for (const [pid, p] of keyed) {
      const planned = c.plan.get(p.key!);
      const sent = [...(byParent.get(pid) ?? [])].sort();
      if (!planned) { problems.push(`${who(pid)} (${JSON.stringify(p.state)}) was seeded, but the check's plan does not list it`); continue; }
      if (planned.state !== p.state) problems.push(`${who(pid)}: the plan says ${JSON.stringify(planned.state)}, the row seeded is ${JSON.stringify(p.state)}`);
      if (JSON.stringify(planned.children) !== JSON.stringify(sent)) {
        problems.push(`${who(pid)}: the plan lists ${planned.children.length ? quoted(planned.children) : "no child rows"}, the rows sent to ${table} have ${sent.length ? quoted(sent) : "none"}`);
      }
    }
    if (keyed.length) {
      const seededKeys = new Set(keyed.map(([, p]) => p.key));
      for (const key of c.plan.keys()) if (!seededKeys.has(key)) problems.push(`${JSON.stringify(key)} is in the check's plan but was not seeded into ${c.parent}`);
    }
    // the rules against the rows, for every parent the rows name and every parent this pass seeded
    for (const [pid, states] of byParent) {
      const p = parents.get(pid);
      if (!p) problems.push(`a row names ${c.parent} id ${pid}, which is not stored`);
      else problems.push(...agreementProblems(who(pid), p.state, states, c.rules));
    }
    for (const [pid, p] of seeded) if (!byParent.has(pid)) problems.push(...agreementProblems(who(pid), p.state, [], c.rules));
  }
  if (problems.length) {
    throw new Error(
      `SEED LIFECYCLE FAILURE, ${checks.map((c) => c.name).join(", ")}: ${problems.length} problem(s) in the rows about to be sent to ${table}:\n  - ` +
      `${problems.slice(0, 15).join("\n  - ")}${problems.length > 15 ? `\n  - … +${problems.length - 15} more` : ""}\n` +
      `Build the check's child states from the same plan the child rows come from (seed-data.md → "Rows that read as records"), ` +
      `then fix the rows or the plan; never widen a rule until it passes.`,
    );
  }
}

/**
 * At the end of a pass: a state check whose child table got no insert was never compared with the rows, and every pair
 * the seed filled of a parent and a child table that both carry workflow_state (one relationship field between them) has
 * its state check, as the verification asks a "✓ … agree with their children" line for each such pair.
 */
function stateChecksCompared(): void {
  const problems = stateChecks.filter((c) => !c.compared).map((c) =>
    `assertStatesAgree ${c.name}: no rows were sent to /${c.child} in this pass, so its plan was never compared with the rows; ` +
    `seed /${c.child} in this script with seedEnsureMany or postMany, or remove the check`);
  for (const child of seededStates.keys()) {
    const byParent = new Map<string, number>();
    for (const f of metaCache.get(`/${child}`)?.fields.values() ?? []) {
      if (["reference", "parent"].includes(f.format) && f.reference_table !== child && seededStates.has(f.reference_table)) {
        byParent.set(f.reference_table, (byParent.get(f.reference_table) ?? 0) + 1);
      }
    }
    for (const [parent, n] of byParent) {
      if (n !== 1 || stateChecks.some((c) => c.parent === parent && c.child === child)) continue;
      problems.push(
        `the seed fills ${parent} and ${child}, which both carry workflow_state, with no assertStatesAgree("${parent}.${child}", …): ` +
        `decide which ${child} states agree with each ${parent} state, and add the check at the top of the script, before the first write ` +
        `(seed-data.md → "Rows that read as records")`,
      );
    }
  }
  if (problems.length) throw new Error(problems.join("\n"));
}

/** In a check pass: the named columns exist (from the table's description; an unmanaged table is read with `limit=0`). */
async function columnsExist(who: string, table: string, keyField: string, columns: ReadonlyArray<string>): Promise<void> {
  const m = await metaOf(table);
  if (!m.managed) {
    await pgRequest("GET", `${table}?select=${[...(keyField === REF ? [] : [keyField]), ...columns].join(",")}&limit=0`);
    return;
  }
  const F = fieldsOf(m);
  const absent = columns.filter((c) => !F.has(c));
  if (absent.length) throw new Error(`${who} ${table}: ${absent.join(", ")} is not a field of ${table}`);
}

/**
 * Read-back guard for `computed` and `rollup` columns: the platform writes them, so only a read shows them. Reads
 * `columns` for the seeded `rows` (keyed by `keyField`, their label column or `_ref`) and halts when a column holds
 * one value on every row, which means its inputs do not differ between the rows. A `$user_id`, `$now` or `$today`
 * stamp is constant on a seed by design (one user, one day): such a column is left out with a printed line instead.
 * Call it at the very end of the script, before `assertSeedCounts`. A check pass only proves the columns exist.
 */
export async function assertComputedVary(
  path: string, keyField: string, rows: ReadonlyArray<Row>, columns: ReadonlyArray<string>,
): Promise<void> {
  site();
  checkArgs("assertComputedVary(path, keyField, rows, columns)", 'assertComputedVary("/vendors", "vendor_name", vendorRows, ["contract_count"])', [
    [isPath(path), `path is ${show(path)}; it is the table as "/<table_name>"`],
    [typeof keyField === "string" && keyField !== "", `keyField is ${show(keyField)}; it is the key the rows were seeded with`],
    [isRows(rows), "rows is the list of planned rows (or what seedEnsureMany returned, for a _ref key)"],
    [isStrings(columns), `columns is ${show(columns)}; it is the list of computed and rollup column names`],
  ]);
  const table = tableOf(path);
  keysOf("assertComputedVary", table, keyField, rows);
  if (!columns.length) throw new Error(`assertComputedVary ${table}: no columns named`);
  if (isCheckRun()) {
    await columnsExist("assertComputedVary", table, keyField, columns);
    say(`  [check run] ${table}: ${columns.join(", ")} are read back on the real run`);
    return;
  }
  const k = await keyer("assertComputedVary", table, keyField, rows, columns);
  const stored = await readKeyed(k, table);
  const absent = k.keys.filter((key) => !stored.has(key));
  if (absent.length) throw new Error(`assertComputedVary ${table}: ${absent.length} seeded ${keyField} value(s) not found on read-back: ${preview(absent)}`);
  if (k.keys.length < 2) {
    say(`  ${table}: one row, so ${columns.join(", ")} cannot be compared`);
    return;
  }
  const fails: string[] = [];
  for (const c of columns) {
    const values = new Set(k.keys.map((key) => String(stored.get(key)![0][c] ?? "")));
    if (values.size > 1) { say(`  ✓ ${table}.${c}: ${values.size} distinct value(s) across ${k.keys.length} row(s)`); continue; }
    const value = [...values][0];
    const stamp = await stampOf(table, c, value);
    if (stamp) say(`  ${table}.${c}: "${value}" on every row, a ${stamp} stamp, so constant by design: left out of the check; name it in the report`);
    else fails.push(`${table}.${c}: "${value}" on all ${k.keys.length} row(s)`);
  }
  if (fails.length) {
    throw new SeedPlanError(
      `SEED COMPUTED VALUE FAILURE, ${fails.length} column(s) hold one value on every row:\n  - ${fails.join("\n  - ")}\n` +
      `Give the rows different inputs in the plan (for a rollup that counts children, different numbers of children), then ` +
      `clearSeeded and seed again. A $user_id, $now or $today stamp is left out by this check itself; never drop any other ` +
      `column and never patch it: the platform writes it.`,
    );
  }
}

/**
 * Approval-stamp proof, at the end of the script: every seeded row in one of `states` (the gated state and the states
 * after it) holds a value in each stamp column, read back from the platform. The rows were already checked before
 * the write; this proves the entity's rule kept what the insert sent (`rbac.md` → "Controls on a gate", control 5).
 * A check pass only proves the columns exist.
 *   await assertStamped("/offers", "_ref", offerRows, ["approved_by_user_id", "approved_at"], ["approved", "sent", "accepted"]);
 */
export async function assertStamped(
  path: string, keyField: string, rows: ReadonlyArray<Row>, columns: ReadonlyArray<string>, states: ReadonlyArray<string>,
): Promise<void> {
  site();
  checkArgs("assertStamped(path, keyField, rows, columns, states)",
    'assertStamped("/offers", "_ref", offerRows, ["approved_by_user_id", "approved_at"], ["approved", "sent", "accepted"])', [
    [isPath(path), `path is ${show(path)}; it is the table as "/<table_name>"`],
    [typeof keyField === "string" && keyField !== "", `keyField is ${show(keyField)}; it is the key the rows were seeded with`],
    [isRows(rows), "rows is the list of planned rows"],
    [isStrings(columns), `columns is ${show(columns)}; it is the list of stamp columns`],
    [isStrings(states), `states is ${show(states)}; it is the list of states at or past the step`],
  ]);
  const table = tableOf(path);
  keysOf("assertStamped", table, keyField, rows);
  if (!columns.length || !states.length) throw new Error(`assertStamped ${table}: name the stamp columns and the states past the step`);
  if (isCheckRun()) {
    await columnsExist("assertStamped", table, keyField, ["workflow_state", ...columns]);
    say(`  [check run] ${table}: ${columns.join(", ")} are read back on the real run`);
    return;
  }
  const k = await keyer("assertStamped", table, keyField, rows, ["workflow_state", ...columns]);
  const stored = await readKeyed(k, table);
  const past = k.keys.map((key) => [key, stored.get(key)?.[0]] as const).filter(([, r]) => r && states.includes(r.workflow_state));
  if (!past.length) { say(`  ${table}: no seeded row is in ${states.join(", ")}, so no stamp to check`); return; }
  const empty = past.flatMap(([key, r]) => columns.filter((c) => r[c] === null || r[c] === undefined || r[c] === "").map((c) => `${key} (${r.workflow_state}): ${c} is empty`));
  if (empty.length) {
    throw new SeedPlanError(
      `SEED STAMP FAILURE, ${table}: ${empty.length} stamp(s) missing on rows past the step:\n  - ${empty.join("\n  - ")}\n` +
      `Send each stamp on the rows past the step (seed-data.md, "Approval stamps on rows past the step"), check that the ` +
      `entity's stamp rules keep what an insert sends (rbac.md → "Controls on a gate", control 5), then clearSeeded and seed again.`,
    );
  }
  say(`  ✓ ${table}: all ${past.length} row(s) past the step carry ${columns.join(", ")}`);
}

/**
 * The variable (`$user_id`, `$now`, `$today`) that makes `column` constant on a seed, or "" when it is no such stamp: its
 * rule reads the variable and not its own field, and its one value is what the variable gives on this run (the seeding
 * user, a time today, today's date). A rule that reads its own field keeps what the seed sent (an approval stamp on a row
 * past its step), so that column is still checked.
 */
async function stampOf(table: string, column: string, value: string): Promise<string> {
  const rule = rulesOf(await metaOf(table)).find((r: any) => r?.name === column);
  if (!rule) return "";
  const text = JSON.stringify(rule.jsonlogic ?? null);
  if (text.includes(`"var":"${column}"`) || text.includes(`"var":["${column}"`)) return "";
  const today = days(0);
  if (text.includes('"$today"') && value === today) return "$today";
  if (text.includes('"$now"') && value.startsWith(today)) return "$now";
  if (text.includes('"$user_id"') && value === (await currentUser()).id) return "$user_id";
  return "";
}

/**
 * Count guard. `expected` is the per-table count the sample-data question named; `counts` is what the script
 * tallied from its own inserts (`counts.vendors = vendors.length`). Throws when a table missed its count
 * (including a table never seeded) or when a table was tallied that `expected` does not name (a typo).
 */
export function assertSeedCounts(counts: Record<string, number>, expected: Record<string, number>): void {
  site();
  const isCounts = (o: unknown) => !!o && typeof o === "object" && !Array.isArray(o) && Object.values(o).every(isCount);
  checkArgs("assertSeedCounts(counts, expected)", "assertSeedCounts(counts, { vendors: 3, contracts: 4 })", [
    [isCounts(counts), `counts is ${show(counts)}; it maps each table to the rows its insert returned`],
    [isCounts(expected), `expected is ${show(expected)}; it maps each table to the count the sample-data question named`],
  ]);
  const fails: string[] = [];
  for (const [table, want] of Object.entries(expected)) {
    const n = counts[table] ?? 0;
    if (n === want) say(`  ${tag()}✓ ${table}: ${n}`);
    else fails.push(`${table} seeded ${n}, expected ${want}${table in counts ? "" : " (table never seeded)"}`);
  }
  for (const table of Object.keys(counts)) {
    if (!(table in expected)) fails.push(`${table} was seeded but is not in the expected counts (typo?)`);
  }
  if (fails.length) throw new Error(`SEED COUNT FAILURE, ${fails.length} problem(s):\n  - ${fails.join("\n  - ")}`);
  say(`\n${tag()}All ${Object.keys(expected).length} table(s) at target${isCheckRun() ? " (nothing was sent)" : ""}.`);
}

/**
 * Distinctness guard: a count proves the table is full, not that every row carries the same surname, company
 * or a one-word label. Fails when a human-facing column has fewer than `minDistinct` different values
 * (default: the smaller of the row count and 8). Empty strings and nulls are not counted. Call it only on
 * columns where variety is expected, with a part that lives inside a combined value passed as its own column.
 */
export function assertSeedDistinct(
  table: string, rows: ReadonlyArray<Row>, fields: ReadonlyArray<string>, minDistinct = Math.min(rows.length, 8),
): void {
  site();
  const absent = isRows(rows) && isStrings(fields) && rows.length ? fields.filter((f) => !rows.some((r) => f in r)) : [];
  checkArgs("assertSeedDistinct(table, rows, fields, minDistinct?)", 'assertSeedDistinct("vendors", vendorRows, ["vendor_name"])', [
    [typeof table === "string" && table !== "", `table is ${show(table)}; it names what is checked, such as "vendors"`],
    [isRows(rows), "rows is a list of row objects"],
    [isStrings(fields), `fields is ${show(fields)}; it is a list of column names`],
    [!absent.length, `${absent.join(", ")} is on no row (a typo?)`],
    [isCount(minDistinct), `minDistinct is ${show(minDistinct)}; leave it out, or give a number`],
  ]);
  const fails: string[] = [];
  for (const f of fields) {
    const values = rows.map((r) => r[f]).filter((v) => v !== "" && v !== null && v !== undefined);
    const distinct = new Set(values.map((v) => String(v))).size;
    if (distinct >= Math.min(minDistinct, values.length)) say(`  ${tag()}✓ ${table}.${f}: ${distinct} distinct`);
    else fails.push(`${table}.${f}: ${distinct} distinct value(s) across ${rows.length} row(s), expected >= ${minDistinct}`);
  }
  if (fails.length) throw new Error(`SEED DISTINCTNESS FAILURE, ${fails.length} problem(s):\n  - ${fails.join("\n  - ")}\nDeal the field from a larger pool (r.deal / r.tuples).`);
}

/** What to do after a halt the script can fix: `shown` when the halt printed the call as the file holds it now. */
const fixHint = (shown: boolean): string =>
  `Change ${shown ? "these lines" : "the lines named"}, and every other call of the script that makes the same mistake, in one edit, ` +
  `with your file-edit tool, or edit-file.ts when there is none (cli-usage.md → "Ad-hoc JSON and file work in Bun"), copying the ` +
  `old text from ${shown ? "the lines above" : "the file"}, never from memory. Never Python, and never retype the script. Fix the ` +
  `plan's rows or the shape of a call; never widen a rule until it passes: that leaves the contradiction in the data. Run the ` +
  `script again only once the cause is fixed: an unchanged script against unchanged tables halts the same way.`;

/**
 * Halting harness: runs the seed script's body as a check pass, then, only when that passed, as the real pass.
 * `--check` (or `SEED_CHECK=1`) stops after the check pass. Exits non-zero on any thrown error, naming the script
 * line of the failing call. A halt in the check pass sent nothing. After a halt in the real pass, the tables
 * written before the failing call have landed; a re-run converges for tables seeded with `seedEnsureMany`. A
 * script that only clears ends `Clear finished`, never `Seed finished`.
 */
export async function runSeed(body: () => Promise<void>): Promise<void> {
  const checkOnly = checkOnlyAsked();
  let pass: Mode = "check";
  try {
    passPlan.clear(); passSeen.clear();
    mode = "check"; quiet = !checkOnly; resetPass();
    await body();
    stateChecksCompared();
    quiet = false;
    const clearOnlyCheck = clearStarted && !rowsInserted;
    if (checkOnly) {
      console.log(clearOnlyCheck
        ? `\nCHECK RUN passed: ${writeCount} delete call(s) checked, none sent, nothing cleared. Run the script again without --check to clear.`
        : `\nCHECK RUN passed: ${writeCount} write call(s) checked, none sent, nothing seeded. Run the script again without --check to seed.`);
      return;
    }
    console.log(`Check pass: ${writeCount} ${clearOnlyCheck ? "delete" : "write"} call(s) checked, nothing sent. Real pass:`);
    pass = "real"; mode = "real"; resetPass(); passSeen.clear();
    await body();
    stateChecksCompared();
    const clearOnly = clearStarted && !rowsInserted;
    console.log(clearOnly
      ? `\nClear finished: ${writeCount} delete call(s) applied with no errors. Nothing was seeded: run the seed script next.`
      : `\nSeed finished: ${writeCount} write call(s) applied with no errors.`);
  } catch (err) {
    quiet = false;
    const message = err instanceof Error ? err.message : String(err);
    // a throw in the script names its own line; a helper's halt names the line that called it
    const frame = (err instanceof Error && scriptFrameOf(err.stack ?? "")) || lastFrame;
    const line = (err instanceof Error && scriptFrame(err.stack ?? "")) || lastSite;
    const source = frame ? callSource(frame) : "";
    const where = (line ? `\n  at ${line}` : "") + (source ? `\nThat call, as the file holds it now:\n${source}` : "");
    const clearOnly = clearStarted && !rowsInserted;
    if (pass === "check") {
      console.error(`\nSEED HALTED in the check pass, nothing was sent: ${message}${where}`);
      console.error(clearOnly ? "Nothing was deleted. Stop and tell the user." : fixHint(!!source));
    } else {
      console.error(`\nSEED HALTED after ${writeCount} write call(s): ${message}${where}`);
      console.error(
        err instanceof SeedPlanError
          ? "Every table landed, so a plain re-run changes nothing. Fix the plan, run clearSeeded, then seed again."
          : clearOnly
            ? writeCount
              ? "The clear is INCOMPLETE: the tables listed before the failing one are already empty. Stop and tell the user."
              : "Nothing was deleted. Stop and tell the user."
            : `The seed is INCOMPLETE: the tables written before this call have landed, and a re-run converges on them. ${fixHint(!!source)}`,
      );
    }
    process.exit(1);
  } finally {
    mode = undefined;
    quiet = false;
  }
}

// ─────────────────────────────── --describe ───────────────────────────────

/** What a seed of each table sends: the key, the fields to send, the values an enum takes, what never to send, the stamps. */
export async function describeTables(names: ReadonlyArray<string>): Promise<string> {
  const out: string[] = [];
  for (const name of names) {
    const table = tableOf(name.trim());
    const m = await metaOf(table);
    const F = fieldsOf(m);
    const idType = String(m.entity.id_type ?? "auto_increment");
    out.push(`${table.slice(1)}  (${idType} key: ${["bigint", "text"].includes(idType) ? "send an id on every row" : "never send id; a child takes it from idsByKey"})`);
    if (!m.managed) { out.push("  unmanaged: its columns are not described here; a check pass reads them with limit=0", ""); continue; }
    out.push(`  key: ${keyAdvice(m)}`);
    const never: string[] = [];
    const send: string[] = [];
    const enums: string[] = [];
    for (const f of F.values()) {
      if (f.field_name === "id") continue;
      const why = platformWrites(m, f.field_name, true);
      if (why || ["id", "audit", "core"].includes(f.ctype)) { never.push(f.field_name); continue; }
      const rel = f.reference_table ? ` → ${f.reference_table}` : "";
      const req = f.input_type === "required" && emptyRule(f.input_type_rule) ? (String(f.default_value ?? "") === "" ? ", required" : `, default ${JSON.stringify(f.default_value)}`) : "";
      const ruled = emptyRule(f.input_type_rule) ? "" : ", required in some states (input_type_rule)";
      send.push(`${f.field_name} (${f.format}${rel}${req}${ruled}${NULLABLE.has(f.format) ? ", may be null" : ""})`);
      if (f.format === "enum") enums.push(`${f.field_name}: ${enumEntries(f).map((e) => e.value).join(", ")}`);
    }
    out.push(`  send on every row: ${send.join("; ") || "nothing"}`);
    if (enums.length) out.push(`  enum values (send the value, never the label): ${enums.join(" | ")}`);
    out.push(`  never send (the platform writes them): ${never.join(", ") || "nothing"}`);
    const stamps = rulesOf(m).map((r) => ({ col: String(r?.name), states: keptStates(r) })).filter((s) => s.states);
    for (const s of stamps) {
      const users = F.get(s.col)?.reference_table === "users" && rulesOf(m).some(isRequesterStamp) ? ", never the user running the seed" : "";
      out.push(`  stamp: send ${s.col} on rows in ${s.states!.join(", ")}${users}; such rows need the module's admin`);
    }
    if (!emptyRule(m.entity.select_rule)) out.push("  select_rule: run the seed as the module's admin, or the read-back misses rows");
    out.push("");
  }
  return out.join("\n");
}

if (import.meta.main) {
  const i = process.argv.indexOf("--describe");
  const list = i >= 0 ? process.argv[i + 1] : undefined;
  if (!list) {
    console.error("Usage: bun seed-lib.ts --describe <table>[,<table>…]");
    process.exit(1);
  }
  try {
    console.log(await describeTables(list.split(",").filter(Boolean)));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
