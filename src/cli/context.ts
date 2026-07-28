import type { CommandContext, StricliProcess } from "@stricli/core";
import { Logger } from "tslog";
import { loadConfigFile } from "../adapters/config-file.js";
import { probeEnvironment } from "../adapters/worker.js";
import { tickOnce } from "../app/tick.js";
import {
  type Flags,
  type ResolvedConfig,
  resolveConfig,
} from "../core/config.js";
import type { Log, LogBindings, LogEvent } from "../core/log.js";
import type { Action, WorldSnapshot } from "../core/types.js";
import { reportBlockText } from "./console-report.js";

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
  /** The single logging seam narration travels through; see src/core/log.ts. */
  readonly log: Log;
  /** The verbosity flag: lowers the console's minimum level to debug. Scoped to the console sink only. */
  readonly setVerbose: (verbose: boolean) => void;
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

/** The console tag for a Worker's (or Conflict Worker's) sub-logger — what distinguishes its interleaved lines. */
function tagFor(bindings: LogBindings): string {
  if (bindings.pr !== undefined) return `PR #${bindings.pr}`;
  if (bindings.ticket !== undefined) return `#${bindings.ticket}`;
  return "";
}

/**
 * Console sink for the Orchestrator's narration: pretty, colored, leveled,
 * timestamped, at a minimum level of `info` — lowered to `debug` by the
 * verbosity flag via `setMinLevel`, tslog's supported way to change a
 * logger's level after construction. Code-position and stack capture are
 * disabled — this is domain narration, not application debugging. Color (and
 * `NO_COLOR`/`FORCE_COLOR`) and TTY detection are handled by tslog itself.
 * Constructed only here: `core` and `app` never import the library, they
 * only see the `Log` function type.
 *
 * The three report kinds bypass tslog entirely: they print as the familiar
 * unadorned block straight to the process's stdout, byte-identical to before
 * structured logging existed — a report is read as a table, not narration,
 * and a level/timestamp prefix would be bolted onto it. `child` derives a
 * tslog sub-logger per dispatched Worker: its `name` tags every console line
 * so concurrent Workers stay tellable apart, and its `bindings` carry the
 * Ticket/Attempt (or PR) as real fields once a structured sink exists to
 * read them.
 */
function buildLog(cliProcess: StricliProcess): {
  log: Log;
  setVerbose: (verbose: boolean) => void;
} {
  const rootLogger = new Logger({
    minLevel: "INFO",
    stack: { capture: "off" },
  });
  function wrap(logger: typeof rootLogger): Log {
    const log = ((event: LogEvent): void => {
      const block = reportBlockText(event);
      if (block !== null) {
        cliProcess.stdout.write(`${block}\n`);
        return;
      }
      logger[event.level](event.msg);
    }) as Log;
    log.child = (bindings) =>
      wrap(
        logger.getSubLogger({
          name: tagFor(bindings),
          bindings: bindings as Record<string, unknown>,
        }),
      );
    return log;
  }
  return {
    log: wrap(rootLogger),
    setVerbose: (verbose) => rootLogger.setMinLevel(verbose ? "DEBUG" : "INFO"),
  };
}

/** The real context: today's collaborators, wired exactly as the entry point wired them before. */
export function buildRealContext(): Context {
  const cliProcess = nodeProcessAdapter();
  const { log, setVerbose } = buildLog(cliProcess);
  return {
    process: cliProcess,
    loadConfig: (flags) => resolveConfig(loadConfigFile(process.cwd()), flags),
    tick: (config, dryRun, dispatchPaused) =>
      tickOnce(config, dryRun, dispatchPaused, log),
    probe: (model) => probeEnvironment(model),
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log,
    setVerbose,
  };
}
