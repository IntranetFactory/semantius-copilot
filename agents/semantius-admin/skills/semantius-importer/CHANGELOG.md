# semantius-importer CHANGELOG

This file is history, not contract: it is **not** loaded into context at runtime. The body of `SKILL.md` is always the current contract. Newest entries first.

## 1.1

Updated for semantius-cli v0.8.3 (vendored csv-schema 2.0.0), added the update write mode, and deferred id preservation. A `README.md` now carries the skill's visible status: what works, what is disabled and why, and the roadmap (MCP `prefer` passthrough for batched upsert; platform `fix_id_sequence` RPC).

- Contract: `get_csvschema` now returns a wrapper `{id_mode, id_move_column?, record_count, fields}`; per-field `input_type` ("required", present only when no empties were seen) is passed through to `create_field` as the proposal; the format set is documented as open (`email` / `url` arrived) with a passthrough fallback rule — unlisted formats go to `create_field` and through the script verbatim.
- Write mode: with a natural key, the mapping review now asks `on_exists` — `insert` (existing keys skipped) or `update` (default offer): existing records are synchronized via diff-then-PATCH (unchanged rows untouched, changed rows updated, new rows batch-inserted); requires a unique key field. Batched upsert replaces the PATCH path once the MCP passes the `prefer` header through (today the server strips it — earlier `prefer` payload keys were silently ignored, now removed from the template).
- id handling: preservation of source ids into the platform primary key (`id_mode` "id"/"move") was implemented, then **deferred**: explicit-id imports leave the id sequence behind and the first platform-side insert collides (verified live). The design is kept under marked DEFERRED blocks and returns once the `fix_id_sequence` RPC (SQL in the README) is installed. Active policy: id-named columns rename to `external_id` (offered as the unique natural key); an `id_move_column` stays an ordinary integer field.
- Detection: when no matching table exists, the skill now asks whether to create the derived entity or target an existing one (candidates ranked by name similarity and field overlap) instead of silently creating.
- Verification: `parsed` is checked against the wrapper's `record_count` on full scans (script `EXPECTED_RECORDS`); capped scans are warned against (they degrade formats and suppress id detection).

## 1.0

Initial release.

- Workflow: introspect (`utils/get_csvschema`) → map & review → detect & diff → decide & create → batched import → verify.
- Three operating modes: full import, schema-only (create the entity, import nothing), compare-only (classified diff report, zero writes).
- Assumes the aligned csvschema vocabulary (CLI ≥ the version that emits `header` + normalized `field_name`, `precision`, `boolean`, `date` / `date-time`).
- Import script: Bun + `csv-parse`, streaming, uniform-key batches of 250 via stdin-piped `postgrestRequest`, exit-code-aware retries, `failed-batches.json` capture, optional natural-key dedupe, built-in count verify.
- Change classification for existing entities: possible (`create_field`, `input_type`, `precision`, enum-value additions, same-primitive format changes) vs impossible (cross-primitive format changes; alternatives: coerce-in-script, drop, abort).
