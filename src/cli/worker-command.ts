import { buildCommand } from "@stricli/core";
import {
  ConfigError,
  type Flags,
  type WorkerAttemptConfig,
} from "../core/config.js";
import type { Context } from "./context.js";
import { WORKER_DEATH_PROSE } from "./docs.js";
import { parseInteger, sharedFlags } from "./flags.js";

/**
 * The worker command's own flag surface: model overrides plus verbosity, the
 * three `sharedFlags` entries that still mean something for one Worker
 * running one Attempt. Scope and concurrency (`--parent`, `--all`,
 * `--max-workers`, `--max-open-prs`, `--poll-seconds`) plan a Tick's dispatch
 * — irrelevant here, so they're left off rather than accepted and ignored.
 */
export interface WorkerFlags {
  model?: string;
  retryModel?: string;
  verbose: boolean;
}

const { model, retryModel, verbose } = sharedFlags;

/**
 * Config resolution's flag surface, narrowed the same way
 * `resolveConfigFromFlags` narrows `CliFlags` in flags.ts — through
 * `loadWorkerConfig`, which unlike `loadConfig` needs no Scope (issue #71).
 */
function resolveConfigFromWorkerFlags(
  context: Context,
  flags: WorkerFlags,
): WorkerAttemptConfig | ConfigError {
  const configFlags: Flags = {};
  if (flags.model !== undefined) configFlags.model = flags.model;
  if (flags.retryModel !== undefined) configFlags.retryModel = flags.retryModel;
  try {
    return context.loadWorkerConfig(configFlags);
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
}

async function workerHandler(
  this: Context,
  flags: WorkerFlags,
  ticket: number,
  attempt: number,
): Promise<undefined | Error> {
  this.setVerbose(flags.verbose);
  const config = resolveConfigFromWorkerFlags(this, flags);
  if (config instanceof Error) return config;

  const outcome = await this.runWorker(config, ticket, attempt);
  if (!outcome.ok) {
    this.process.exitCode = 1;
  }
}

export const workerCommand = buildCommand<
  WorkerFlags,
  [number, number],
  Context
>({
  func: workerHandler,
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        {
          brief: "ticket (issue) number to run this Attempt against",
          parse: parseInteger,
          placeholder: "ticket",
        },
        {
          brief: "attempt number (1-based; binds the retry ladder's model)",
          parse: parseInteger,
          placeholder: "attempt",
        },
      ],
    },
    flags: { model, retryModel, verbose },
  },
  docs: {
    brief:
      "run one Worker session for a Ticket and Attempt, settling it itself",
    fullDescription: `worker runs a single Worker session against one Ticket and Attempt in the
current working directory — an isolated worktree on an agent branch, running
headless claude against exactly that ticket — then settles the outcome
itself instead of leaving it for a Tick to read back: a successful Attempt's
branch is pushed and opened as a draft PR that closes its ticket on merge,
its body taken from the Worker's final message (mechanical fallback: ticket
+ commit subjects).

${WORKER_DEATH_PROSE} settling here means the same tracker write a Tick's
act phase would perform, through the same shared unit — nothing is
duplicated.

The ticket is assumed already claimed (a Tick claims before dispatching);
worker performs no claim of its own. It exits non-zero whenever the Attempt
did not succeed — ticket failure or infrastructure failure alike — so a job
runner can see it.`,
  },
});
