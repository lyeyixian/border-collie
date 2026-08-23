import { buildCommand } from "@stricli/core";
import {
  ConfigError,
  type Flags,
  type WorkerAttemptConfig,
} from "../core/config.js";
import { declareTroubled, renderDeclareReport } from "../core/declare.js";
import type { Context } from "./context.js";
import { parseInteger, sharedFlags } from "./flags.js";

/**
 * `declare`'s own flag surface: the retry model and timeout overrides that
 * still mean something for one Onboarding Worker session, plus verbosity.
 * No `--model`: an Onboarding Worker always runs on the retry model, never
 * the worker model (issue #150) — offering `--model` would let it silently
 * mean the opposite of what it means for `worker`. Scope and concurrency
 * flags are left off entirely, the same reasoning `worker-command.ts` gives
 * for its own narrowed surface. `--retry-model` is redefined rather than
 * taken from `sharedFlags` as-is: its shared brief talks about "second
 * attempts", which does not apply here — there is no attempt ladder, only
 * the one session, always on this model.
 */
export interface DeclareFlags {
  retryModel?: string;
  timeoutMinutes?: number;
  verbose: boolean;
}

const { verbose } = sharedFlags;

function resolveConfigFromDeclareFlags(
  context: Context,
  flags: DeclareFlags,
): WorkerAttemptConfig | ConfigError {
  const configFlags: Flags = {};
  if (flags.retryModel !== undefined) configFlags.retryModel = flags.retryModel;
  if (flags.timeoutMinutes !== undefined)
    configFlags.timeoutMinutes = flags.timeoutMinutes;
  try {
    return context.loadWorkerConfig(configFlags);
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
}

async function declareHandler(
  this: Context,
  flags: DeclareFlags,
): Promise<undefined | Error> {
  this.setVerbose(flags.verbose);
  const config = resolveConfigFromDeclareFlags(this, flags);
  if (config instanceof Error) return config;

  const outcome = await this.declare(config);
  this.process.stdout.write(`${renderDeclareReport(outcome)}\n`);
  // A cost overrun is an alarm, not a failure (the session's work is kept
  // either way) — only a session that did not itself finish cleanly fails
  // the command, the same non-zero-on-trouble contract `worker` keeps.
  if (declareTroubled(outcome)) {
    this.process.exitCode = 1;
  }
}

export const declareCommand = buildCommand<DeclareFlags, [], Context>({
  func: declareHandler,
  parameters: {
    flags: {
      retryModel: {
        kind: "parsed",
        parse: String,
        brief:
          "model the Onboarding Worker runs on (default opus, overrides config file)",
        placeholder: "name",
        optional: true,
      },
      timeoutMinutes: {
        kind: "parsed",
        parse: parseInteger,
        brief:
          "wall-clock ceiling for the Onboarding Worker, in minutes (default 45, overrides config file)",
        placeholder: "n",
        optional: true,
      },
      verbose,
    },
  },
  docs: {
    brief:
      "run an Onboarding Worker that writes this repository's verify contract",
    fullDescription: `declare runs a fresh-context Onboarding Worker directly against the repository
in the current working directory — no worktree, no branch, no pull request.
It works out which commands the repository already has for building,
linting, type-checking and testing, runs each one once, and writes
WORKFLOW.md declaring only the commands that already exist and already
passed: declare declares, it never authors, so an empty contract is a valid
outcome. Like ready-for-agent, it executes arbitrary commands from the
repository to find out — the same trust boundary.

The contract lands uncommitted in the working tree for a human to review as
a diff. A machine-readable sidecar under .border-collie/ names every
candidate the session looked at but excluded, and why; declare reads it,
folds it into this report, and deletes it.

It runs once, on the retry model rather than the worker model, bounded by a
wall-clock timeout, a stall watchdog, and a cost cap — no Attempt counting,
no retry ladder, no tracker writes. init runs declare as its own final
step, so onboarding a fresh repository stays one command.`,
  },
});
