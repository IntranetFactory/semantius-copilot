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
 *     `updated_at`, the entity's label column read from the host), or for any field that already
 *     exists on the host (a payload sent a second time), is refused (the platform's 23505);
 *   - a key the tool does not take (`required`, `data_type`, …) is refused with the key to write
 *     instead (PostgREST's PGRST204), and so is a value outside a key's list (`width`, `format`, …);
 *   - `label_parent` on `create_entity` (90226), an `id_prefix` that does not fit the `id_type`
 *     (23514), an `id_prefix` that is not 2 to 6 lowercase letters taken in order from the
 *     entity's singular, starting with its first letter, one prefix on two entities of the
 *     payload, and an `id_prefix` another entity on the host already has (23505) are refused;
 *   - a required `reference` with `reference_delete_mode: clear` is refused (the platform's 90257);
 *   - a rollup over rows that readers of its entity may not see, without `include_hidden_rows`,
 *     is refused (90269): the child's `select_rule` and both `view_permission`s are read from the host;
 *   - an `icon_name` or an enum entry's `icon` that is not a Lucide icon is refused, checked
 *     against `lucide-icon-tags.json` next to this file;
 *   - a `workflow_state` field (a create, or an update of its values) is refused unless `access.json`
 *     in the payload's folder, the module's access record, says who moves a record into each of its
 *     states (`access-rules.ts`), and so is a lifecycle under another name (an enum named `status`,
 *     `state`, `stage`, or `<the entity's singular>_status` / `_state` / `_stage`).
 *
 * Usage:   bun call-file.ts [--check] <tool> <file.json>
 *          --check validates the file (the permission read included) and sends nothing.
 * Output:  the CLI's own stdout and stderr
 * Exit:    the CLI's own exit code; 1 (the CLI's code for bad arguments) when the arguments
 *          are wrong, or the file cannot be read, is not valid JSON or fails a check
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { coverageProblems, labelColumnProblems, lifecycleNameProblems, planAccess, type AccessRecord } from "./access-rules";
import { checkedPermissions, closest } from "./permission-names";

export type Send = (tool: string, payload: string) => Promise<number>;
/** The permissions on the host whose names are in `names`, or that start with one of `prefixes`; null when the read failed. */
export type ReadPermissions = (names: ReadonlyArray<string>, prefixes: ReadonlyArray<string>) => Promise<string[] | null>;
/** What the field checks need of an entity. */
export type EntityInfo = { table_name: string; view_permission?: string; select_rule?: unknown; label_column?: string };
/** The entities on the host named in `tables`; null when the read failed. */
export type ReadEntities = (tables: ReadonlyArray<string>) => Promise<EntityInfo[] | null>;
/** The ids (`<table_name>.<field_name>`) among `ids` of the fields that exist on the host; null when the read failed. */
export type ReadFields = (ids: ReadonlyArray<string>) => Promise<string[] | null>;
/** The entities on the host whose `id_prefix` is one of `prefixes`; null when the read failed. */
export type ReadPrefixes = (prefixes: ReadonlyArray<string>) => Promise<Array<{ table_name: string; id_prefix: string }> | null>;

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
 * The keys a field and an entity take, as the `crud` server's create_field and create_entity schemas name them
 * (`scripts/crud-tools-drift.test.ts` compares them with the live schemas). The server passes any other key on, and
 * PostgREST then refuses the whole call with PGRST204 (`column "required" of relation "fields" does not exist`).
 */
export const FIELD_KEYS = new Set([
  "id", "table_name", "field_name", "title", "description", "format", "is_pk", "default_value", "field_order", "input_type",
  "width", "ctype", "searchable", "enum_values", "reference_table", "reference_delete_mode", "relationship_label",
  "singular_label_parent", "plural_label_parent", "precision", "unique_value", "cube_type", "input_type_rule",
  "catalog_field_code", "rollup",
]);
export const ENTITY_KEYS = new Set([
  "table_name", "singular", "plural", "singular_label", "plural_label", "icon_name", "name_sort", "description", "module_id",
  "view_permission", "edit_permission", "id_column", "id_type", "id_prefix", "id_refentity", "label_column",
  "label_column_label", "label_parent", "order_column", "managed", "searchable", "is_child", "edit_mode", "cube_mode",
  "audit_log", "computed_fields", "validation_rules", "select_rule", "entity_type", "catalog_entity_code",
  "catalog_owner_module", "catalog_entity_aliases",
]);
/** The formats a field takes (data-modeling.md → "Field Format Quick Reference"; the server's formats.json). */
export const FIELD_FORMATS = new Set([
  "string", "text", "multiline", "html", "code", "integer", "int32", "int64", "number", "float", "double", "date", "time",
  "date-time", "duration", "boolean", "enum", "color", "icon", "rating", "json", "object", "array", "jsonlogic", "uuid",
  "email", "uri", "url", "binary", "jsonata", "password", "uri-reference", "iri", "iri-reference", "uri-template",
  "idn-email", "hostname", "idn-hostname", "ipv4", "ipv6", "regex", "json-pointer", "json-pointer-uri-fragment",
  "relative-json-pointer", "byte", "reference", "parent",
]);
const FIELD_VALUES: Record<string, ReadonlySet<string>> = {
  format: FIELD_FORMATS,
  width: new Set(["default", "s", "m", "w"]),
  input_type: new Set(["default", "required", "readonly", "disabled", "hidden"]),
  reference_delete_mode: new Set(["", "restrict", "clear", "cascade"]),
  cube_type: new Set(["disabled", "auto", "dimension", "measure"]),
};
const ENTITY_VALUES: Record<string, ReadonlySet<string>> = {
  id_type: new Set(["auto_increment", "bigint", "text", "uuid", "typeid", "is_a", "has_a"]),
  entity_type: new Set(["operational_workflow", "operational_record", "catalog", "junction", "computed", "unclassified"]),
  edit_mode: new Set(["auto", "sidebar", "modal", "page"]),
  cube_mode: new Set(["disabled", "auto"]),
};
/** Keys written for another one, with what to write instead. */
const FIELD_KEY_HINTS: Record<string, string> = {
  required: 'write input_type: "required" (there is no required key)', is_required: 'write input_type: "required"',
  nullable: "leave it out: only reference, date and date-time take NULL, by their format", is_nullable: "leave it out: nullability follows the format",
  type: "write format", data_type: "write format", field_type: "write format", name: "write field_name", label: "write title",
  options: "write enum_values", values: "write enum_values", choices: "write enum_values", enum: "write enum_values",
  default: "write default_value", unique: "write unique_value", order: "write field_order",
  references: "write reference_table", ref_table: "write reference_table", reference: "write reference_table", target_table: "write reference_table",
  on_delete: "write reference_delete_mode", delete_mode: "write reference_delete_mode",
};
const ENTITY_KEY_HINTS: Record<string, string> = {
  name: "write table_name, and singular_label and plural_label for the words people read", label: "write singular_label and plural_label",
  fields: "fields go in one create_field call after create_entity", workflow_state: "it is a field: create it with create_field",
  permissions: "write view_permission and edit_permission",
};

/** The key prefix rule (data-modeling.md → "Choosing the key type"), as the messages name it. */
export const PREFIX_RULE = "2 to 6 lowercase letters taken in order from the entity's singular, starting with its first letter";

/** The lowercase letters of a name: "Job Opening" and "job_openings" give "jobopening" and "jobopenings". */
const lettersOf = (name: unknown): string => (typeof name === "string" ? name.toLowerCase().replace(/[^a-z]/g, "") : "");

/** True when the letters of `prefix` appear in `word` in order, the first one being the first letter of `word`. */
function takenFrom(prefix: string, word: string): boolean {
  if (!word || prefix[0] !== word[0]) return false;
  let i = 0;
  for (const c of word) if (c === prefix[i] && ++i === prefix.length) return true;
  return false;
}

/**
 * What is wrong with `prefix` under the key prefix rule, or "" when it fits. `names` are the entity's names the prefix
 * may be taken from (`singular`, `singular_label`, `table_name`); it fits when one of them gives it.
 */
export function prefixRuleProblem(prefix: unknown, names: ReadonlyArray<unknown>): string {
  if (typeof prefix !== "string" || !/^[a-z]{2,6}$/.test(prefix)) return "is not 2 to 6 lowercase letters";
  const given = names.filter((n): n is string => typeof n === "string" && lettersOf(n) !== "");
  if (!given.length || given.some((n) => takenFrom(prefix, lettersOf(n)))) return "";
  return `is not taken in order from "${given[0]}", starting with its first letter`;
}

/** A prefix that fits the rule, for a message: the initials of a name of several words, a word of up to 6 letters whole, or its first four letters. */
export function samplePrefix(name: string): string {
  const words = name.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  if (words.length > 1) return words.map((w) => w[0]).join("").slice(0, 6);
  const word = words[0] ?? "";
  return word.length <= 6 ? word : word.slice(0, 4);
}

/** The singular of an entity item, for a sample prefix: its `singular`, its `singular_label`, or its `table_name` without a final "s". */
const singularOf = (it: any): string =>
  [it.singular, it.singular_label].find((n) => typeof n === "string" && n.trim() !== "") ?? String(it.table_name ?? "").replace(/s$/, "");

/**
 * Keys `tool` does not take on its items, values outside a key's list, and the creation rules the platform refuses or
 * the key prefix rule asks: `label_parent` on `create_entity` (90226), an `id_prefix` that does not fit the `id_type`
 * (23514), an `id_prefix` that breaks the key prefix rule, and one prefix on two entities of the payload (23505).
 * `items` are the payload's field or entity items (`fieldItems`, `entityItems`).
 */
export function keyProblems(tool: string, items: ReadonlyArray<any>): string[] {
  const isField = tool === "create_field" || tool === "update_field";
  const isEntity = tool === "create_entity" || tool === "update_entity";
  if (!isField && !isEntity) return [];
  const [keys, values, hints] = isField ? [FIELD_KEYS, FIELD_VALUES, FIELD_KEY_HINTS] : [ENTITY_KEYS, ENTITY_VALUES, ENTITY_KEY_HINTS];
  const out: string[] = [];
  for (const it of items) {
    const where = isField ? `${it.table_name}.${it.field_name}` : String(it.table_name);
    const unknown = Object.keys(it).filter((k) => !keys.has(k));
    if (unknown.length) {
      out.push(`${where}: ${tool} does not take ${unknown.map((k) => `"${k}"${hints[k] ? ` (${hints[k]})` : ""}`).join(", ")}; the platform would refuse the whole call with PGRST204`);
    }
    for (const [k, allowed] of Object.entries(values)) {
      if (it[k] !== undefined && !allowed.has(String(it[k]))) {
        out.push(`${where}: ${k} "${it[k]}" is not one of its values (${[...allowed].filter(Boolean).join(", ")})`);
      }
    }
    if (isField && it.ctype !== undefined) out.push(`${where}: ctype is derived and never sent; leave it out (data-modeling.md, "Auto-Generated Fields")`);
    if (tool === "create_entity" && it.label_parent) {
      out.push(`${where}: label_parent cannot go in create_entity, because the field it names does not exist yet (90226); set it with update_entity once the fields exist (data-modeling.md, "Mandatory Creation Order", step 8)`);
    }
    const typed = ["typeid", "is_a"].includes(String(it.id_type));
    if (tool === "create_entity") {
      if (it.id_prefix && !typed) out.push(`${where}: id_prefix is set but id_type is "${it.id_type ?? "auto_increment"}"; a prefix goes only with typeid or is_a (23514). Every new entity takes id_type "typeid" except a junction and a has_a entity (data-modeling.md, "Choosing the key type")`);
      if (typed && !it.id_prefix) out.push(`${where}: id_type "${it.id_type}" needs an id_prefix: ${PREFIX_RULE}, such as "${samplePrefix(singularOf(it))}" (data-modeling.md, "Choosing the key type")`);
    }
    if (isEntity && it.id_prefix && (typed || tool === "update_entity")) {
      const wrong = prefixRuleProblem(it.id_prefix, [it.singular, it.singular_label, it.table_name]);
      if (wrong) out.push(`${where}: id_prefix "${it.id_prefix}" ${wrong}; a key prefix is ${PREFIX_RULE}, such as "${samplePrefix(singularOf(it))}" (data-modeling.md, "Choosing the key type")`);
    }
  }
  if (isEntity) {
    const tablesOf = new Map<string, string[]>();
    for (const it of items) if (typeof it.id_prefix === "string" && it.id_prefix !== "") tablesOf.set(it.id_prefix, [...(tablesOf.get(it.id_prefix) ?? []), String(it.table_name)]);
    for (const [prefix, tables] of tablesOf) {
      if (tables.length > 1) out.push(`${tables.join(", ")}: each has the id_prefix "${prefix}", but a key prefix is unique among entities (23505); give each its own abbreviation of its singular (data-modeling.md, "Choosing the key type")`);
    }
  }
  return out;
}

/**
 * The `create_field` items for fields that already exist on the host (`existing` holds their ids), other than those
 * `create_entity` made: such a payload was most likely sent before, and one of its rows fails the whole call with 23505.
 */
export function existingFieldProblems(fields: ReadonlyArray<any>, existing: ReadonlySet<string>, entities: ReadonlyMap<string, EntityInfo>): string[] {
  const again = fields.filter((f) => existing.has(`${f.table_name}.${f.field_name}`) && !MADE_BY_CREATE_ENTITY.has(f.field_name) && entities.get(f.table_name)?.label_column !== f.field_name)
    .map((f) => `${f.table_name}.${f.field_name}`);
  if (!again.length) return [];
  return [
    `${again.length} field(s) already exist on the host: ${again.slice(0, 6).join(", ")}${again.length > 6 ? `, … +${again.length - 6} more` : ""}. ` +
    `A row for an existing field fails the whole call with 23505, so nothing in it lands. An earlier create_field call has most likely landed already: ` +
    `read the fields with read_field (filters "id=in.(…)") before sending anything again, leave the existing ones out, and change one with update_field.`,
  ];
}

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

const spawnReadFields: ReadFields = async (ids) => {
  const args = JSON.stringify({ filters: `id=in.(${ids.map(pgValue).join(",")})`, select: "id", limit: 1000 });
  const proc = Bun.spawn(["semantius", "call", "crud", "read_field"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  proc.stdin.write(args);
  proc.stdin.end();
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0) return null;
  try { return (JSON.parse(out) as Array<{ id: string }>).map((r) => r.id); } catch { return null; }
};

const spawnReadPrefixes: ReadPrefixes = async (prefixes) => {
  const args = JSON.stringify({ filters: `id_prefix=in.(${prefixes.map(pgValue).join(",")})`, select: "table_name,id_prefix", limit: 1000 });
  const proc = Bun.spawn(["semantius", "call", "crud", "read_entity"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  proc.stdin.write(args);
  proc.stdin.end();
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0) return null;
  try { return JSON.parse(out) as Array<{ table_name: string; id_prefix: string }>; } catch { return null; }
};

/** The entity items whose `id_prefix` another entity on the host already has (`taken`): the platform refuses the call with 23505. */
export function prefixProblems(items: ReadonlyArray<any>, taken: ReadonlyArray<{ table_name: string; id_prefix: string }>): string[] {
  return items.flatMap((it) => {
    const other = taken.find((t) => t.id_prefix === it.id_prefix && t.table_name !== it.table_name);
    return other
      ? [`${it.table_name}: id_prefix "${it.id_prefix}" is already the key prefix of ${other.table_name} on this host, so the platform would refuse the call with 23505 (unique_current_id_prefix). Choose another abbreviation of its singular that is free: ${PREFIX_RULE} (data-modeling.md, "Choosing the key type").`]
      : [];
  });
}

/**
 * A `workflow_state` field (a create, or an update that sets its values) whose states the module's access record
 * does not cover: the record is `access.json` in the payload's folder (`writeModel` or `writeAccess` writes it).
 */
export function lifecycleProblems(file: string, fields: ReadonlyArray<any>, tool = "create_field"): string[] {
  const named = lifecycleNameProblems(fields);
  if (named.length) return named;
  const lifecycles = fields
    .filter((f) => f?.field_name === "workflow_state" && Array.isArray(f.enum_values))
    .map((f) => ({ table: String(f.table_name), values: f.enum_values.map((x: any) => (typeof x === "string" ? x : x?.value)).filter((x: unknown) => typeof x === "string") }));
  const people = fields.filter((f) => f?.reference_table === "users");
  if (!lifecycles.length && !people.length) return [];
  const path = join(dirname(file), "access.json");
  let record: AccessRecord | null = null;
  try {
    record = JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, ""));
  } catch {
    if (!lifecycles.length) return [];
    return [`${lifecycles.map((l) => `${l.table}.workflow_state`).join(", ")}: no access record at ${path}. Before a lifecycle is created, record who does the everyday work, who else uses the module and who moves a record into each state: the access part of writeModel in a build, writeAccess for a module that has its entities (rbac.md, "The access record")`];
  }
  if (tool !== "create_field") return coverageProblems(record, lifecycles).map((p) => `${p} (${path})`);
  // The same check as writeModel, so a payload written by hand cannot pass a record writeModel refuses.
  const r: any = record ?? {};
  const tables = new Set<string>([
    ...fields.map((f) => String(f.table_name)), ...Object.keys(r.entities ?? {}),
    ...Object.values(r.roles ?? {}).flatMap((x: any) => [...(x?.writes ?? []), ...Object.keys(x?.limitedTo ?? {}), ...(x?.hidden ?? []), ...Object.keys(x?.leaves ?? {})]),
    ...Object.keys(r.userFields ?? {}).map((k) => k.split(".")[0]),
  ].filter((t) => typeof t === "string" && t));
  const plan = planAccess({ slug: "module", moduleName: "", record, entities: [...tables].map((table_name) => ({ table_name })), fields: fields as any });
  return plan.problems.map((p) => `access record: ${p} (${path})`);
}

/** Runs the script and returns its exit code. */
export async function main(
  argv: string[], send: Send = spawnSend, printError: (line: string) => void = console.error,
  readPermissions: ReadPermissions = spawnRead, print: (line: string) => void = console.log,
  readEntities: ReadEntities = spawnReadEntities, readFields: ReadFields = spawnReadFields, readPrefixes: ReadPrefixes = spawnReadPrefixes,
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
  problems.push(...keyProblems(tool, [...fields, ...entityItems(tool, payload)]));
  problems.push(...iconProblems(entityItems(tool, payload), fields));
  const prefixed = entityItems(tool, payload).filter((e) => typeof e.id_prefix === "string" && e.id_prefix !== "");
  if (prefixed.length) {
    const taken = await readPrefixes([...new Set(prefixed.map((e) => e.id_prefix as string))]);
    if (!taken) problems.push("the key prefixes in use could not be read from the host, so the entities were not checked for a taken prefix; check the connection and run it again.");
    else problems.push(...prefixProblems(prefixed, taken));
  }
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
  if (created.length) {
    const existing = await readFields(created.map((f) => `${f.table_name}.${f.field_name}`));
    if (!existing) problems.push("the fields could not be read from the host, so the payload was not checked for fields that already exist; check the connection and run it again.");
    else problems.push(...existingFieldProblems(created, new Set(existing), entities));
  }
  problems.push(...fieldProblems(fields, entities));
  problems.push(...lifecycleProblems(file, fields, tool));
  if (tool === "create_entity") problems.push(...labelColumnProblems(entityItems(tool, payload)));
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
