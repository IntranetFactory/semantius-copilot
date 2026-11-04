# Pipeline Preflight

The environment checks of `semantius-admin`, `semantius-architect`, `semantius-analyst`, and `semantius-modeler`: the shared preflight, [`../../use-semantius/references/preflight.md`](../../use-semantius/references/preflight.md), plus the two checks below that only these skills need. The `semantius-admin` orchestrator runs this once at the top of an orchestrated run; each sub-skill (`semantius-architect`, `semantius-analyst`, `semantius-modeler`) runs it when invoked **standalone**, and **skips** it when invoked **inline by the admin**.

This file is referenced (never copied) by all four SKILLs. Fix a preflight rule here and every skill picks it up.

---

## Order

Run shared check 1, shared check 2, check 2b below, shared check 3, then check 4 below.

---

## When to run vs. skip

Look at your input for a `Run context:` block (the admin states it in the conversation immediately before entering a sub-skill, see `semantius-admin/SKILL.md` Step 7.3):

```
Run context: run_id=run-...
Customizations file: /abs/path/.../semantius/<org>/customizations.yaml
...
```

- **Orchestrated (a `Run context:` block is present):** the admin has already run this preflight (CLI installed + authenticated, toolchain present, customizations path resolved). **Do NOT re-run the checks.** Read `Customizations file:` from the header and proceed. (Re-running is harmless but redundant; skip it.)
- **Standalone (no `Run context:` block):** run the checks yourself, in the order above.

The modeler never consults the customizations file (specs already carry every decision), so when the modeler runs this standalone it runs the shared checks and skips checks 2b and 4. Bun is the tool the modeler critically needs (its deploy and sample-data scripts run with `bun run`).

---

## Output discipline

- **Orchestrated by admin:** produce **no chat output** for these checks; the admin owns all narration and keeps the machinery invisible.
- **Standalone:** the shared preflight's Output discipline applies. Never mention whether the skill runs under the admin or on its own, or the customizations path. A single brief line on the customizations file (check 4) is shown standalone in expert flow only.

---

## Question format

The shared preflight's two question-format steps run on every invocation, orchestrated or standalone; a `Run context:` block does not skip them.

---

## What the shared checks cover in these skills

- **Check 1** binds the Bun helpers under `.tmp_deploy/` and `.tmp_admin/` too: run them from the repo root by path (`bun run .tmp_deploy/deploy_<slug>.ts`).
- **Bun (check 2):** the modeler writes and runs its deploy and sample-data scripts with `bun run` (its only write path); the architect / analyst run `consistency-check.ts` with `bun`.
- **jq (check 2):** used throughout the architect / analyst bash flows.

---

## Check 2b: Install yq

**yq** is Mike Farah's Go yq v4+, the engine behind the surgical `customizations.yaml` writes (admin Step 7 / `references/customizations-protocol.md`) that preserve hand-edits and provenance line-comments.

Install it when missing, under the same rules as the shared check 2: no prompt, one plain line, the installer's folder when it is not on PATH yet, and the same stop when the install fails.

| Tool | Windows | macOS | Linux | Static-binary fallback (no package manager) |
|---|---|---|---|---|
| **yq** | `winget install -e --id MikeFarah.yq` (or `scoop install yq`, `choco install yq`) | `brew install yq` | `sudo snap install yq` or `brew install yq` (NOT `apt install yq` — see footgun below) | download `yq_<os>_<arch>` from https://github.com/mikefarah/yq/releases/latest (e.g. `yq_linux_amd64`, `yq_darwin_arm64`, `yq_windows_amd64.exe`), `chmod +x`, place on PATH |

**yq footgun (Linux especially).** The distro package named `yq` is frequently the *Python* yq (kislyuk/yq), whose syntax is incompatible and would break every `yq -i` write the customizations layer makes. Whether yq was already present or just installed, verify the right build is the one on PATH:

```bash
yq --version    # must report the mikefarah build, e.g. "yq (https://github.com/mikefarah/yq/) version v4.x"
```

If `yq --version` shows anything else (the Python yq, or a version below v4), install Mike Farah's Go binary explicitly via the static-binary fallback above, place it on PATH ahead of the wrong one, and re-check. Do not proceed with a non-mikefarah yq.

Do not limp on without `yq`: a missing or wrong `yq` breaks every customizations write.

---

## Check 4: Compute the customizations file path

(The modeler skips this; it does not consult the customizations file.) After the probe succeeds, derive the per-org file location and export it for every downstream call. The folder name is the org; never duplicate the org inside the file body.

```bash
CUSTOMIZATIONS_FILE="semantius/${org}/customizations.yaml"
mkdir -p "$(dirname "$CUSTOMIZATIONS_FILE")"
export CUSTOMIZATIONS_FILE
```

If the file does not exist yet, that is fine: treat as "no policies set." The first widget answer creates it. (`yq`, used for the surgical writes to this file, is guaranteed by check 2b.)

---

## Outputs

Besides the shared preflight's `org` and `ui_baseurl`, a successful preflight resolves:

- `CUSTOMIZATIONS_FILE` — per-org customizations path (unused by the modeler).
