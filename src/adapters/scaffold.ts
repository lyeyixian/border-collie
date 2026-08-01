import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
