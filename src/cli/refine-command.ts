import { buildCommand } from "@stricli/core";
import {
  ConfigError,
  type Flags,
  type WorkerAttemptConfig,
} from "../core/config.js";
import type { Context } from "./context.js";
import { parseInteger, sharedFlags } from "./flags.js";

/** The refine command's own flag surface, mirroring `ConflictWorkerFlags` (conflict-worker-command.ts). */
export interface RefineFlags {
  model?: string;
  timeoutMinutes?: number;
  verbose: boolean;
  inPlace: boolean;
}

const { model, verbose } = sharedFlags;

function resolveConfigFromFlags(
  context: Context,
  flags: RefineFlags,
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

async function refineHandler(
  this: Context,
  flags: RefineFlags,
  pr: number,
  ticket: number,
  headRef: string,
  round: number,
): Promise<undefined | Error> {
  this.setVerbose(flags.verbose);
  const config = resolveConfigFromFlags(this, flags);
  if (config instanceof Error) return config;

  await this.runRefinement(config, pr, ticket, headRef, round, flags.inPlace);
}

export const refineCommand = buildCommand<
  RefineFlags,
  [number, number, string, number],
  Context
>({
  func: refineHandler,
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        {
          brief: "pull request number the Refinement round investigates",
          parse: parseInteger,
          placeholder: "pr",
        },
        {
          brief: "ticket (issue) number the pull request implements",
          parse: parseInteger,
          placeholder: "ticket",
        },
        {
          brief: "head branch to commit a fix on and push back",
          parse: String,
          placeholder: "headRef",
        },
        {
          brief:
            "round number this dispatch charges (the Tick already posted its marker)",
          parse: parseInteger,
          placeholder: "round",
        },
      ],
    },
    flags: {
      model,
      timeoutMinutes: {
        kind: "parsed",
        parse: parseInteger,
        brief:
          "wall-clock ceiling for this Refinement round, in minutes (default 45, overrides config file)",
        placeholder: "n",
        optional: true,
      },
      verbose,
      inPlace: {
        kind: "boolean",
        brief:
          "check the head branch out in the current directory instead of an isolated worktree (for a Refinement round's own session container)",
        default: false,
      },
    },
  },
  docs: {
    brief:
      "run one Refinement round against an open agent pull request, settling it itself",
    fullDescription: `refine runs a single Refinement-round session against one open agent
pull request (CONTEXT.md "Refinement round"), then settles the outcome
itself instead of leaving it for a Tick to read back: the branch is pushed
back only when the round actually committed a fix. By default the branch is
cut in an isolated worktree so the operator's own checkout is untouched;
--in-place checks it out directly in the current working directory instead,
for a session container whose checkout is already dedicated to this one
round.

The round marker (REFINEMENT_ROUND_MARKER) is assumed already posted — a
Tick posts it before dispatching, charge-before-spend, so it counts even
across a crash; refine performs no marker write of its own. Like the
Conflict Worker, it is not an Attempt and counts toward no ticket's cap.`,
  },
});
