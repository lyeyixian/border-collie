import { buildCommand } from "@stricli/core";
import type { Context } from "./cli-context.js";
import {
  type CliFlags,
  resolveConfigFromFlags,
  sharedFlags,
} from "./cli-flags.js";
import { ConfigError } from "./config.js";
import { run } from "./run.js";

async function runHandler(
  this: Context,
  flags: CliFlags,
): Promise<undefined | Error> {
  if (flags.dryRun) {
    return new ConfigError(
      "--dry-run only applies to tick: a dry run never progresses the loop",
    );
  }
  const config = resolveConfigFromFlags(this, flags);
  if (config instanceof Error) return config;

  const outcome = await run(config.pollSeconds, {
    tick: (dispatchPaused) => this.tick(config, false, dispatchPaused),
    probe: () => this.probe(config.model),
    now: this.now,
    sleep: this.sleep,
    log: (line) => this.process.stdout.write(`${line}\n`),
  });
  if (outcome === "stuck") {
    this.process.exitCode = 1;
  }
}

export const runCommand = buildCommand<CliFlags, [], Context>({
  func: runHandler,
  parameters: { flags: sharedFlags },
  docs: {
    brief: "repeat ticks until Complete (exit 0) or Stuck (exit 1)",
    fullDescription: `run repeats ticks at the poll interval until a terminal state: Complete
(every ticket in Scope closed, exit 0) or Stuck (open tickets remain but
every path forward runs through a human, exit 1). It keeps polling while
agent PRs await human merge.

Every way a Worker can die is noticed — non-zero exit, no commits, wall-clock
timeout, stall, turn-cap breach — and released with a forensic attempt
record. A finished Worker that spent past the cost cap keeps its work and
its PR; the overrun is flagged so oversized tickets surface. A once-failed
ticket is retried fresh on the stronger retry model; a twice-failed ticket is
Escalated to ready-for-human with the evidence. Environment deaths (usage
limit, rate limit, auth, network — or several Workers dying the same way in
one tick) are infrastructure failures instead: the attempt is voided,
burning nothing, and run's circuit breaker pauses dispatch with claims held,
probing the environment on a backoff until it recovers.

--dry-run is rejected here: a dry run never writes anything, so it can never
reach a terminal state and would loop forever.`,
  },
});
