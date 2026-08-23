import { buildCommand } from "@stricli/core";
import {
  declareRefused,
  declareTroubled,
  renderDeclareReport,
} from "../core/declare.js";
import {
  renderChecklist,
  renderLabelReport,
  renderScaffoldReport,
} from "../core/scaffold.js";
import type { Context } from "./context.js";

export interface InitFlags {
  force: boolean;
}

/**
 * Scaffold the workflows and tracker labels, then run `declare` as the
 * final step (issue #150) so onboarding a fresh repository stays one
 * command — re-scaffolding (`--force`) and re-declaring stay separate
 * operations with different cadences, but the first run needs both. The
 * scaffold and labels are reported the same way regardless of what declare
 * does — a repo that cannot reach the tracker still gets its workflows and
 * declare a fair try — but a declare session that itself did not finish
 * cleanly (killed by a watchdog, non-zero exit), or that found a regression
 * and refused to rewrite an existing contract, fails `init` overall, the
 * same non-zero-on-trouble contract `declare` keeps standalone.
 */
async function initHandler(this: Context, flags: InitFlags): Promise<void> {
  const actions = this.initScaffold(flags.force);
  const labels = await this.initLabels();
  const declared = await this.declare(this.loadWorkerConfig({}));
  this.process.stdout.write(
    `${renderScaffoldReport(actions)}\n\n${renderLabelReport(labels)}\n\n${renderChecklist()}\n\n${renderDeclareReport(declared)}\n`,
  );
  if (declareTroubled(declared) || declareRefused(declared)) {
    this.process.exitCode = 1;
  }
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
      "scaffold the Orchestrator and Worker workflows (refinement runs inline) and the Worker's skills into the target repo",
    fullDescription: `init scaffolds what a target repository needs to run border-collie in
GitHub Actions, into the current working directory: the workflows — the
Orchestrator's Tick (which also runs Conflict and Refinement Workers inline)
and the Worker job — under .github/workflows, the skills a Worker session
invokes under .claude/skills, and the agent docs those skills read under
docs/agents. It then creates the tracker labels the loop reads and writes,
and prints a checklist of the secrets and the minimum GitHub App permissions
to supply before the first run.

The skills are written rather than installed inside each Worker job, so an
unattended fleet is never handed an upstream change overnight, and the whole
closure the Worker's skill reaches is written, not merely that one skill.
Once written they belong to the repository: only the invoked skill's name is
load-bearing, and the rest are yours to edit, extend or delete.

A file already present at a scaffolded path is left alone and reported as
skipped, never overwritten silently; --force overwrites it instead, reported
as such. A label already on the tracker is likewise left exactly as it is,
--force or not: its colour and description belong to the repository. If the
tracker cannot be reached at all, the files are still scaffolded and the
labels are reported with the commands to create them by hand.

The listed GitHub App permissions deliberately exclude workflow
modification, so a Worker can never rewrite the workflow that runs it.`,
  },
});
