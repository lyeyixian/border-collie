#!/usr/bin/env node
/**
 * Rewrite the border-collie version the scaffolded workflows pin so it always
 * names this package's own version (issue #93).
 *
 * The workflows install the published CLI rather than building the checkout,
 * which makes the pin part of what `init` hands a target repo — and nothing
 * about bumping package.json updates a yml on its own. This runs from npm's
 * `version` lifecycle, after the bump and before the version commit, so the
 * rewrite rides along in that commit rather than trailing it. A test
 * (tests/adapters/scaffold.test.ts) fails the build if the two ever drift, so
 * forgetting to run this is caught rather than shipped.
 */
import { readFileSync, writeFileSync } from "node:fs";

const PIN_PATTERN = /(npm install -g border-collie@)(\S+)/g;

const { version } = JSON.parse(readFileSync("package.json", "utf8"));

// Deliberately duplicated from SCAFFOLD_FILES (src/core/scaffold.ts) rather
// than imported: this runs from the `version` lifecycle, where dist/ reflects
// whatever was last built, and a stale build silently syncing the wrong set
// of files is worse than two short lists that a drifting pin fails a test.
const TEMPLATES = [
  ".github/workflows/border-collie-tick.yml",
  ".github/workflows/border-collie-worker.yml",
];

let changed = false;

for (const relPath of TEMPLATES) {
  const before = readFileSync(relPath, "utf8");
  let pins = 0;
  const after = before.replace(PIN_PATTERN, (_match, install) => {
    pins += 1;
    return `${install}${version}`;
  });

  if (pins === 0) {
    console.error(
      `${relPath}: no \`npm install -g border-collie@<version>\` step to sync — the workflow no longer pins the Orchestrator`,
    );
    process.exit(1);
  }

  if (after === before) continue;

  writeFileSync(relPath, after);
  changed = true;
  console.log(`synced ${relPath} to border-collie@${version}`);
}

if (!changed) console.log(`already at border-collie@${version}`);
