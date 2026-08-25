import {
  buildCommand,
  type CommandContext,
  type FlagParametersForType,
} from "@stricli/core";
import {
  ConfigError,
  type DaemonConfig,
  type DaemonFlags,
} from "../core/config.js";
import type { Context } from "./context.js";
import { parseInteger, sharedFlags } from "./flags.js";

/** Narrows the CLI's flags shape to what config resolution accepts, dropping `verbose` (a CLI-only concern) and every unset flag — same shape as `flags.ts`'s `toConfigFlags`. */
function toDaemonConfigFlags(
  flags: DaemonFlags & { verbose: boolean },
): DaemonFlags {
  const configFlags: DaemonFlags = {};
  if (flags.pollSeconds !== undefined)
    configFlags.pollSeconds = flags.pollSeconds;
  if (flags.image !== undefined) configFlags.image = flags.image;
  if (flags.stateDir !== undefined) configFlags.stateDir = flags.stateDir;
  if (flags.probeModel !== undefined) configFlags.probeModel = flags.probeModel;
  return configFlags;
}

/**
 * Resolve config for a daemon run, translating a `ConfigError` into a
 * returned (not thrown) error so stricli prints a one-line message instead
 * of a stack trace — the same shape `flags.ts`'s `resolveConfigFromFlags`
 * gives `tick`/`run`, synchronous here since `loadDaemonConfig` needs no
 * network read.
 */
function resolveDaemonConfigFromFlags(
  context: Context,
  flags: DaemonFlags & { verbose: boolean },
): DaemonConfig | ConfigError {
  try {
    return context.loadDaemonConfig(toDaemonConfigFlags(flags));
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
}

async function daemonHandler(
  this: Context,
  flags: DaemonFlags & { verbose: boolean },
): Promise<undefined | Error> {
  this.setVerbose(flags.verbose);
  const config = resolveDaemonConfigFromFlags(this, flags);
  if (config instanceof Error) return config;

  await this.daemon(config);
}

export const daemonCommand = buildCommand<
  DaemonFlags & { verbose: boolean },
  [],
  Context
>({
  func: daemonHandler,
  parameters: {
    flags: {
      pollSeconds: {
        kind: "parsed",
        parse: parseInteger,
        brief:
          "seconds between fleet polls, and the interval a repository must idle before it is due again (default 30)",
        placeholder: "n",
        optional: true,
      },
      image: {
        kind: "parsed",
        parse: String,
        brief:
          "border-collie session image a Worker Attempt's container runs (or set BORDER_COLLIE_WORKER_IMAGE)",
        placeholder: "name",
        optional: true,
      },
      stateDir: {
        kind: "parsed",
        parse: String,
        brief:
          "the daemon's own local checkout directory (default ~/.border-collie)",
        placeholder: "dir",
        optional: true,
      },
      probeModel: {
        kind: "parsed",
        parse: String,
        brief:
          "model the circuit breaker's recovery probe runs on (default sonnet)",
        placeholder: "name",
        optional: true,
      },
      verbose: sharedFlags.verbose,
    } as const satisfies FlagParametersForType<
      DaemonFlags & { verbose: boolean },
      CommandContext
    >,
  },
  docs: {
    brief: "herd every installed repository from one long-running process",
    fullDescription: `daemon walks the fleet — every repository the GitHub App is installed on
(read fresh every poll, never a list border-collie stores) — on an interval,
running one Tick per repository due, each with its own repository-scoped
installation token and its own Worker Attempts dispatched into their own
session containers. Two Ticks for one repository never overlap, and one
repository's slow Tick never delays another's. Repository ordering is
round-robin: a repository just ticked moves to the back of the queue, so one
repository with a long queue of its own Tickets cannot monopolise the loop.

There is no concurrency cap: a rate-limited session already classifies as an
Infrastructure failure, which voids the Attempt and trips that repository's
own circuit breaker rather than counting against it, so walking into the
account's usage window degrades rather than breaks.

The daemon never returns; stop it the way you would any other long-running
process (a service manager, or an interrupt signal). A restart loses no work
in flight — every session container runs detached, settles its own Attempt
against the tracker, and is re-adopted by container label the next time the
daemon lists what is still running for that repository.

Requires BORDER_COLLIE_APP_ID, BORDER_COLLIE_APP_PRIVATE_KEY and
CLAUDE_CODE_OAUTH_TOKEN in the environment, and a session image named either
by --image or BORDER_COLLIE_WORKER_IMAGE.`,
  },
});
