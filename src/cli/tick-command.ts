import { buildCommand } from "@stricli/core";
import type { Context } from "./context.js";
import { WORKER_DEATH_PROSE } from "./docs.js";
import { type CliFlags, resolveConfigFromFlags, sharedFlags } from "./flags.js";

async function tickHandler(
  this: Context,
  flags: CliFlags,
): Promise<undefined | Error> {
  this.setVerbose(flags.verbose);
  const config = resolveConfigFromFlags(this, flags);
  if (config instanceof Error) return config;

  const { infraFailures } = await this.tick(config, flags.dryRun);
  if (infraFailures > 0) {
    // A standalone tick has no resident breaker of its own, but the next one
    // derives the same paused verdict from the void markers this Tick just
    // left on the tracker — so the operator can simply re-tick later.
    this.process.stdout.write(
      "Infrastructure failure detected: attempts voided, claims held. Re-run tick when the environment recovers.\n",
    );
  }
}

export const tickCommand = buildCommand<CliFlags, [], Context>({
  func: tickHandler,
  parameters: { flags: sharedFlags },
  docs: {
    brief: "run one idempotent pass against the target repo",
    fullDescription: `tick runs one idempotent pass against the target repo in the current working
directory: close tickets whose agent PR merged without closing them, keep the
remaining open agent PRs current (mechanical branch update for clean ones that
fell behind, a one-shot conflict-resolution Worker for conflicted ones, and a
draft→ready flip once CI is green), release orphaned agent claims, claim
dispatchable tickets (claim label + marker comment), then dispatch one Worker
per claim — an isolated worktree on an agent branch, running headless claude
against exactly that ticket — and report each Worker's outcome. A successful
Worker's branch is pushed and opened as a draft PR that closes its ticket on
merge, its body taken from the Worker's final message (mechanical fallback:
ticket + commit subjects). Dispatch pauses while open agent PRs sit at
max_open_prs and resumes as merges land.

${WORKER_DEATH_PROSE} the tick prints a notice so the operator knows to
re-run once the environment recovers. A standalone tick keeps no memory of
its own, but the circuit breaker it derives from the tracker's void markers
still holds dispatch paused across separate ticks on the same cooldown,
resuming once it elapses.`,
  },
});
