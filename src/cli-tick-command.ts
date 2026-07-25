import { buildCommand } from "@stricli/core";
import type { Context } from "./cli-context.js";
import {
  type CliFlags,
  resolveConfigFromFlags,
  sharedFlags,
} from "./cli-flags.js";

async function tickHandler(
  this: Context,
  flags: CliFlags,
): Promise<undefined | Error> {
  const config = resolveConfigFromFlags(this, flags);
  if (config instanceof Error) return config;

  const { infraFailures } = await this.tick(config, flags.dryRun);
  if (infraFailures > 0) {
    // A standalone tick has no resident breaker to hold open; the voided
    // claims stay held on the tracker, so the operator just re-ticks later.
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
dispatchable tickets (assign + marker comment), then dispatch one Worker per
claim — an isolated worktree on an agent branch, running headless claude
against exactly that ticket — and report each Worker's outcome. A successful
Worker's branch is pushed and opened as a draft PR that closes its ticket on
merge, its body taken from the Worker's final message (mechanical fallback:
ticket + commit subjects). Dispatch pauses while open agent PRs sit at
max_open_prs and resumes as merges land.

Every way a Worker can die is noticed — non-zero exit, no commits, wall-clock
timeout, stall, turn-cap breach — and released with a forensic attempt
record. A finished Worker that spent past the cost cap keeps its work and
its PR; the overrun is flagged so oversized tickets surface. A once-failed
ticket is retried fresh on the stronger retry model; a twice-failed ticket is
Escalated to ready-for-human with the evidence. Environment deaths (usage
limit, rate limit, auth, network — or several Workers dying the same way in
one tick) are infrastructure failures instead: the attempt is voided,
burning nothing, and the tick prints a notice so the operator knows to
re-run once the environment recovers.`,
  },
});
