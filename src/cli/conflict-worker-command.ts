import { buildCommand } from "@stricli/core";
import {
  ConfigError,
  type Flags,
  type WorkerAttemptConfig,
} from "../core/config.js";
import type { Context } from "./context.js";
import { parseInteger, sharedFlags } from "./flags.js";

/**
 * The conflict-worker command's own flag surface: model override plus
 * verbosity and `--in-place`, mirroring `WorkerFlags` (worker-command.ts) —
 * a Conflict Worker has no attempt ladder (CONTEXT.md "Conflict Worker"), so
 * `--retry-model` is left off.
 */
export interface ConflictWorkerFlags {
  model?: string;
  timeoutMinutes?: number;
  verbose: boolean;
  inPlace: boolean;
}

const { model, verbose } = sharedFlags;

function resolveConfigFromFlags(
  context: Context,
  flags: ConflictWorkerFlags,
): WorkerAttemptConfig | ConfigError {
  const configFlags: Flags = {};
  if (flags.model !== undefined) configFlags.model = flags.model;
  if (flags.timeoutMinutes !== undefined)
    configFlags.timeoutMinutes = flags.timeoutMinutes;
  try {
    return context.loadWorkerConfig(configFlags);
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
}

async function conflictWorkerHandler(
  this: Context,
  flags: ConflictWorkerFlags,
  pr: number,
  ticket: number,
  headRef: string,
): Promise<undefined | Error> {
  this.setVerbose(flags.verbose);
  const config = resolveConfigFromFlags(this, flags);
  if (config instanceof Error) return config;

  const outcome = await this.runConflictWorker(
    config,
    pr,
    ticket,
    headRef,
    flags.inPlace,
  );
  if (!outcome.resolved) {
    this.process.exitCode = 1;
  }
}

export const conflictWorkerCommand = buildCommand<
  ConflictWorkerFlags,
  [number, number, string],
  Context
>({
  func: conflictWorkerHandler,
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        {
          brief:
            "pull request number the Conflict Worker resolves conflicts on",
          parse: parseInteger,
          placeholder: "pr",
        },
        {
          brief: "ticket (issue) number the pull request implements",
          parse: parseInteger,
          placeholder: "ticket",
        },
        {
          brief: "head branch to rebase and push back",
          parse: String,
          placeholder: "headRef",
        },
      ],
    },
    flags: {
      model,
      timeoutMinutes: {
        kind: "parsed",
        parse: parseInteger,
        brief:
          "wall-clock ceiling for this Conflict Worker, in minutes (default 45, overrides config file)",
        placeholder: "n",
        optional: true,
      },
      verbose,
      inPlace: {
        kind: "boolean",
        brief:
          "check the head branch out in the current directory instead of an isolated worktree (for a Conflict Worker's own session container)",
        default: false,
      },
    },
  },
  docs: {
    brief:
      "run one Conflict Worker session against a conflicted pull request, settling it itself",
    fullDescription: `conflict-worker runs a single Conflict Worker session against one pull
request's already-started rebase (CONTEXT.md "Conflict Worker"), then settles
the outcome itself instead of leaving it for a Tick to read back: a resolved
rebase is pushed back to the PR's branch and the PR converted to draft for a
re-read before it can merge (ADR 0007); an unresolved one is handed to a
human through the same marker comment a synchronous dispatch posts. By
default the branch is cut in an isolated worktree so the operator's own
checkout is untouched; --in-place checks it out directly in the current
working directory instead, for a session container whose checkout is already
dedicated to this one Conflict Worker.

It is not an Attempt and counts toward no ticket's cap. It exits non-zero
whenever the conflict was not resolved, so a job runner can see it.`,
  },
});
