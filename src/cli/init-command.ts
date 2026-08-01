import { buildCommand } from "@stricli/core";
import { renderChecklist, renderScaffoldReport } from "../core/scaffold.js";
import type { Context } from "./context.js";

export interface InitFlags {
  force: boolean;
}

function initHandler(this: Context, flags: InitFlags): void {
  const actions = this.initScaffold(flags.force);
  this.process.stdout.write(
    `${renderScaffoldReport(actions)}\n\n${renderChecklist()}\n`,
  );
}

export const initCommand = buildCommand<InitFlags, [], Context>({
  func: initHandler,
  parameters: {
    flags: {
      force: {
        kind: "boolean",
        brief:
          "overwrite a scaffolded file that already exists instead of leaving it alone",
        default: false,
      },
    },
  },
  docs: {
    brief:
      "scaffold the Orchestrator and Worker workflows (refinement runs inline) into the target repo",
    fullDescription: `init scaffolds the workflows a target repository needs to run border-collie
in GitHub Actions — the Orchestrator's Tick (which also runs Conflict and
Refinement Workers inline) and the Worker job, skills setup included — into
.github/workflows in the current working directory, then prints a checklist
of the secrets and the minimum GitHub App permissions to supply before the
first run.

A file already present at a scaffolded path is left alone and reported as
skipped, never overwritten silently; --force overwrites it instead, reported
as such. The listed GitHub App permissions deliberately exclude workflow
modification, so a Worker can never rewrite the workflow that runs it.`,
  },
});
