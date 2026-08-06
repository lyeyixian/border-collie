import {
  cliVersion,
  fileExists,
  loadTemplate,
  writeScaffoldFile,
} from "../adapters/scaffold.js";
import { createLabel, listLabelNames } from "../adapters/tracker.js";
import {
  type LabelAction,
  pinCliVersion,
  planScaffold,
  SCAFFOLD_FILES,
  type ScaffoldAction,
  scaffoldWrites,
} from "../core/scaffold.js";
import { ORCHESTRATOR_LABELS, type OrchestratorLabel } from "../core/types.js";

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

export interface InitLabelDeps {
  listLabels: () => Promise<string[]>;
  createLabel: (label: OrchestratorLabel) => Promise<void>;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Create the tracker labels the loop depends on (issue #100), skipping the
 * ones already there — the same write-what's-missing, leave-what-exists shape
 * the workflow files get, and for the same reason: those labels belong to the
 * target repository, not to `init`.
 *
 * A tracker `init` cannot reach is reported, never thrown. This is the one
 * step that needs a network and an authenticated `gh`, and the workflow files
 * are on disk by the time it runs — failing the command outright would take a
 * scaffold the operator already has and call it an error. Every label is
 * returned as `failed` instead, which the report turns into the hand-run
 * commands, degrading to exactly the checklist treatment the App permissions
 * get.
 */
export async function runInitLabels(
  deps: InitLabelDeps,
): Promise<LabelAction[]> {
  let existing: Set<string>;
  try {
    existing = new Set(await deps.listLabels());
  } catch (error) {
    const unreachable = messageOf(error);
    return ORCHESTRATOR_LABELS.map((label) => ({
      name: label.name,
      outcome: "failed" as const,
      error: unreachable,
    }));
  }

  const actions: LabelAction[] = [];
  for (const label of ORCHESTRATOR_LABELS) {
    if (existing.has(label.name)) {
      actions.push({ name: label.name, outcome: "exists" });
      continue;
    }
    try {
      await deps.createLabel(label);
      actions.push({ name: label.name, outcome: "created" });
    } catch (error) {
      // One refused label must not cost the others their attempt: an
      // operator handed a partial set should still be told which.
      actions.push({
        name: label.name,
        outcome: "failed",
        error: messageOf(error),
      });
    }
  }
  return actions;
}

/** The real composition for the label step. */
export function initLabelsOnce(): Promise<LabelAction[]> {
  return runInitLabels({
    listLabels: () => listLabelNames(),
    createLabel: (label) => createLabel(label),
  });
}
