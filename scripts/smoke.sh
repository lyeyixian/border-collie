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

# `init`'s templates — the workflows, the vendored Worker skills and the agent
# docs those read — ship alongside dist/ (package.json "files"), read at
# runtime relative to the installed package root: a path that only resolves
# correctly once the tarball is unpacked cold like this, with no workspace
# symlinks and no source tree to fall back on. A scaffolded path left out of
# "files" is invisible to every test in the repo and fails only here.
log "Running border-collie init against a fresh target repo"
target_dir=$(mktemp -d)
init_output=$(cd "$target_dir" && "$bin" init) ||
  die "border-collie init exited non-zero"

# The temp dir is no git repo, so the label step (issue #100) cannot reach a
# tracker — the case that must degrade to the checklist rather than take the
# scaffold down with it. Nothing but a cold run outside a repo proves it.
case "$init_output" in
*"gh label create border-collie:claimed"*) ;;
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

# The Worker's skills are files `init` writes, not a plugin the Worker job
# installs (issue #153), so a scaffolded repo that got the workflows but none
# of the skills would dispatch Workers that improvise over an unhandled
# `/implement` — an oddly-shaped pull request rather than a failure.
#
# The list is read off the *installed* package rather than repeated here: this
# loop exists to prove the tarball carries every file `init` says it writes,
# and a copy that drifted would quietly stop proving exactly that. Everything
# else in this script keeps its own copy (see scripts/sync-workflow-version.mjs
# on why that is deliberate) — this one cannot, because it is the only place a
# path missing from package.json "files" ever surfaces.
installed="$install_dir/node_modules/border-collie"
scaffolded=$(node --input-type=module -e \
  "import { SCAFFOLD_FILES } from 'file://$installed/dist/core/scaffold.js';
   console.log(SCAFFOLD_FILES.join('\n'))") ||
  die "could not read SCAFFOLD_FILES from the installed package"
[ -n "$scaffolded" ] || die "the installed package scaffolds no files at all"

while IFS= read -r f; do
  [ -s "$target_dir/$f" ] || die "init did not scaffold a non-empty $f"
done <<<"$scaffolded"

# The one skill whose name the Worker prompt hardcodes has to survive the
# tarball under exactly that name, or a Worker session receives unhandled text.
worker_skill=$(node --input-type=module -e \
  "import { WORKER_SKILL } from 'file://$installed/dist/core/types.js';
   console.log(WORKER_SKILL)") ||
  die "could not read WORKER_SKILL from the installed package"
grep -q "^name: $worker_skill\$" \
  "$target_dir/.claude/skills/$worker_skill/SKILL.md" ||
  die "the scaffolded $worker_skill skill declares no 'name: $worker_skill' front matter"

rm -rf "$target_dir"

log "Smoke passed"
