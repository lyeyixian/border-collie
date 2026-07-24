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

log "Smoke passed"
