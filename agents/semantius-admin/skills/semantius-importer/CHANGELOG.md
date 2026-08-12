# semantius-importer CHANGELOG

This file is history, not contract: it is **not** loaded into context at runtime. The body of `SKILL.md` is always the current contract. Newest entries first.

## 1.2

Determinism and throughput rev, driven by a real HubSpot-leads import: no more hand-transcribed scripts, no more prose arithmetic, no more serial field creation, plus the "introspection verdict is gold" rule.

- Verdict is gold: the `get_csvschema` output is the authoritative default for every `format` (and `precision`, `enum_values`, `input_type`, boolean pair). Overrides are user decisions raised via `AskUserQuestion` (defaulting to the introspected format), never silent mapping edits; a mapping that deviates without a recorded user answer is a defect (schema-mapping.md section 2, quirk 3, SKILL.md Stage 2).
- The import script ships as a real file, `references/import.template.ts`, copied byte-for-byte into the run folder; it reads all run configuration from `./mapping.json` at startup. The fenced markdown template and its generation-time placeholder filling are gone (transcription was a standing escaping/divergence risk; a nested-template-literal failure burned a cycle in the field).
- mapping.json contract v2 (section 8): per-column `disposition` (`create` / `exists` / `label` / `skip`) replaces the `skip` boolean; columns carry the full `create_field` payload data (`title`, `precision`, `enum_values`, `input_type`, `unique_value`, `reference_*`, `default_value`); new top-level `expected_records` and optional `batch_size`. The artifact is the single runtime input for all three scripts.
- New helper `references/render-plan.ts`: renders the Stage 2 mapping table and every plan/report count straight from mapping.json. The skill pastes its output instead of restating numbers in prose ("35 → 33 → created 34" can no longer happen).
- New helper `references/create-fields.ts`: parallel field creation (concurrency 5) with explicit `field_order` in increments of 10 — the platform preserves explicit order, which removes the old "create serially in CSV column order, no field_order" constraint (34 serial creates took 158s, about two thirds of the run's wall time). Idempotent via read-before-create, fail-fast, per-field exit code and stderr in a result table (the ad-hoc bash loop it replaces swallowed errors), `--dry-run` feeds the pre-write gate.
- Step 0 hard gate trimmed: reads the new `references/importer-essentials.md` (a ~150-line distillation) instead of ~2100 lines of use-semantius up front; the full references are consulted on demand and still win on conflict. The run workspace is now created at the start of Stage 2 so mapping.json and the helpers live together from the first review round.
- Writing conventions inlined into SKILL.md (US English, no em-dashes in chat, plain language, narration restraint, data fidelity) — the old cross-skill pointer to the modeler sat outside the hard gate and was never read.
- The deferred id-preservation design (Status banner, two DEFERRED comment blocks) moved wholesale into the README's "Deferred design" section, out of the runtime contract.
- Shared preflight (in `semantius-admin`): a successful `getCurrentUser` probe now ends credential handling regardless of auth mechanism (API key, JWT preauth); only explicit auth evidence (exit 5 / 401 / 403) triggers the API-key path, and transient errors re-probe once instead of touching `.env`.

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
