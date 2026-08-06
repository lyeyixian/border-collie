#!/usr/bin/env node
/**
 * Point this repository's own fleet at the version it most recently published
 * (issue #93), by rewriting the `border-collie@<version>` pin in the two
 * scaffolded workflows to match package.json.
 *
 * Run this *after* a release publishes, never before — see README "Release
 * process". The pin names what the workflows `npm install -g`, so a pin ahead
 * of npm 404s every Tick until the publish lands; a pin behind it merely
 * keeps the fleet on the previous version, which is why the guard in
 * tests/adapters/scaffold.test.ts rejects only the former.
 *
 * This moves *this* repository's own fleet, and nothing else. A repo
 * scaffolded by `init` gets the version of the CLI that scaffolded it
 * (`pinCliVersion`, src/core/scaffold.ts), so it no longer inherits whatever
 * this file last wrote into the templates — which, in a published tarball, is
 * always the release before it (issue #99).
 */
import { readFileSync, writeFileSync } from "node:fs";

const PIN_PATTERN = /(npm install -g border-collie@)(\S+)/g;

const { version } = JSON.parse(readFileSync("package.json", "utf8"));

// Deliberately duplicated from SCAFFOLD_FILES (src/core/scaffold.ts) rather
// than imported, so this stays a plain node script with no build step —
// matching scripts/logs-pretty.mjs's own copy of RUN_DIR. A file added there
// and forgotten here keeps a stale pin, which the guard catches at the next
// release rather than silently shipping.
const TEMPLATES = [
  ".github/workflows/border-collie-tick.yml",
  ".github/workflows/border-collie-worker.yml",
];

// Every template is read and checked before any is written: this rewrites
// files that are also the `init` templates, and a run that updates one and
// exits on the next would leave the two disagreeing about which version the
// fleet runs.
const planned = TEMPLATES.map((relPath) => {
  const before = readFileSync(relPath, "utf8");
  let pins = 0;
  const after = before.replace(PIN_PATTERN, (_match, install) => {
    pins += 1;
    return `${install}${version}`;
  });

  return { relPath, before, after, pins };
});

const unpinned = planned.filter((template) => template.pins === 0);

if (unpinned.length > 0) {
  for (const { relPath } of unpinned) {
    console.error(
      `${relPath}: no \`npm install -g border-collie@<version>\` step to sync — the workflow no longer pins the CLI`,
    );
  }
  process.exit(1);
}

const changed = planned.filter(
  (template) => template.after !== template.before,
);

for (const { relPath, after } of changed) {
  writeFileSync(relPath, after);
  console.log(`synced ${relPath} to border-collie@${version}`);
}

if (changed.length === 0) console.log(`already at border-collie@${version}`);
