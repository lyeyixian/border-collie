import { createRequire } from "node:module";

/**
 * `npm version` bumps package.json at release time and the release workflow
 * guards that the tag matches it, so package.json is the single source of
 * truth for what `--version` should print — reading it at runtime keeps a
 * second copy from drifting. `../package.json` resolves to the same file in
 * both layouts this module runs from: src/ under tsx and vitest, dist/ in
 * the published tarball (npm always ships package.json alongside `files`).
 */
const pkg = createRequire(import.meta.url)("../package.json") as {
  version: string;
};

export const VERSION = pkg.version;
