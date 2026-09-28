#!/usr/bin/env bash
# Refresh the two upstream inputs this repo vendors but never edits:
#
#   1. agents/semantius-admin/skills/<skill>/  <- mirror of the semantius-plugin skills.
#      Every skill folder is REPLACED, not merged, so files and whole skills dropped
#      upstream disappear here too. Ships with `pnpm deploy:agent semantius-admin`.
#   2. linux-x64/semantius-linux-x64           <- semantius CLI release binary, baked into
#      the backend-b container image. Ships with `pnpm deploy:b` (image change).
#
# Usage:  ./update.sh [cli-version]     e.g. ./update.sh v0.8.12   (default: latest release)
# Env:    SEMANTIUS_SKILLS_SRC          skills source folder
#                                       (default: /c/dev/semantius-agent/semantius-plugin/skills)
set -euo pipefail
shopt -s nullglob

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILLS_SRC="${SEMANTIUS_SKILLS_SRC:-/c/dev/semantius-agent/semantius-plugin/skills}"
SKILLS_DST="$ROOT/agents/semantius-admin/skills"
CLI_REPO="https://github.com/semantius/semantius-cli"
CLI_ASSET="semantius-linux-x64"
CLI_BIN="$ROOT/linux-x64/$CLI_ASSET"
CLI_TMP="$CLI_BIN.download"
trap 'rm -f "$CLI_TMP"' EXIT

die() { echo "update.sh: $*" >&2; exit 1; }
sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1; }

# Git Bash: accept a Windows path (C:\dev\...) for SEMANTIUS_SKILLS_SRC.
if command -v cygpath >/dev/null; then SKILLS_SRC="$(cygpath -u "$SKILLS_SRC")"; fi

# ── 1. skills ────────────────────────────────────────────────────────────────
echo "==> skills: $SKILLS_SRC -> agents/semantius-admin/skills/"
src_skills=("$SKILLS_SRC"/*/)
[ ${#src_skills[@]} -gt 0 ] || die "no skill folders in $SKILLS_SRC"
# Validate the whole source before deleting anything here.
for d in "${src_skills[@]}"; do
  [ -f "${d}SKILL.md" ] || die "not a skill (no SKILL.md): $d"
done

rm -rf "$SKILLS_DST"/*/
mkdir -p "$SKILLS_DST"
for d in "${src_skills[@]}"; do
  cp -R "${d%/}" "$SKILLS_DST/"
  echo "    $(basename "$d")"
done
if rev="$(git -C "$SKILLS_SRC" rev-parse --short HEAD 2>/dev/null)"; then
  dirty="$(git -C "$SKILLS_SRC" status --porcelain -- . | head -n 1)"
  echo "    source revision: $rev${dirty:+ + uncommitted changes}"
fi

# ── 2. semantius CLI ─────────────────────────────────────────────────────────
version="${1:-}"
if [ -z "$version" ]; then
  # /releases/latest redirects to /releases/tag/<tag> — no API token or jq needed.
  version="$(curl -fsSLI -o /dev/null -w '%{url_effective}' "$CLI_REPO/releases/latest")"
  version="${version##*/}"
fi
case "$version" in v*) ;; *) version="v$version" ;; esac
[[ "$version" =~ ^v[0-9] ]] || die "could not resolve a release tag (got '$version')"

base="$CLI_REPO/releases/download/$version"
echo "==> semantius CLI $version: $base/$CLI_ASSET"
want="$(curl -fsSL "$base/checksums.txt" | tr -d '\r' \
  | awk -v f="$CLI_ASSET" '$2 == f || $2 == "*" f { print $1 }')"
[ -n "$want" ] || die "no $CLI_ASSET entry in $base/checksums.txt"

if [ -f "$CLI_BIN" ] && [ "$(sha256 "$CLI_BIN")" = "$want" ]; then
  echo "    already up to date ($want)"
else
  mkdir -p "$(dirname "$CLI_BIN")"
  curl -fL --progress-bar -o "$CLI_TMP" "$base/$CLI_ASSET"
  got="$(sha256 "$CLI_TMP")"
  [ "$got" = "$want" ] || die "checksum mismatch for $CLI_ASSET: got $got, want $want"
  chmod 0755 "$CLI_TMP"
  mv -f "$CLI_TMP" "$CLI_BIN"
  echo "    installed linux-x64/$CLI_ASSET ($want)"
fi

echo "==> done. Ship with: pnpm deploy:agent semantius-admin (skills), pnpm deploy:b (CLI image)"
