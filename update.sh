#!/usr/bin/env bash
# Refresh the two upstream inputs this repo vendors but never edits:
#
#   1. agents/<agent>/skills/<skill>/          <- mirror of the semantius-plugin skills:
#      semantius-architect gets all of them, semantius-agent all but AGENT_EXCLUDED_SKILLS.
#      Every skill folder is REPLACED, not merged, so files and whole skills dropped
#      upstream disappear here too. scripts/trim-agent-skills.mjs then copies what semantius-agent's
#      skills link in the excluded skills to a common folder and rewrites those links. Ships with
#      `pnpm deploy:agent <agent>`.
#   2. linux-x64/semantius-cli.json            <- pinned semantius CLI release { version,
#      sha256 }. The binary itself (linux-x64/semantius-linux-x64, >100 MiB) is gitignored
#      and fetched by scripts/fetch-cli.mjs, which `pnpm deploy:b` runs before baking it
#      into the backend-b container image.
#
# Usage:  ./update.sh [cli-version]     e.g. ./update.sh v0.8.12   (default: latest release)
# Env:    SEMANTIUS_SKILLS_SRC          skills source folder
#                                       (default: /c/dev/semantius-agent/semantius-plugin/skills)
set -euo pipefail
shopt -s nullglob

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILLS_SRC="${SEMANTIUS_SKILLS_SRC:-/c/dev/semantius-agent/semantius-plugin/skills}"
AGENT_EXCLUDED_SKILLS=(semantius-admin semantius-analyst semantius-architect semantius-modeler)
die() { echo "update.sh: $*" >&2; exit 1; }

# Git Bash: accept a Windows path (C:\dev\...) for SEMANTIUS_SKILLS_SRC.
if command -v cygpath >/dev/null; then SKILLS_SRC="$(cygpath -u "$SKILLS_SRC")"; fi

# ── 1. skills ────────────────────────────────────────────────────────────────
echo "==> skills: $SKILLS_SRC"
src_skills=("$SKILLS_SRC"/*/)
[ ${#src_skills[@]} -gt 0 ] || die "no skill folders in $SKILLS_SRC"
# Validate the whole source before deleting anything here.
for d in "${src_skills[@]}"; do
  [ -f "${d}SKILL.md" ] || die "not a skill (no SKILL.md): $d"
done
# A skill renamed upstream would otherwise slip past the exclusion unnoticed.
for skill in "${AGENT_EXCLUDED_SKILLS[@]}"; do
  [ -d "$SKILLS_SRC/$skill" ] || die "excluded skill is not upstream: $skill"
done
# Git Bash: Windows node.exe needs Windows paths (it reads /c/dev/... as C:\c\dev\...).
TRIM_SKILLS="$ROOT/scripts/trim-agent-skills.mjs"
TRIM_SRC="$SKILLS_SRC"
TRIM_DST="$ROOT/agents/semantius-agent/skills"
if command -v cygpath >/dev/null; then
  TRIM_SKILLS="$(cygpath -m "$TRIM_SKILLS")"
  TRIM_SRC="$(cygpath -m "$TRIM_SRC")"
  TRIM_DST="$(cygpath -m "$TRIM_DST")"
fi
# A link that cannot be copied stops here, before anything is deleted.
node "$TRIM_SKILLS" --check "$TRIM_SRC" "${AGENT_EXCLUDED_SKILLS[@]}"

# mirror_skills <agent> [skill to leave out]...
mirror_skills() {
  local skills_dst="$ROOT/agents/$1/skills" d skill
  echo "    $1:"
  shift
  rm -rf "$skills_dst"/*/
  mkdir -p "$skills_dst"
  for d in "${src_skills[@]}"; do
    skill="$(basename "$d")"
    case " $* " in *" $skill "*) continue ;; esac
    cp -R "${d%/}" "$skills_dst/"
    echo "      $skill"
  done
}
mirror_skills semantius-architect
mirror_skills semantius-agent "${AGENT_EXCLUDED_SKILLS[@]}"
node "$TRIM_SKILLS" "$TRIM_SRC" "$TRIM_DST" "${AGENT_EXCLUDED_SKILLS[@]}"
if rev="$(git -C "$SKILLS_SRC" rev-parse --short HEAD 2>/dev/null)"; then
  dirty="$(git -C "$SKILLS_SRC" status --porcelain -- . | head -n 1)"
  echo "    source revision: $rev${dirty:+ + uncommitted changes}"
fi

# ── 2. semantius CLI ─────────────────────────────────────────────────────────
# Re-pins linux-x64/semantius-cli.json (commit it) and fetches the binary (gitignored).
# Git Bash: Windows node.exe needs a Windows path (it reads /c/dev/... as C:\c\dev\...).
FETCH_CLI="$ROOT/scripts/fetch-cli.mjs"
if command -v cygpath >/dev/null; then FETCH_CLI="$(cygpath -m "$FETCH_CLI")"; fi
node "$FETCH_CLI" "${1:-latest}"

echo "==> done. Ship with: pnpm deploy-semantius-agent, pnpm deploy-semantius-architect (skills), pnpm deploy:b (CLI image)"
