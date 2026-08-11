---
name: semantius-importer
description: >-
  Imports a CSV into Semantius: introspects CSV schema with the CLI's
  `get_csvschema` util, maps columns to Semantius field formats, detects
  whether a matching entity exists (field-by-field diff), optionally creates
  the entity (and its module first), then generates and runs a Bun script that
  bulk-loads rows in batches. Also supports schema-only runs (create the
  entity, no rows) and compare-only runs (diff report, zero writes). Trigger
  on "import this CSV", "load this file into semantius", "create an entity
  from this file / spreadsheet export", "introspect this CSV", "bulk load
  these rows", "does this CSV match our table?", or asking what entity shape a
  CSV implies. Do NOT trigger for deploying blueprints or specs
  (semantius-admin / semantius-modeler), designing a multi-entity system
  (semantius-architect), CSV work with no Semantius target, or
  webhook-receiver ingestion (an external system pushes rows; see
  use-semantius references/webhook-import.md). For xlsx, ask for a CSV export
  first; CSV-only.
---

# semantius-importer Skill

> **Status** (kept in sync with `README.md`): id preservation (`id_mode` "id"/"move" writing source ids into the primary key) is **disabled this iteration** — explicit-id imports leave the platform id sequence behind and later inserts collide; it returns once the `fix_id_sequence` RPC is installed. Batched upsert awaits a `prefer` passthrough in the MCP; until then, update mode uses diff-then-PATCH. The README carries the details and the roadmap.

The front door for getting a **file** into Semantius. One CSV in, one entity out (created or reused), rows loaded in batches. The pipeline skills (architect → analyst → modeler) design and deploy whole systems from specs; this skill deliberately does lightweight, single-entity creation driven by what a file actually contains — no blueprint, no catalog reconciliation machinery.

Division of responsibility:

- **This skill** owns the workflow: introspect → map → detect → decide → import → verify, and the decision points along the way.
- **use-semantius** owns every low-level operation (CLI syntax, payload shapes, response contracts, Golden Rules). Loaded at Step 0; it wins on any conflict.
- **webhook-import.md** (in use-semantius) remains the reference for signed-webhook ingestion — external systems pushing rows one at a time. Not this skill's path.

## Operating modes

Pick from the user's phrasing; ask once when ambiguous.

| Mode | Runs | Writes |
|---|---|---|
| **Full import** (default) | Stages 1–6 | catalog (as decided) + data |
| **Schema-only** — "just create the entity from this file" | Stages 1–4, stops after catalog writes | catalog only |
| **Compare-only** — "does this file match our entity?" | Stages 1–3, renders the classified diff report | **zero writes** |

In every mode, each decision branch that would modify an existing entity carries an explicit **"report only, do not update"** option. Comparing never forces updating.

## Writing conventions

User-facing output follows the shared conventions (see `../semantius-modeler/SKILL.md`, "Writing conventions"): US English, no em-dashes in chat output, plain language (say "table" / "field" / "row", never internal jargon), narration restraint — do the work, render the decision points and the final report, skip the play-by-play. Data is sacred: CSV values travel into Semantius byte-for-byte except for the coercions the mapping explicitly declares.

---

## Preflight (before Step 0, every invocation)

The shared environment checks live in **[`../semantius-admin/references/preflight.md`](../semantius-admin/references/preflight.md)**; do not duplicate them. Standalone summary: install the toolchain if missing, probe `getCurrentUser` to confirm the CLI is authenticated, halt if the org guard trips. This skill runs from wherever the user's CSV work happens; it needs no repository and makes no assumptions about one. This skill critically needs **Bun** (the import script runs with `bun run`); `jq` is convenient but optional; `yq` and the customizations file are not used.

Also confirm the CLI ships the introspection util: `semantius info utils` must list `get_csvschema`. An older CLI without it needs the installer re-run first.

## Step 0 (hard gate): load use-semantius

**Blocking prerequisite, not a suggestion.** Do not author the import script and do not issue a single `create_*` / `update_*` until you have read:

```
Read: ../use-semantius/SKILL.md
Read: ../use-semantius/references/data-modeling.md
```

Consult `../use-semantius/references/cli-usage.md` for stdin piping and exit codes, and `../use-semantius/references/crud-tools.md` for `postgrestRequest`.

### Safety-net cheat table (a backstop, never a substitute; use-semantius wins)

| Trap | Right behavior | Authoritative source |
|---|---|---|
| Read response shape | `crud` reads return a JSON **array**; exit `0` + `[]` means "found nothing". Pass `--single` on unique-key reads: bare object, exit `1` = none, `2` = ambiguous | use-semantius SKILL.md → Response handling |
| Mandatory fields | There is **no `required` column**: mandatory = `input_type: "required"`, unique = `unique_value: true`. Never send `is_nullable` | data-modeling.md → All Field Properties |
| Nullability | Computed from `format`: only `reference`, `date`, `date-time` accept NULL; everything else is NOT NULL with an auto-default. Drives the empty-cell policy | data-modeling.md |
| `postgrestRequest` payload | The record field is **`body`**, not `data`. Bulk insert = array body where **every object has the same keys** (else `PGRST102`) | crud-tools.md → Bulk insert |
| Create response ids | Never read the new row's id off the create response; re-read by natural key | use-semantius SKILL.md |
| `update_field` identifier | Composite id string: `{"id": "<table>.<field>", "data": {...}}`; payload carries only the changing keys | data-modeling.md → Updating and Deleting |
| `update_entity` identifier | Keyed by `table_name` at top level, not numeric id | data-modeling.md |
| Big payloads | Pipe JSON via stdin (`... | semantius call crud postgrestRequest`); the CLI reads stdin when no JSON argument is given. The "always pass inline JSON" warning is about interactive shells with an empty stdin, not scripts that pipe | cli-usage.md → Passing Arguments |
| Format vocabulary | `enum` (with `enum_values`), never `select`; monetary values are `number` + `precision` | data-modeling.md |

---

## Workflow

```
1. Introspect → 2. Map & review → 3. Detect & diff → 4. Decide & create → 5. Generate & run import → 6. Verify & report
```

Read **[`references/schema-mapping.md`](references/schema-mapping.md)** before Stage 2 and **[`references/import-script-template.md`](references/import-script-template.md)** before Stage 5.

### Stage 1 — Introspect

```bash
semantius call utils/get_csvschema '{"path": "<csv-path>"}'
```

Default `maxRecords: -1` scans the whole file (streaming; large files are fine). **Do not cap the scan** unless the user insists: a capped scan degrades format verdicts (low-cardinality columns collapse to `enum`) *and* silently suppresses id detection. The result returns the schema inline and writes `<file>.csvschema.json` next to the CSV — keep it, the import workspace copies it. On an error envelope (`FILE_NOT_FOUND`, `EMPTY_FILE`, `NO_HEADER_ROW`, `PARSE_ERROR`, ...), surface the message and stop.

The schema is a wrapper: `{id_mode, id_move_column?, record_count, fields}`. Record three things: `record_count` (the import's expected parsed-row count on a full scan), `id_mode` (drives the id decision in Stage 2), and each column's verdict from `fields`. The full output contract and its detection quirks are in schema-mapping.md section 1.

### Stage 2 — Map and review

Apply schema-mapping.md sections 2–7 to produce the proposed mapping:

- format passthrough (the CLI vocabulary is aligned; unlisted formats flow through verbatim per the fallback rule) plus the `multiline` naming heuristic;
- **enum review** for every `enum` verdict (low-cardinality columns masquerade as enums);
- **the id line** (schema-mapping.md section 4): `id_mode` applies to the **new-entity path only** — report the detection ("this file carries a usable primary key" / "the first column is an id candidate"), then apply the **classic policy**: id-named column renamed to `external_id` (offered as the unique natural key), an `id_move_column` kept as its own integer field. Importing source ids into a newly created entity's primary key is **deferred** until the `fix_id_sequence` RPC exists (see the Status note and README). For an **existing target entity**, `id_mode` is ignored; the live `id_column` drives the collision policy and the payload guard;
- **the write mode** (`on_exists`), asked explicitly when a natural key is in play: `insert` (existing keys skipped) or `update` (existing records synchronized; requires the key to be unique). Recorded in `mapping.json`;
- field-name verification, digit-leading renames, and **reserved-column resolutions** (`created_at`, `updated_at`, `label`);
- **FK candidates** (only with a live target and user confirmation);
- **label column** proposal (new entities);
- empty-cell policy per column; the util's `input_type` proposals (downgradeable).

Render the full mapping as one table: raw header → field name → format → extras → empty-cell rule → notes, plus the id-handling line. Then run the **review loop**: the user can rename any field, change a format, drop a column, change the id decision, or pick a different label column; re-render and repeat until approved. Bundle the open per-column questions (ambiguous enums, zero-for-empty, reserved collisions) into as few `AskUserQuestion` calls as possible — one question per topic, all collisions listed together, never one widget per column.

Persist the approved result as `mapping.json` (schema-mapping.md section 8).

### Stage 3 — Detect and diff

Derive the candidate `table_name` (plural snake_case) from the user's phrasing or the file name; confirm when ambiguous. Then:

```bash
semantius call crud read_entity --single '{"filters": "table_name=eq.<table>"}'
semantius call crud read_field '{"filters": "table_name=eq.<table>"}'
```

- **Entity absent** (exit 1): do **not** silently take the create path. Sweep for plausible existing targets two ways: name similarity from `read_entity '{}'` (table names containing the derived name or its singular/plural variants, similar labels), and **field overlap** in one query — `read_field '{"filters":"field_name=in.(<mapped field names>)"}'` grouped by `table_name` and ranked by overlap count. Then `AskUserQuestion`: **create new `<derived table>`** / **use existing entity** (top 2–3 candidates listed with module, plural label, and overlap) / the user names another table. Choosing an existing entity continues below as "entity exists"; choosing create marks the Stage 4 create path.
- **Entity exists** (or an existing target was chosen): capture the entity's **`id_column`** from the `read_entity` result (default `id`, but customizable — it drives the reserved-name rules and the script's payload guard; never assume the literal `id`), then diff the approved mapping against the live fields into the four buckets of schema-mapping.md section 9 (matched / missing live / mismatched / extra live), classify every needed change as **possible** or **impossible**, and render the classified change report. Never target the `id_column` field, live fields with `input_type` `readonly` / `disabled`, nor `_label` / `<fk>_label`.

**Compare-only mode ends here**: the classified report is the deliverable, zero writes.

### Stage 4 — Decide and create

| Live state | Default plan | Decision |
|---|---|---|
| Entity exists, everything matched | reuse as-is, import only | confirmation gate only |
| Entity exists, missing fields | add them via `create_field` | ask: add fields / drop those columns / report only / abort |
| Entity exists, mismatched fields | per the possible-vs-impossible classification | ask per report: `update_field` (possible) / coerce-in-script into the live format / drop / report only / abort |
| Entity exists, extra live **required** fields not in the CSV | blocker | ask: constant value for all rows / make the field optional / abort |
| Entity absent, target module known | create the entity there | confirmation gate only |
| Entity absent, no module | create the module first | ask: pick an existing module (`read_module '{}'` list) or create a new one |

Creation order (mechanics in data-modeling.md, `read_*` before every `create_*` so a re-run never double-creates):

1. Module (when needed): `create_module`, then `<slug>:read` + `<slug>:manage` permissions, then `update_module` to wire `view_permission` / `manage_permission_id`.
2. Entity: `create_entity` with `table_name`, symmetric `singular_label` / `plural_label`, description, **`label_column`** (the platform auto-creates that field and the computed `label` field), `module_id`, `view_permission`, `edit_permission`.
3. Fields: `create_field` per mapping row — **excluding** the label column (auto-created) and skipped columns, issued **in CSV column order** with no `field_order` (the platform assigns positions from creation order). When the label field deserves a more specific title than `singular_label`, follow up with `update_field` per data-modeling.md "Customizing the `label` field's title".

<!-- DEFERRED — id preservation (re-enable after the fix_id_sequence RPC is installed platform-side; see README):
**Preserved ids (id_mode `"id"` / `"move"`).** The import writes explicit `id` values through `postgrestRequest`; the platform accepts them (verified: the identity column takes explicit values). The catch, also verified: the id **sequence does not advance past explicit inserts** — a fresh table loaded with ids 1..N collides on the first platform-side record creation (UI or default insert). After the import, call `postgrestRequest {"method":"POST","path":"/rpc/fix_id_sequence","body":{"p_table":"<table>"}}` to advance the sequence past the imported maximum; state the id decision in the pre-write plan and confirm the RPC result in the post-import report. The `id` entry in the mapping is excluded from `create_field` (the primary key exists; the import writes it).
-->

**Write mode (`on_exists`).** With a natural key set, the import behaves per the prompted decision: `insert` skips existing keys; `update` synchronizes them — unchanged rows are not written, changed rows are updated, new rows inserted. Update mode requires the key field to be unique (`unique_value: true`); on a non-unique key, say so plainly and offer making it unique via the possible-change classification (which fails loudly when live duplicates exist) or fall back to insert mode.

**One pre-write confirmation gate** (`AskUserQuestion`, never a typed y/n): render the complete numbered plan — module ops, entity, each field, planned alterations, then the import (M rows in K batches) — and get one approval before the first write. The per-topic decisions above happen during analysis; the gate is a single yes.

**Schema-only mode ends here** after the catalog writes, reporting what was created plus the deep link.

Payload hygiene: any payload carrying free text from the CSV or the user (descriptions, titles, enum values) goes through a Bun script or stdin pipe, never inline shell-quoted JSON (see the modeler's data-fidelity rules; same reasoning).

### Stage 5 — Generate and run the import script

Everything per **[`references/import-script-template.md`](references/import-script-template.md)**:

1. Create the run workspace in the **OS temp directory**: `<os-tmpdir>/semantius-import/run-<timestamp>/`. Resolve the temp dir portably with `bun -e 'console.log(require("node:os").tmpdir())'` (never a shell-literal `/tmp` or `$TMPDIR`, which resolve inconsistently across shells on Windows). If a previous run folder for the same table exists there, offer to reuse and reconfigure it instead.
2. `bun add csv-parse` inside the folder (the CSV parser is a real dependency, installed first — no hand-rolled parsing).
3. Copy `mapping.json` and the `.csvschema.json`; generate `import.ts` from the template (streaming parse, coercion per mapping, uniform-key batches of 250 via stdin-piped `postgrestRequest`, exit-code-aware retries, `failed-batches.json` capture, optional `NATURAL_KEY` dedupe, built-in count verify).
4. `bun run import.ts <absolute-csv-path>`.

### Stage 6 — Verify and report

The script already count-verifies and emits `import-summary.json`. The skill then:

1. Checks `parsed` against the introspection's `record_count` (full-scan runs): a mismatch is a parsing defect to surface (delimiter trouble, embedded newlines), not noise.
2. Spot-reads 2–3 imported rows (`postgrestRequest` GET) and eyeballs the coercions: booleans are `true`/`false`, dates are dates, enums carry expected values, the label renders. In update mode, one spot-read targets an updated row to confirm the new values landed.
3. Renders the final report: parsed / inserted / updated / unchanged / skipped / failed, the count-verify verdict, the path to `failed-batches.json` when failures exist (with the first error quoted verbatim), and what was created in the catalog.
4. Closes with a clickable deep link to the entity list: `[Open <Plural Label> in Semantius →](<ui_baseurl>/<module_slug>)` — read `ui_baseurl` as a discrete field from `getCurrentUser`, never derive it from `api_baseurl`.

A failed batch is loud: the run is reported as incomplete with the re-run instruction (fix the cause, re-run with the natural key set so completed rows skip). Never render a success-shaped summary over a partial import.

---

## Exporting back out

Small enough to not need its own skill: PostgREST serves CSV directly. `postgrestRequest` has no header override, so for a CSV download use the raw endpoint with the CLI's token, or simply deliver JSON-to-CSV via a few lines of Bun:

```bash
semantius call crud postgrestRequest '{"method":"GET","path":"/products?select=product_code,list_price&order=product_code"}' \
  | bun -e 'const r=await new Response(Bun.stdin.stream()).json();const k=Object.keys(r[0]??{});console.log([k.join(","),...r.map(o=>k.map(c=>JSON.stringify(o[c]??"")).join(","))].join("\n"))' > products.csv
```

Filters, column selection, and pagination follow the normal PostgREST syntax from crud-tools.md.

## This skill never

- deletes anything in the catalog (`delete_entity`, `delete_field`, `delete_module`, ...) — cleanup of test or mistaken imports is the user's explicit call;
- models multi-entity systems, junction tables, or RBAC beyond the module's two standard permissions — route to `semantius-architect`;
- creates webhook receivers — that is webhook-import.md's path;
- writes sample or probe records outside the import itself;
- edits files it did not create this run (the CSV stays untouched);
- imports into `users` or other platform built-ins.
