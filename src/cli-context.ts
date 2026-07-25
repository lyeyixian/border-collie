import type { CommandContext, StricliProcess } from "@stricli/core";
import {
  type Flags,
  loadConfigFile,
  type ResolvedConfig,
  resolveConfig,
} from "./config.js";
import { tickOnce } from "./tick.js";
import type { Action, WorldSnapshot } from "./types.js";
import { probeEnvironment } from "./worker.js";

/** Every effect a command handler needs, injected so handlers never import them directly. */
export interface Context extends CommandContext {
  readonly process: StricliProcess;
  readonly loadConfig: (flags: Flags) => ResolvedConfig;
  readonly tick: (
    config: ResolvedConfig,
    dryRun: boolean,
    dispatchPaused?: boolean,
  ) => Promise<{
    world: WorldSnapshot;
    actions: Action[];
    infraFailures: number;
  }>;
  readonly probe: (model: string) => Promise<boolean>;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
}

/**
 * Node's `process.exitCode` is typed to allow `undefined`; stricli's
 * `StricliProcess.exitCode` isn't, so under `exactOptionalPropertyTypes`
 * the global `process` can't be passed through as-is. Adapt it instead of
 * widening stricli's type.
 */
function nodeProcessAdapter(): StricliProcess {
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
    get exitCode(): number | string | null {
      return process.exitCode ?? null;
    },
    set exitCode(value: number | string | null) {
      process.exitCode = value ?? undefined;
    },
  };
}

/** The real context: today's collaborators, wired exactly as the entry point wired them before. */
export function buildRealContext(): Context {
  return {
    process: nodeProcessAdapter(),
    loadConfig: (flags) => resolveConfig(loadConfigFile(process.cwd()), flags),
    tick: (config, dryRun, dispatchPaused) =>
      tickOnce(config, dryRun, dispatchPaused),
    probe: (model) => probeEnvironment(model),
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}
