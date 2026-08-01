import {
  fileExists,
  loadTemplate,
  writeScaffoldFile,
} from "../adapters/scaffold.js";
import {
  planScaffold,
  SCAFFOLD_FILES,
  type ScaffoldAction,
  scaffoldWrites,
} from "../core/scaffold.js";

export interface InitScaffoldDeps {
  exists: (cwd: string, relPath: string) => boolean;
  write: (cwd: string, relPath: string, content: string) => void;
  loadTemplate: (relPath: string) => string;
}

/**
 * Plan and perform the scaffold: never overwrites an existing file unless
 * `force` says so (issue #76), reported either way. Fully injected so a
 * fake filesystem exercises this without touching disk.
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
  for (const action of scaffoldWrites(actions)) {
    deps.write(cwd, action.relPath, deps.loadTemplate(action.relPath));
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
  });
}
