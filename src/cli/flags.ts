import type { CommandContext, FlagParametersForType } from "@stricli/core";
import {
  ConfigError,
  type Flags,
  type ResolvedConfig,
} from "../core/config.js";
import type { Context } from "./context.js";

/** The ten-flag set shared by `tick` and `run`; every field optional except the three booleans. */
export interface CliFlags {
  dryRun: boolean;
  parent?: number;
  all: boolean;
  maxWorkers?: number;
  maxOpenPrs?: number;
  pollSeconds?: number;
  model?: string;
  retryModel?: string;
  /** CLI-only, like `dryRun`: lowers the console's minimum level to debug, never the file's. */
  verbose: boolean;
}

/** The CLI's flags shape narrowed to what config resolution accepts (drops `dryRun`, a CLI-only concern). */
function toConfigFlags(flags: CliFlags): Flags {
  const configFlags: Flags = {};
  if (flags.parent !== undefined) configFlags.parent = flags.parent;
  if (flags.maxWorkers !== undefined) configFlags.maxWorkers = flags.maxWorkers;
  if (flags.maxOpenPrs !== undefined) configFlags.maxOpenPrs = flags.maxOpenPrs;
  if (flags.pollSeconds !== undefined)
    configFlags.pollSeconds = flags.pollSeconds;
  if (flags.all) configFlags.all = true;
  if (flags.model !== undefined) configFlags.model = flags.model;
  if (flags.retryModel !== undefined) configFlags.retryModel = flags.retryModel;
  return configFlags;
}

/**
 * Resolve config for a command run, translating a `ConfigError` into a
 * returned (not thrown) error so stricli prints a one-line message instead
 * of a stack trace.
 */
export function resolveConfigFromFlags(
  context: Context,
  flags: CliFlags,
): ResolvedConfig | ConfigError {
  try {
    return context.loadConfig(toConfigFlags(flags));
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
}

/**
 * stricli's built-in number parser accepts floats; the flags below are
 * strictly digits-only, so they keep this custom parser instead.
 */
function parseInteger(input: string): number {
  if (!/^\d+$/.test(input)) {
    throw new SyntaxError(`must be an integer, got "${input}"`);
  }
  return Number(input);
}

export const sharedFlags = {
  dryRun: {
    kind: "boolean",
    brief: "print the dispatch plan without writing anything (tick only)",
    default: false,
  },
  parent: {
    kind: "parsed",
    parse: parseInteger,
    brief: "scope: sub-issues of parent issue #n (overrides config file)",
    placeholder: "n",
    optional: true,
  },
  all: {
    kind: "boolean",
    brief: "scope: every agent-ready issue in the repo (explicit opt-in)",
    default: false,
  },
  maxWorkers: {
    kind: "parsed",
    parse: parseInteger,
    brief: "cap on planned claims (default 3, overrides config file)",
    placeholder: "n",
    optional: true,
  },
  maxOpenPrs: {
    kind: "parsed",
    parse: parseInteger,
    brief:
      "open agent PRs that pause dispatch (default 5, overrides config file)",
    placeholder: "n",
    optional: true,
  },
  pollSeconds: {
    kind: "parsed",
    parse: parseInteger,
    brief: "seconds between run's ticks (default 30, overrides config file)",
    placeholder: "n",
    optional: true,
  },
  model: {
    kind: "parsed",
    parse: String,
    brief: "model Workers run on (default sonnet, overrides config file)",
    placeholder: "name",
    optional: true,
  },
  retryModel: {
    kind: "parsed",
    parse: String,
    brief: "model second attempts run on (default opus, overrides config file)",
    placeholder: "name",
    optional: true,
  },
  verbose: {
    kind: "boolean",
    brief:
      "lower the console's minimum level to debug (the durable file is already at debug regardless)",
    default: false,
  },
} as const satisfies FlagParametersForType<CliFlags, CommandContext>;
