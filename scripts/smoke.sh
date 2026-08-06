#!/usr/bin/env bash
#
# smoke.sh — prove the exact tarball npm would publish actually runs.
#
# Builds, packs the package, installs the tarball cold into a fresh temp
# directory (no workspace symlinks, no source tree), and runs
# `border-collie --help` from there. Exercises the files whitelist, bin
# wiring, ESM resolution, and shebang exactly as an npm/npx install would.
#
# Usage:
#   scripts/smoke.sh
#
# Exits non-zero on any failure.

set -euo pipefail

log() { printf '==> %s\n' "$*"; }
die() { printf 'smoke: %s\n' "$*" >&2; exit 1; }

root_dir=$(cd "$(dirname "$0")/.." && pwd)
cd "$root_dir"

log "Building"
pnpm run build

log "Packing"
tarball=$(npm pack --silent)
tarball_path="$root_dir/$tarball"

install_dir=$(mktemp -d)
cleanup() {
  rm -rf "$install_dir"
  rm -f "$tarball_path"
}
trap cleanup EXIT

log "Installing $tarball cold into $install_dir"
npm install "$tarball_path" --no-save --prefix "$install_dir" >/dev/null

bin="$install_dir/node_modules/.bin/border-collie"
[ -x "$bin" ] || die "no executable bin at $bin"

log "Running border-collie --help"
"$bin" --help >/dev/null || die "border-collie --help exited non-zero"

# --version reads package.json relative to the installed dist/, a path that
# only exists once the tarball is unpacked — the source tree can't prove it.
log "Running border-collie --version"
expected_version=$(node -p 'require("./package.json").version')
actual_version=$("$bin" --version) || die "border-collie --version exited non-zero"
[ "$actual_version" = "$expected_version" ] ||
  die "border-collie --version printed '$actual_version', expected '$expected_version'"

# `init`'s workflow templates ship alongside dist/ (package.json "files"),
# read at runtime relative to the installed package root — a path that only
# resolves correctly once the tarball is unpacked cold like this, with no
# workspace symlinks and no source tree to fall back on.
log "Running border-collie init against a fresh target repo"
target_dir=$(mktemp -d)
init_output=$(cd "$target_dir" && "$bin" init) ||
  die "border-collie init exited non-zero"

# The temp dir is no git repo, so the label step (issue #100) cannot reach a
# tracker — the case that must degrade to the checklist rather than take the
# scaffold down with it. Nothing but a cold run outside a repo proves it.
case "$init_output" in
*"gh label create claimed"*) ;;
*) die "init did not fall back to the hand-run label commands off-tracker" ;;
esac
for f in border-collie-tick.yml border-collie-worker.yml; do
  path="$target_dir/.github/workflows/$f"
  [ -s "$path" ] || die "init did not scaffold a non-empty $f"

  # The pin has to be the version doing the scaffolding, and only a cold
  # install of the tarball can prove it (issue #99): the templates inside a
  # release tarball are built from the `v<N>` tag, which predates the commit
  # that syncs them, so they name N-1 — exactly the state this repo is in
  # between `npm version` and `pnpm run sync:version`, and exactly what the
  # release workflow packs.
  pin=$(sed -n 's/.*npm install -g border-collie@\([^ ]*\).*/\1/p' "$path" | head -1)
  [ -n "$pin" ] || die "$f scaffolded no border-collie pin at all"
  [ "$pin" = "$expected_version" ] ||
    die "$f pins border-collie@$pin, expected @$expected_version (the version that scaffolded it)"
done
rm -rf "$target_dir"

log "Smoke passed"
