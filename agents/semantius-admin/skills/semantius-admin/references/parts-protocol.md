# Chunked artifact writes — the parts protocol

*Shared reference, one place like `preflight.md`. Cited by the analyst (spec write, `stage-11-write.md`), the architect (blueprint write, `stage-13-write.md`), the importer (a wide `mapping.json`, `schema-mapping.md` section 8), and the modeler (generated deploy / seed scripts). The companion rule is the Bash file-content discipline (INV-8 in the admin SKILL.md, restated residently in every sub-skill): bash never carries file content, so every write below goes through the Write tool.*

## Why this exists

A model-emitted tool call can be cut mid-stream at any size, mid-word, with no `stop_reason: length`. Observed live: a spec write died four times in a row — three truncated `Write` calls (one was cut before its `path` argument was emitted, so **no file was created at all**), then a `cat > file <<'EOF'` fallback whose generation was cut before the terminator, leaving `cat` blocked on stdin for ~55 minutes until the exec was aborted. Two lessons, now invariants:

1. **Never require a large file to survive one generation.** Emit it in small, independently verifiable parts.
2. **A truncated generation is an expected, recoverable event.** Recovery is always "rewrite the affected part" — never "try the whole file again", and never "switch to a bash heredoc" (that converts a truncation into an unbounded hang; see INV-8).

## Scope — one number governs everything

**The chunk cap is ~4 KB.** The protocol applies to every model-emitted file that can exceed it: specs (30–50 KB is normal), blueprints, a `mapping.json` for a wide CSV, model-authored Bun scripts (deploy, seed). A file that cannot exceed the cap is written in one `Write` call as today. Files produced by deterministic code (`spec-extract-lib.ts` output, the byte-for-byte-copied `import.template.ts`, `deploy-lib.ts` copies) are not model-emitted and are out of scope.

## The protocol

**R1 — chunk cap.** No single tool call carries more than ~4 KB of generated file content — `Write` and `Edit` calls alike. The natural chunk is one artifact section; a section that would exceed the cap on its own (e.g. a 30-field entity table) is split across parts.

**R2 — parts folder.** Each part is its own file, `parts/<slug>/NN-<label>.md` — zero-padded `NN` starting at `01`, lexicographic order = assembly order. Part files keep the `.md` suffix regardless of the artifact's own type (they are raw text fragments; the suffix is inert). The folder lives under the skill's established scratch home:

- admin-orchestrated runs: `.tmp_admin/<run_id>/parts/<slug>/` (the `Run context:` block supplies `run_id`);
- the modeler: `.tmp_deploy/parts/<slug>/`;
- the importer: its run folder, `.tmp_import/run-<timestamp>/parts/<slug>/`;
- a **standalone** analyst / architect run with no `Run context:` block mints its own run folder in the same `run-<timestamp>` shape first.

The parts folder MUST be created fresh (empty) at the start of each generation attempt. Stale parts from a failed earlier attempt are well-terminated but outdated, so **freshness, not the sentinel, is what proves currency**.

**R3 — manifest first.** Before writing any content part, write `00-manifest` (exactly that name, **no `.md` suffix**, so the assembly glob excludes it): one expected `NN-<label>.md` filename per line, nothing else. Verification checks presence and exact filenames against it. This is what catches the worst case — a generation cut before the `path` argument leaves **no file at all** — and also catches duplicate or variant part names that a bare glob would silently concatenate.

**R4 — sentinel + verification pass.** Every part file ends with the literal line `<!-- part-complete -->` followed by a trailing newline. One bash pass verifies, CRLF-tolerant, before assembly (bash carries no file content here — this is pure verification, INV-8-clean):

```bash
cd "parts/<slug>"
diff <(sed 's/\r$//' 00-manifest | sort) <(ls [0-9][0-9]-*.md 2>/dev/null | sort) \
  || { echo "PART SET MISMATCH (missing, unlisted, or misnamed parts)"; exit 1; }
for f in [0-9][0-9]-*.md; do
  [ "$(sed 's/\r$//' "$f" | grep -cFx -- '<!-- part-complete -->')" = 1 ] || { echo "BAD SENTINEL: $f"; exit 1; }
  [ -z "$(tail -c 1 "$f")" ] || { echo "NO TRAILING NEWLINE: $f"; exit 1; }
done
echo PARTS-OK
```

The `diff` covers a truncated manifest too: the manifest is written first, so a cut manifest surfaces as unlisted parts. Any failure → rewrite **only the affected part** (or the manifest) with a fresh `Write`, then re-run the pass. Never regenerate the whole artifact; never fall back to bash to carry content.

**R5 — deterministic assembly to a candidate path.** Assemble with bash that carries no content, normalizing CRLF and stripping sentinels in one canonical pipeline (run inside `parts/<slug>`; the candidate takes the artifact's real extension — `candidate.md`, `candidate.json`, `candidate.ts`):

```bash
cat [0-9][0-9]-*.md | sed 's/\r$//' | grep -vFx -- '<!-- part-complete -->' > candidate.md
```

(The `[0-9][0-9]-*.md` glob excludes the manifest and the candidate itself.) Verify the candidate is non-empty and its tail matches the last part's closing content, run the artifact's gates on it (R6), and **only then** move it into place with `mv` — the committed location (`semantius/specs/…`, `semantius/blueprints/…`, the run folder's `mapping.json`, `.tmp_deploy/<script>.ts`) never holds a half-finished state. After assembly the parts are dead: never reassemble (it would clobber post-assembly edits); a revision after this point is an `Edit` on the final file.

**R6 — gates on the candidate.** Each consuming skill runs its existing pre-save gates against the candidate, not the moved file: the analyst's and architect's pre-save verification tables and `consistency-check.ts`, `JSON.parse` plus a shape check for JSON artifacts, a syntax parse for generated scripts. Artifact-specific variations (the analyst's mermaid placeholder part, the architect's hand-built diagram part) live in the consuming skill's write reference, not here. All post-assembly `Edit`s obey the R1 cap; revise-loop edits re-run the gates.

**R7 — recovery framing.** A truncated generation is an expected, recoverable event, not an error state to escalate or route around. Recovery is always "rewrite the affected part". It is never "try the whole file again" and never "switch to a bash heredoc".

## Call sites

| Skill | Artifact | Variant detail lives in |
|---|---|---|
| `semantius-analyst` | `semantius/specs/<slug>-semantic-spec.md` | `../semantius-analyst/references/stage-11-write.md` |
| `semantius-architect` | `semantius/blueprints/<slug>-semantic-blueprint.md` | `../semantius-architect/references/stage-13-write.md` |
| `semantius-importer` | run-folder `mapping.json` (wide CSVs) | `../semantius-importer/references/schema-mapping.md` section 8 |
| `semantius-modeler` | generated deploy / seed scripts over the cap | SKILL.md canonical-pattern section; `references/stage-6-sample-data.md` |
