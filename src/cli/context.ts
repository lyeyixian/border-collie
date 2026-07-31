import { join } from "node:path";
import type { CommandContext, StricliProcess } from "@stricli/core";
import { Logger } from "tslog";
import { fileTransport } from "tslog/transports/file";
import { loadConfigFile } from "../adapters/config-file.js";
import { probeEnvironment, RUN_DIR } from "../adapters/worker.js";
import type { IntervalScheduler } from "../app/act.js";
import { type TickResult, tickOnce } from "../app/tick.js";
import {
  type Flags,
  type ResolvedConfig,
  resolveConfig,
} from "../core/config.js";
import {
  type Log,
  type LogBindings,
  type LogEvent,
  scrubCredentials,
} from "../core/log.js";
import { reportBlockText } from "./console-report.js";

/** Every effect a command handler needs, injected so handlers never import them directly. */
export interface Context extends CommandContext {
  readonly process: StricliProcess;
  readonly loadConfig: (flags: Flags) => ResolvedConfig;
  readonly tick: (
    config: ResolvedConfig,
    dryRun: boolean,
    dispatchPaused?: boolean,
  ) => Promise<TickResult>;
  readonly probe: (model: string) => Promise<boolean>;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  /** The fleet heartbeat's scheduler; see src/app/act.ts. */
  readonly scheduleInterval: IntervalScheduler;
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
 * Two sinks over one logger, since a durable record needs more detail than a
 * human wants scrolling past live: `type: "hidden"` suppresses tslog's own
 * console output (which has no per-sink level of its own) so each sink below
 * can set its own threshold.
 *
 * - **Console**: pretty, colored, leveled, timestamped, minimum level `info`
 *   — lowered to `debug` by the verbosity flag. tslog's `setMinLevel` isn't
 *   enough here: it moves the shared floor both sinks read from before their
 *   own per-transport `minLevel` applies, so lowering it would also let
 *   below-`info` records reach the file gate unnecessarily. Instead the
 *   console transport reads its `minLevel` from a closed-over variable the
 *   flag mutates directly, leaving the file's threshold untouched.
 *   Code-position and stack capture are disabled — this is domain narration,
 *   not application debugging. Color (and `NO_COLOR`/`FORCE_COLOR`) and TTY
 *   detection are handled by tslog itself.
 * - **File**: the run's durable record, one newline-delimited JSON file per
 *   process invocation under `<cwd>/<RUN_DIR>/logs`, named by start time.
 *   Minimum level `debug`, unconditionally — this detail cannot be recovered
 *   by re-running later. The parent directory is created on first write;
 *   append mode; a sink failure (permissions, full disk) is contained and
 *   reported rather than fatal; the buffered tail is flushed on normal exit
 *   and on crash. Records use tslog's native shape, not its pino-compatible
 *   preset. Every formatted line is scrubbed for credential-shaped content
 *   (`scrubCredentials`) before it reaches disk — the console isn't, since
 *   GitHub Actions already masks registered secrets in the workflow log,
 *   but nothing masks a file this process writes itself, and this file is
 *   the artifact a Worker job uploads.
 *
 * The root logger binds a run identifier matching the file's name, so every
 * record — console or file — carries it.
 *
 * The three report kinds bypass both sinks entirely: they print as the
 * familiar unadorned block straight to the process's stdout, byte-identical
 * to before structured logging existed — a report is read as a table, not
 * narration, and a level/timestamp prefix would be bolted onto it. `child`
 * derives a tslog sub-logger per dispatched Worker: its `name` tags every
 * console line so concurrent Workers stay tellable apart, and its
 * `bindings` carry the Ticket/Attempt (or PR) as real fields captured by
 * the file sink, alongside the run id every sub-logger inherits.
 *
 * Constructed only here: `core` and `app` never import tslog, they only see
 * the `Log` function type.
 */
function buildLog(
  cliProcess: StricliProcess,
  cwd: string,
): {
  log: Log;
  setVerbose: (verbose: boolean) => void;
} {
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const rootLogger = new Logger({
    type: "hidden",
    stack: { capture: "off" },
    bindings: { runId },
  });
  let consoleMinLevel: "INFO" | "DEBUG" = "INFO";
  rootLogger.attachTransport({
    name: "console",
    format: "pretty",
    get minLevel() {
      return consoleMinLevel;
    },
    write: (_record, line) => {
      cliProcess.stdout.write(`${line}\n`);
    },
  });
  const fileSink = fileTransport({
    path: join(cwd, RUN_DIR, "logs", `${runId}.jsonl`),
    format: "json",
    minLevel: "DEBUG",
  });
  rootLogger.attachTransport({
    ...fileSink,
    write: (record, line) => fileSink.write(record, scrubCredentials(line)),
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
    setVerbose: (verbose) => {
      consoleMinLevel = verbose ? "DEBUG" : "INFO";
    },
  };
}

/** The real context: today's collaborators, wired exactly as the entry point wired them before. */
export function buildRealContext(cwd: string = process.cwd()): Context {
  const cliProcess = nodeProcessAdapter();
  const { log, setVerbose } = buildLog(cliProcess, cwd);
  const now = () => Date.now();
  const scheduleInterval: IntervalScheduler = (ms, callback) => {
    const id = setInterval(callback, ms);
    return () => clearInterval(id);
  };
  return {
    process: cliProcess,
    loadConfig: (flags) => resolveConfig(loadConfigFile(cwd), flags),
    tick: (config, dryRun, dispatchPaused) =>
      tickOnce(config, dryRun, dispatchPaused, { log, now, scheduleInterval }),
    probe: (model) => probeEnvironment(model),
    now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    scheduleInterval,
    log,
    setVerbose,
  };
}
