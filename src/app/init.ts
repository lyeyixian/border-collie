import {
  cliVersion,
  fileExists,
  loadTemplate,
  writeScaffoldFile,
} from "../adapters/scaffold.js";
import {
  pinCliVersion,
  planScaffold,
  SCAFFOLD_FILES,
  type ScaffoldAction,
  scaffoldWrites,
} from "../core/scaffold.js";

export interface InitScaffoldDeps {
  exists: (cwd: string, relPath: string) => boolean;
  write: (cwd: string, relPath: string, content: string) => void;
  loadTemplate: (relPath: string) => string;
  cliVersion: () => string;
}

/**
 * Plan and perform the scaffold: never overwrites an existing file unless
 * `force` says so (issue #76), reported either way. Fully injected so a
 * fake filesystem exercises this without touching disk.
 *
 * The templates go out pinned to the running CLI's own version rather than to
 * whatever version their text happened to name when the tarball was built
 * (issue #99) — the version doing the scaffolding is the one the target repo
 * should be herded by.
 */
export function runInitScaffold(
  cwd: string,
  force: boolean,
  deps: InitScaffoldDeps,
): ScaffoldAction[] {
  const existing = new Set(
    SCAFFOLD_FILES.filter((relPath) => deps.exists(cwd, relPath)),
  );
  const actions = planScaffold(existing, force);
  const version = deps.cliVersion();
  for (const action of scaffoldWrites(actions)) {
    const template = deps.loadTemplate(action.relPath);
    deps.write(cwd, action.relPath, pinCliVersion(template, version));
  }
  return actions;
}

/** The real composition: today's collaborators, wired exactly as `init` needs them. */
export function initScaffoldOnce(
  cwd: string,
  force: boolean,
): ScaffoldAction[] {
  return runInitScaffold(cwd, force, {
    exists: fileExists,
    write: writeScaffoldFile,
    loadTemplate,
    cliVersion,
  });
}
