import { buildCommand } from "@stricli/core";
import { run } from "../app/run.js";
import { ConfigError } from "../core/config.js";
import type { Context } from "./context.js";
import { WORKER_DEATH_PROSE } from "./docs.js";
import { type CliFlags, resolveConfigFromFlags, sharedFlags } from "./flags.js";

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
    log: this.log,
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

${WORKER_DEATH_PROSE} run's circuit breaker pauses dispatch with claims held,
probing the environment on a backoff until it recovers.

--dry-run is rejected here: a dry run never writes anything, so it can never
reach a terminal state and would loop forever.`,
  },
});
