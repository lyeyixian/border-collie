import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GITIGNORE_PATH } from "../core/scaffold.js";

/**
 * This package's own root: two directories up from this module, whether
 * running compiled (dist/adapters/ → dist/ → package root) or from source
 * (src/adapters/ → src/ → repo root) — the same relationship in both
 * layouts. The scaffolded workflow templates ship alongside `dist` (see
 * package.json "files") rather than as duplicated strings, so what `init`
 * hands a target repo can never drift from what this repo runs itself.
 */
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export function fileExists(cwd: string, relPath: string): boolean {
  return existsSync(join(cwd, relPath));
}

export function writeScaffoldFile(
  cwd: string,
  relPath: string,
  content: string,
): void {
  const target = join(cwd, relPath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

/** Read a scaffold template's content from this package's own tree (see `SCAFFOLD_FILES`, core/scaffold.ts). */
export function loadTemplate(relPath: string): string {
  return readFileSync(join(PACKAGE_ROOT, relPath), "utf8");
}

/**
 * The target repo's own `.gitignore`, or undefined when it has none yet
 * (issue #154) — the one file `planGitignore` (core/scaffold.ts) needs read
 * off disk rather than templated, since it belongs to the repository, not to
 * this package's tree.
 */
export function readGitignore(cwd: string): string | undefined {
  const target = join(cwd, GITIGNORE_PATH);
  return existsSync(target) ? readFileSync(target, "utf8") : undefined;
}

/**
 * The version of the border-collie doing the scaffolding, read from this
 * package's own manifest — what `pinCliVersion` writes into the workflows it
 * hands a target repo (issue #99). Read rather than baked in at build time
 * for the same reason the templates are shipped rather than duplicated: the
 * manifest beside `dist` is the one thing that cannot drift from what npm
 * installed.
 */
export function cliVersion(): string {
  const manifest = readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8");
  return JSON.parse(manifest).version as string;
}
