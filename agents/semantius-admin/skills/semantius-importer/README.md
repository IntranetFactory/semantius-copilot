# semantius-importer

Imports a CSV file into Semantius: introspect the file's schema with the CLI's built-in `utils/get_csvschema`, create or reuse a matching entity (module first if needed), then bulk-load the rows in batches. `SKILL.md` is the runtime contract; this README is the honest status of what the skill can and cannot do right now.

## Works today

- **Introspection** against the v0.8.3 csvschema contract: wrapper output (`id_mode`, `record_count`, `fields`), derived `input_type`, open format set with passthrough for formats the skill does not special-case (`email`, `url`, and anything future CLI versions add).
- **Three run modes**: full import, schema-only (create the entity, import nothing), compare-only (classified diff report, zero writes).
- **Entity + module creation** with correct label-column mechanics, plus a field-by-field diff against existing entities with every needed change classified **possible** (executed on request) or **impossible** (alternatives offered).
- **Target-entity selection**: when no table matches, candidates are ranked by name similarity and field overlap and the user chooses create-new vs use-existing.
- **Batched import**: streaming `csv-parse`, uniform-key batches via stdin-piped `postgrestRequest`, retries, per-row coercion validation, `failed-batches.json`, count verification against the server and against the introspection's `record_count`.
- **Write modes** (prompted, recorded in `mapping.json` as `on_exists`):
  - `insert` — only new rows are written; rows whose natural key already exists are skipped.
  - `update` — existing records are synchronized with the CSV: unchanged rows are left untouched, changed rows are updated (per-row `PATCH` after a local diff), new rows are batch-inserted. Requires a unique natural key (`unique_value: true` field).

## Disabled this iteration

**id preservation (`id_mode: "id"` / `"move"` — new-entity path).** When the skill creates a fresh entity from a file, the introspector detects whether the file brings its own usable primary key; for existing target entities `id_mode` plays no role (their primary key stays untouched, whatever their `id_column` is named). The platform accepts explicit id inserts — but the id **sequence does not advance past them** (verified live: after importing ids 1..30 into a fresh table, the first normal insert fails with `23505 duplicate key`, and there is no PostgREST-level remedy). Until the sequence-fix RPC below is installed platform-side, the skill reports the detection but applies the classic policy instead: an id-named column is renamed to `external_id` (usable as the unique natural key), and an `id_move_column` stays an ordinary integer field. As a hard guard, the generated import script also **silently strips the entity's primary key column from every payload** (inserts and updates alike) — keyed on the target entity's `id_column` property read from the live catalog (default `id`, customizable per entity), so no mapping mistake can smuggle explicit ids in, whatever the column is named. The full preservation design is kept in `references/schema-mapping.md` under a "Deferred" marker and re-enabling it is planned as the next iteration.

## Pending platform/tooling work (roadmap)

1. **Batched upsert — needs an MCP change.** The `postgrestRequest` tool currently has no `prefer` input; the server hardcodes `Prefer: return=representation`, so `resolution=merge-duplicates` cannot reach PostgREST. A `prefer` passthrough in `postgrest-mcp` (`src/tools/postgrestRequest.ts`) unlocks batched upsert; until it is deployed, update mode uses diff-then-PATCH (correct, slower when many rows changed).
2. **Sequence-fix RPC — needs a platform DB function.** To make id preservation safe, install this function in the Semantius platform database (same place as the existing `/rpc/get_userinfo`-style functions) and grant execute to the appropriate role only:

   ```sql
   create or replace function fix_id_sequence(p_table text)
   returns bigint
   language plpgsql
   security definer
   as $$
   declare
     v_next bigint;
   begin
     execute format(
       'select setval(pg_get_serial_sequence(%L, ''id''), coalesce(max(id), 0) + 1, false) from %I',
       p_table, p_table
     ) into v_next;
     return v_next;
   end
   $$;
   -- grant execute on function fix_id_sequence(text) to <admin role>;
   -- revoke execute on function fix_id_sequence(text) from public;
   ```

   Call site (no MCP change needed): `postgrestRequest {"method":"POST","path":"/rpc/fix_id_sequence","body":{"p_table":"<table>"}}` right after a preserve-ids import.
3. **id preservation re-enable** once 1 and 2 are live: import explicit ids, call the RPC, sequence healthy — the deferred blocks in the references become active again.

## Layout

```
SKILL.md                              runtime contract (stages, gates, decision points)
references/schema-mapping.md          csvschema contract + mapping/decision rules
references/import-script-template.md  the generated Bun import script
evals/trigger-eval.json               trigger boundary cases
evals/quirks.csv, evals/move-mode.csv introspection fixtures (id/enum/bool/email/url/move quirks)
CHANGELOG.md                          history (not loaded at runtime)
```
