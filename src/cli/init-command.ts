import { buildCommand } from "@stricli/core";
import {
  renderChecklist,
  renderLabelReport,
  renderScaffoldReport,
} from "../core/scaffold.js";
import type { Context } from "./context.js";

export interface InitFlags {
  force: boolean;
}

async function initHandler(this: Context, flags: InitFlags): Promise<void> {
  const actions = this.initScaffold(flags.force);
  const labels = await this.initLabels();
  this.process.stdout.write(
    `${renderScaffoldReport(actions)}\n\n${renderLabelReport(labels)}\n\n${renderChecklist()}\n`,
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
.github/workflows in the current working directory, creates the tracker
labels the loop reads and writes, then prints a checklist of the secrets and
the minimum GitHub App permissions to supply before the first run.

A file already present at a scaffolded path is left alone and reported as
skipped, never overwritten silently; --force overwrites it instead, reported
as such. A label already on the tracker is likewise left exactly as it is,
--force or not: its colour and description belong to the repository. If the
tracker cannot be reached at all, the workflows are still scaffolded and the
labels are reported with the commands to create them by hand.

The listed GitHub App permissions deliberately exclude workflow
modification, so a Worker can never rewrite the workflow that runs it.`,
  },
});
