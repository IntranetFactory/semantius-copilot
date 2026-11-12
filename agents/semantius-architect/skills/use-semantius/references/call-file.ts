#!/usr/bin/env bun
/**
 * call-file.ts — sends a JSON file to a `crud` tool of the `semantius` CLI, so no shell
 * parses or re-encodes the payload. Quotes and apostrophes cannot break the call, and
 * non-ASCII text arrives intact in every shell, Windows PowerShell 5.1 included.
 *
 * Reads the file as UTF-8, with or without a byte order mark, or as UTF-16 LE with one
 * (what `>` writes in Windows PowerShell 5.1). Anything else is refused, never guessed.
 *
 * Before sending it checks the payload, and names every problem it finds in one run:
 *   - invalid JSON is reported with its line and column, an excerpt with a caret, and the
 *     bracket still open there;
 *   - a `var` whose name is empty or starts with "." is refused: that is what a shell leaves
 *     of "$user_id" or "$old.workflow_state" when it expanded them in an unquoted heredoc;
 *   - every `has_permission` / `require_permission` name in a create or update of an entity
 *     or a field must be a permission on the host (one read): the platform saves a misspelled
 *     name, and the step it guards is then closed to everyone;
 *   - a `create_field` row for a field `create_entity` already made (`id`, `created_at`,
 *     `updated_at`, the entity's label column read from the host) is refused (the platform's 23505);
 *   - a required `reference` with `reference_delete_mode: clear` is refused (the platform's 90257);
 *   - a rollup over rows that readers of its entity may not see, without `include_hidden_rows`,
 *     is refused (90269): the child's `select_rule` and both `view_permission`s are read from the host;
 *   - an `icon_name` or an enum entry's `icon` that is not a Lucide icon is refused, checked
 *     against `lucide-icon-tags.json` next to this file.
 *
 * Usage:   bun call-file.ts [--check] <tool> <file.json>
 *          --check validates the file (the permission read included) and sends nothing.
 * Output:  the CLI's own stdout and stderr
 * Exit:    the CLI's own exit code; 1 (the CLI's code for bad arguments) when the arguments
 *          are wrong, or the file cannot be read, is not valid JSON or fails a check
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkedPermissions, closest } from "./permission-names";

export type Send = (tool: string, payload: string) => Promise<number>;
/** The permissions on the host whose names are in `names`, or that start with one of `prefixes`; null when the read failed. */
export type ReadPermissions = (names: ReadonlyArray<string>, prefixes: ReadonlyArray<string>) => Promise<string[] | null>;
/** What the field checks need of an entity. */
export type EntityInfo = { table_name: string; view_permission?: string; select_rule?: unknown; label_column?: string };
/** The entities on the host named in `tables`; null when the read failed. */
export type ReadEntities = (tables: ReadonlyArray<string>) => Promise<EntityInfo[] | null>;

const USAGE = "Usage: bun call-file.ts [--check] <tool> <file.json>";
const PERMISSION_TOOLS = new Set(["create_entity", "update_entity", "create_field", "update_field"]);

const objects = (value: unknown): any[] => (Array.isArray(value) ? value : value ? [value] : []).filter((x) => x && typeof x === "object");

/** The field items of a `create_field` or `update_field` payload, each with its `table_name` and `field_name`. */
export function fieldItems(tool: string, payload: any): any[] {
  if (tool === "create_field") return objects(payload?.data);
  if (tool !== "update_field") return [];
  return (Array.isArray(payload?.id) ? payload.id : [payload?.id])
    .filter((id: unknown): id is string => typeof id === "string" && id.includes("."))
    .map((id: string) => ({ ...(payload?.data ?? {}), table_name: id.slice(0, id.indexOf(".")), field_name: id.slice(id.indexOf(".") + 1) }));
}

/** The entity items of a `create_entity` or `update_entity` payload, each with its `table_name`. */
export function entityItems(tool: string, payload: any): any[] {
  if (tool === "create_entity") return objects(payload?.data);
  if (tool !== "update_entity") return [];
  return (Array.isArray(payload?.table_name) ? payload.table_name : [payload?.table_name])
    .filter((t: unknown): t is string => typeof t === "string")
    .map((t: string) => ({ ...(payload?.data ?? {}), table_name: t }));
}

const hasRule = (rule: unknown) => !!rule && typeof rule === "object" && Object.keys(rule as object).length > 0;

/**
 * The field problems the platform refuses one at a time: a required reference with `clear` (90257), and a rollup over
 * rows that readers of its entity may not see, without `include_hidden_rows` (90269). `entities` holds the parent and
 * the child of each rollup; a rollup whose entities are not in it is not checked.
 */
export function fieldProblems(fields: ReadonlyArray<any>, entities: ReadonlyMap<string, EntityInfo>): string[] {
  const out: string[] = [];
  for (const f of fields) {
    const where = `${f.table_name}.${f.field_name}`;
    if (f.format === "reference" && f.input_type === "required" && f.reference_delete_mode === "clear") {
      out.push(`${where}: a required reference cannot take reference_delete_mode clear, which empties it when the record it points at is deleted (90257). Use restrict, or make the field optional (data-modeling.md, "Choosing the Right Format").`);
    }
    const rollup = f.rollup;
    if (!rollup || typeof rollup !== "object" || typeof rollup.link_field !== "string" || rollup.include_hidden_rows === true) continue;
    const childTable = rollup.link_field.split(".")[0];
    const child = entities.get(childTable), parent = entities.get(f.table_name);
    if (!child || !parent) continue;
    const childView = child.view_permission || "public:read", parentView = parent.view_permission || "public:read";
    const why = hasRule(child.select_rule) ? `${childTable} has a select_rule`
      : childView !== parentView ? `${childTable} is read with ${childView}, ${f.table_name} with ${parentView}` : "";
    if (why) {
      out.push(`${where}: the rollup aggregates ${childTable} rows that readers of ${f.table_name} may not see (${why}), so the platform refuses it without "include_hidden_rows": true (90269). Set it without asking when a ${childTable} row shows exactly when its ${f.table_name} record does (rbac.md, "Controls on a gate", control 7, and "Roles that do part of the work"); otherwise ask the user first (rollup-fields.md, "Hidden child rows"). Never leave the rollup out to get past this.`);
    }
  }
  return out;
}

/** The fields `create_entity` makes on every entity it creates. */
const MADE_BY_CREATE_ENTITY = new Set(["id", "created_at", "updated_at"]);

/**
 * Every `create_field` item for a field `create_entity` already made: `id`, `created_at`, `updated_at`, and the label
 * column named in `entities`. One such row fails the whole call with `23505`, so nothing in it lands.
 */
export function madeFieldProblems(fields: ReadonlyArray<any>, entities: ReadonlyMap<string, EntityInfo>): string[] {
  const out: string[] = [];
  for (const f of fields) {
    const label = entities.get(f.table_name)?.label_column;
    const made = MADE_BY_CREATE_ENTITY.has(f.field_name) ? "on every entity" : label && f.field_name === label ? "as the label column, required and titled" : "";
    if (made) {
      out.push(`${f.table_name}.${f.field_name}: create_entity already created this field ${made}, so a create_field row for it fails the whole call with 23505 and nothing lands. Leave it out of create_field. The label field's title goes in create_entity as label_column_label; to change a title or description later, use update_field on "${f.table_name}.${f.field_name}" (SKILL.md, Golden Rule 3).`);
    }
  }
  return out;
}

let lucide: Record<string, unknown> | null = null;
const lucideIcons = () => (lucide ??= JSON.parse(readFileSync(join(import.meta.dir, "lucide-icon-tags.json"), "utf8")).icons as Record<string, unknown>);
const notAnIcon = (name: unknown): name is string => typeof name === "string" && name !== "" && !/^https?:\/\//.test(name) && !Object.hasOwn(lucideIcons(), name);
const ICON_HINT = "find one with lucide-icon-finder.ts, or leave the icon out when none fits";

/** Every `icon_name` of `entities` and every enum entry `icon` of `fields` that is not a Lucide icon (an icon URL passes). */
export function iconProblems(entities: ReadonlyArray<any>, fields: ReadonlyArray<any>): string[] {
  const out: string[] = [];
  for (const e of entities) if (notAnIcon(e.icon_name)) out.push(`${e.table_name}: icon_name "${e.icon_name}" is not a Lucide icon; ${ICON_HINT}.`);
  for (const f of fields) {
    for (const v of objects(f.enum_values)) if (notAnIcon(v.icon)) out.push(`${f.table_name}.${f.field_name}: the enum entry "${v.value}" has the icon "${v.icon}", which is not a Lucide icon; ${ICON_HINT}.`);
  }
  return out;
}

/** The text of a payload file; throws when it is neither UTF-8 nor UTF-16 LE with a byte order mark. */
export function decodePayload(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le", { fatal: true }).decode(bytes);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("is not UTF-8 text; save it as UTF-8");
  }
}

export type JsonProblem = { line: number; column: number; message: string; excerpt: string };

/** Where `text` stops being JSON, with the bracket still open there; null when it is valid. */
export function locateJsonError(text: string): JsonProblem | null {
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const open: Array<{ char: string; at: number }> = [];
  class Bad { constructor(readonly at: number, readonly message: string) {} }
  const pos = (at: number) => {
    const before = text.slice(0, at).split("\n");
    return { line: before.length, column: before[before.length - 1].length + 1 };
  };
  const show = (c: string | undefined) => (c === undefined ? "the end of the file" : `"${c}"`);
  const fail = (message: string, at = i): never => { throw new Bad(at, message); };
  const ws = () => { while (i < text.length && " \t\r\n".includes(text[i])) i++; };
  const close = (want: "}" | "]") => {
    const top = open[open.length - 1];
    const where = top ? `the "${top.char}" opened at line ${pos(top.at).line}, column ${pos(top.at).column}` : "";
    const c = text[i];
    if (c === undefined) fail(`the file ends while ${where} is still open`);
    if (c === "}" || c === "]") fail(`found "${c}" while ${where} is still open: a "${want}" is missing before it`);
    fail(`expected "," or "${want}" after a value, found ${show(c)}`);
  };
  const string = () => {
    i++;
    while (i < text.length && text[i] !== '"') {
      if (text[i] === "\n") fail("a line break inside a string: the string is not closed on this line");
      if (text.charCodeAt(i) < 0x20) fail(`a control character (code ${text.charCodeAt(i)}) inside a string; write it as an escape such as \\t`);
      if (text[i] === "\\") {
        const e = text[i + 1];
        if (e === "u") {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) fail('a "\\u" escape needs four hex digits');
          i += 6;
          continue;
        }
        if (e === undefined || !'"\\/bfnrt'.includes(e)) fail(`"\\${e ?? ""}" is not a JSON escape${e === "'" ? `: an apostrophe needs no backslash` : ""}`);
        i += 2;
        continue;
      }
      i++;
    }
    if (i >= text.length) fail("a string is not closed");
    i++;
  };
  const value = (): void => {
    ws();
    const c = text[i];
    if (c === "{" || c === "[") {
      const end = c === "{" ? "}" : "]";
      open.push({ char: c, at: i });
      i++;
      ws();
      if (text[i] === end) { open.pop(); i++; return; }
      for (;;) {
        ws();
        if (c === "{") {
          if (text[i] !== '"') fail(`expected a property name in double quotes, found ${show(text[i])}`);
          string();
          ws();
          if (text[i] !== ":") fail(`expected ":" after the property name, found ${show(text[i])}`);
          i++;
        }
        value();
        ws();
        if (text[i] === ",") { i++; continue; }
        if (text[i] === end) { open.pop(); i++; return; }
        close(end);
      }
    }
    if (c === '"') { string(); return; }
    const num = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
    num.lastIndex = i;
    if (c !== undefined && /[-0-9]/.test(c) && num.test(text)) { i = num.lastIndex; return; }
    for (const lit of ["true", "false", "null"]) if (text.startsWith(lit, i)) { i += lit.length; return; }
    fail(c === undefined ? "the file ends where a value should start" : `expected a value, found ${show(c)}`);
  };
  try {
    value();
    ws();
    if (i < text.length) fail(`found ${show(text[i])} after the end of the JSON`);
    return null;
  } catch (e) {
    if (!(e instanceof Bad)) throw e;
    const { line, column } = pos(e.at);
    const row = text.split("\n")[line - 1].replace(/\r$/, "");
    const from = Math.max(0, column - 61);
    const excerpt = `${from ? "…" : ""}${row.slice(from, column + 40)}${row.length > column + 40 ? "…" : ""}\n${" ".repeat(column - 1 - from + (from ? 1 : 0))}^`;
    return { line, column, message: e.message, excerpt };
  }
}

/** Operators whose later arguments run per element, where `{"var": ""}` is the element itself. */
const PER_ELEMENT = new Set(["map", "filter", "reduce", "all", "some", "none"]);

/**
 * Every `var` whose name is empty or starts with ".", as a shell leaves "$user_id" or "$old.x" after expanding them.
 * `{"var": ""}` inside the per-element arguments of `map`, `filter`, `reduce`, `all`, `some` and `none` is valid and kept.
 */
export function expandedVars(value: unknown, out: string[] = [], perElement = false): string[] {
  if (Array.isArray(value)) for (const v of value) expandedVars(v, out, perElement);
  else if (value && typeof value === "object") {
    for (const [key, v] of Object.entries(value)) {
      if (key === "var") {
        const name = Array.isArray(v) ? v[0] : v;
        if (typeof name === "string" && ((name === "" && !perElement) || name.startsWith("."))) out.push(JSON.stringify({ var: v }));
      } else if (PER_ELEMENT.has(key) && Array.isArray(v)) {
        expandedVars(v[0], out, perElement);
        for (const arg of v.slice(1)) expandedVars(arg, out, true);
      } else expandedVars(v, out, perElement);
    }
  }
  return out;
}

const pgValue = (s: string): string => (/^[A-Za-z0-9_$.\-:@]+$/.test(s) ? s : `"${s.replace(/[\\"]/g, "\\$&")}"`);

const spawnSend: Send = async (tool, payload) => {
  const proc = Bun.spawn(["semantius", "call", "crud", tool], { stdin: "pipe", stdout: "inherit", stderr: "inherit" });
  proc.stdin.write(payload);
  proc.stdin.end();
  return proc.exited;
};

const spawnRead: ReadPermissions = async (names, prefixes) => {
  const filters = [`permission_name.in.(${names.map(pgValue).join(",")})`, ...prefixes.map((p) => `permission_name.like.${pgValue(`${p}:*`)}`)];
  const args = JSON.stringify({ filters: `or=(${filters.join(",")})`, select: "permission_name", limit: 1000 });
  const proc = Bun.spawn(["semantius", "call", "crud", "read_permission"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  proc.stdin.write(args);
  proc.stdin.end();
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0) return null;
  try { return (JSON.parse(out) as Array<{ permission_name: string }>).map((r) => r.permission_name); } catch { return null; }
};

const spawnReadEntities: ReadEntities = async (tables) => {
  const args = JSON.stringify({ filters: `table_name=in.(${tables.map(pgValue).join(",")})`, select: "table_name,view_permission,select_rule,label_column", limit: 1000 });
  const proc = Bun.spawn(["semantius", "call", "crud", "read_entity"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  proc.stdin.write(args);
  proc.stdin.end();
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0) return null;
  try { return JSON.parse(out) as EntityInfo[]; } catch { return null; }
};

/** Runs the script and returns its exit code. */
export async function main(
  argv: string[], send: Send = spawnSend, printError: (line: string) => void = console.error,
  readPermissions: ReadPermissions = spawnRead, print: (line: string) => void = console.log,
  readEntities: ReadEntities = spawnReadEntities,
): Promise<number> {
  const check = argv[0] === "--check";
  const [tool, file, ...rest] = check ? argv.slice(1) : argv;
  if (!tool || !file || rest.length) {
    printError(USAGE);
    return 1;
  }
  let text: string;
  try {
    text = decodePayload(readFileSync(file));
  } catch (e) {
    printError(`${file}: ${e instanceof Error ? e.message : e}`);
    return 1;
  }
  const problem = locateJsonError(text);
  if (problem) {
    printError(`${file}: invalid JSON at line ${problem.line}, column ${problem.column}: ${problem.message}\n${problem.excerpt}`);
    printError("Build the payload in a Bun script with jsonlogic-kit.ts and JSON.stringify, rather than typing nested rules by hand.");
    return 1;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (e) {
    printError(`${file}: invalid JSON: ${e instanceof Error ? e.message : e}`);
    return 1;
  }
  // Every check runs, and every problem is named, so one run reports what the platform would refuse one call at a time.
  const problems: string[] = [];
  const expanded = expandedVars(payload);
  if (expanded.length) {
    problems.push(
      `${expanded.length} variable name(s) are empty or start with ".": ${[...new Set(expanded)].slice(0, 5).join(", ")}. ` +
      `A shell expanded "$user_id", "$mode" or "$old.<field>" while the file was written: write it with a quoted heredoc (<<'EOF') or from a Bun script.`,
    );
  }
  const fields = fieldItems(tool, payload);
  problems.push(...iconProblems(entityItems(tool, payload), fields));
  // One read covers the tables of a create_field payload (their label columns) and both sides of each rollup.
  const created = tool === "create_field" ? fields.filter((f) => typeof f.table_name === "string" && typeof f.field_name === "string") : [];
  const rollups = fields.filter((f) => typeof f.rollup?.link_field === "string" && f.rollup.include_hidden_rows !== true);
  let entities = new Map<string, EntityInfo>();
  const tables = [...new Set([...created.map((f) => f.table_name), ...rollups.flatMap((f) => [f.table_name, f.rollup.link_field.split(".")[0]])])];
  if (tables.length) {
    const read = await readEntities(tables);
    if (!read) problems.push("the entities its fields belong to could not be read from the host, so the fields were not checked; check the connection and run it again.");
    else entities = new Map(read.map((e) => [e.table_name, e]));
  }
  problems.push(...madeFieldProblems(created, entities));
  problems.push(...fieldProblems(fields, entities));
  let checked = 0;
  if (PERMISSION_TOOLS.has(tool)) {
    const names = [...checkedPermissions(payload)];
    if (names.length) {
      const prefixes = [...new Set(names.filter((n) => n.includes(":")).map((n) => n.split(":")[0]))];
      const existing = await readPermissions(names, prefixes);
      const missing = existing ? names.filter((n) => !existing.includes(n)) : [];
      if (!existing) {
        problems.push("the permission names could not be read from the host, so the rules were not sent; check the connection and run it again.");
      } else if (missing.length) {
        problems.push(
          `${missing.length} permission name(s) in the rules are not permissions on the host: ` +
          missing.map((n) => { const near = closest(n, existing); return near ? `${n} (did you mean ${near}?)` : n; }).join(", ") +
          `. The platform would save them, and each step they guard would be closed to everyone. The tier permissions are <slug>:read, <slug>:manage and <slug>:admin; viewer, manager and admin are role names.`,
        );
      } else checked = names.length;
    }
  }
  if (problems.length) {
    for (const p of problems) printError(`${file}: ${p}`);
    if (problems.length > 1) printError(`${file}: ${problems.length} problems, nothing sent; fix them all, then run it again.`);
    return 1;
  }
  if (check) {
    print(`${file}: valid for ${tool}${checked ? `; ${checked} permission name(s) found on the host` : ""}; nothing sent`);
    return 0;
  }
  return send(tool, JSON.stringify(payload));
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
