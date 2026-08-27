import { homedir } from "node:os";
import { join } from "node:path";
import type { CommandContext, StricliProcess } from "@stricli/core";
import { Logger } from "tslog";
import { fileTransport } from "tslog/transports/file";
import {
  listFleetRepositories,
  mintRepositoryToken,
  parseRepositoryFullName,
  repositoryFullName,
} from "../adapters/app-auth.js";
import { ensureCheckout, execAtRepo } from "../adapters/checkout.js";
import { loadConfigFile } from "../adapters/config-file.js";
import {
  pruneTranscripts,
  realListTranscripts,
  realRemoveTranscript,
} from "../adapters/container.js";
import {
  readScopeFromLabel,
  realExec,
  withDebugLogging,
} from "../adapters/tracker.js";
import type { ConflictOutcome, RefinementOutcome } from "../adapters/worker.js";
import { probeEnvironment } from "../adapters/worker.js";
import type { IntervalScheduler } from "../app/act.js";
import { conflictWorkerOnce } from "../app/conflict-worker.js";
import { type DaemonDeps, daemon as runDaemon } from "../app/daemon.js";
import { declareOnce } from "../app/declare.js";
import { initLabelsOnce, initScaffoldOnce } from "../app/init.js";
import { refinementWorkerOnce } from "../app/refinement-worker.js";
import { type TickResult, tickOnce } from "../app/tick.js";
import { workerAttemptOnce } from "../app/worker.js";
import {
  type DaemonConfig,
  type DaemonFlags,
  type Flags,
  type ResolvedConfig,
  resolveConfig,
  resolveDaemonConfig,
  resolveWorkerConfig,
  scopeFromFlags,
  type WorkerAttemptConfig,
} from "../core/config.js";
import type { DeclareOutcome } from "../core/declare.js";
import {
  type Log,
  type LogBindings,
  type LogEvent,
  scrubCredentials,
} from "../core/log.js";
import type { LabelAction, ScaffoldAction } from "../core/scaffold.js";
import { RUN_DIR, type WorkerOutcome } from "../core/types.js";
import { reportBlockText } from "./console-report.js";

/** Every effect a command handler needs, injected so handlers never import them directly. */
export interface Context extends CommandContext {
  readonly process: StricliProcess;
  /**
   * Resolves Scope (CONTEXT.md "Scope") before the rest of config: flags
   * settle it on their own when they can (`scopeFromFlags`), falling back to
   * a tracker read for the Scope label when neither `--parent` nor `--all`
   * did — the one config field that needs a network read, so `loadConfig`
   * alone among this interface's config resolvers is async.
   */
  readonly loadConfig: (flags: Flags) => Promise<ResolvedConfig>;
  /** Config resolution for the worker command: no Scope required (issue #71); see `resolveWorkerConfig`. */
  readonly loadWorkerConfig: (flags: Flags) => WorkerAttemptConfig;
  /**
   * Config resolution for `daemon` (issue #183): CLI flags plus environment
   * variables and the operator's home directory, none of which need a
   * network read — synchronous like `loadWorkerConfig`, unlike `loadConfig`.
   */
  readonly loadDaemonConfig: (flags: DaemonFlags) => DaemonConfig;
  readonly tick: (
    config: ResolvedConfig,
    dryRun: boolean,
    dispatchPaused?: boolean,
  ) => Promise<TickResult>;
  /**
   * A Worker settling its own Attempt (issue #71); see src/app/worker.ts.
   * `inPlace` (issue #75) skips worktree isolation and the git lock for a
   * Worker job that owns its own checkout.
   */
  readonly runWorker: (
    config: WorkerAttemptConfig,
    ticket: number,
    attempt: number,
    inPlace: boolean,
  ) => Promise<WorkerOutcome>;
  /**
   * A Conflict Worker settling its own outcome (issue #181); see
   * src/app/conflict-worker.ts. `inPlace` skips worktree isolation and the
   * git lock for a session container that owns its own checkout, the same
   * meaning it carries for `runWorker`.
   */
  readonly runConflictWorker: (
    config: WorkerAttemptConfig,
    pr: number,
    ticket: number,
    headRef: string,
    inPlace: boolean,
  ) => Promise<ConflictOutcome>;
  /**
   * A Refinement round settling its own outcome (issue #181); see
   * src/app/refinement-worker.ts.
   */
  readonly runRefinement: (
    config: WorkerAttemptConfig,
    pr: number,
    ticket: number,
    headRef: string,
    round: number,
    inPlace: boolean,
  ) => Promise<RefinementOutcome>;
  readonly probe: (model: string) => Promise<boolean>;
  /**
   * `declare` (issue #150): run an Onboarding Worker directly against the
   * current working directory and read back what it produced — no Attempt,
   * no tracker write. `init` calls this as its own final step.
   */
  readonly declare: (config: WorkerAttemptConfig) => Promise<DeclareOutcome>;
  /** `init` (issue #76): scaffold the workflows into the target repo at cwd. */
  readonly initScaffold: (force: boolean) => ScaffoldAction[];
  /**
   * `init` (issue #100): create the tracker labels the loop writes. A second
   * seam rather than a return field on `initScaffold`, so the file scaffold
   * stays the synchronous, offline step it has always been and the one step
   * that needs a network stays separately fakeable.
   */
  readonly initLabels: () => Promise<LabelAction[]>;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  /** The fleet heartbeat's scheduler; see src/app/act.ts. */
  readonly scheduleInterval: IntervalScheduler;
  /**
   * `daemon` (issue #183): walks the fleet on an interval and runs one Tick
   * per repository, each with its own repository-scoped token and Worker
   * Attempts dispatched into their own session containers. Never returns —
   * the process exits only when its own runner (a service manager, or a
   * signal handler wired outside this context) stops it.
   */
  readonly daemon: (config: DaemonConfig) => Promise<never>;
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

/** The console tag for a Worker's (or Conflict Worker's, or a daemon repository's) sub-logger — what distinguishes its interleaved lines. */
function tagFor(bindings: LogBindings): string {
  const suffix =
    bindings.pr !== undefined
      ? ` PR #${bindings.pr}`
      : bindings.ticket !== undefined
        ? ` #${bindings.ticket}`
        : "";
  if (bindings.repository !== undefined)
    return `${bindings.repository}${suffix}`;
  return suffix.trim();
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
 * record — console or file — carries it. The identifier is injectable via
 * `BORDER_COLLIE_RUN_ID` (falling back to a timestamp when unset) so a
 * Worker job (issue #75) can set it from the job's own run identifier,
 * making the uploaded log artifact's file name correlate directly with the
 * job an operator can click into.
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
  env: NodeJS.ProcessEnv,
): {
  log: Log;
  setVerbose: (verbose: boolean) => void;
} {
  const runId =
    env.BORDER_COLLIE_RUN_ID ?? new Date().toISOString().replace(/[:.]/g, "-");
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

/**
 * Wires the daemon's own effects (issue #183) onto the real adapters: the
 * fleet read and token mint go through the GitHub App (`adapters/
 * app-auth.ts`), and each due repository's own Tick runs through the same
 * `tickOnce` every other command shares, given that repository's own
 * checkout (`adapters/checkout.ts`) and a session-container dispatch
 * (`TickDeps.container`) instead of the local or Actions-job dispatch the
 * `tick`/`run` commands use.
 */
function buildDaemonDeps(
  config: DaemonConfig,
  log: Log,
  now: () => number,
  scheduleInterval: IntervalScheduler,
): DaemonDeps {
  const credentials = { appId: config.appId, privateKey: config.appPrivateKey };
  const transcriptsRoot = join(config.stateDir, "transcripts");
  return {
    listFleet: async () => {
      const repositories = await listFleetRepositories(credentials, now());
      return repositories.map(repositoryFullName);
    },
    mintToken: async (repository) => {
      const { token } = await mintRepositoryToken(
        credentials,
        parseRepositoryFullName(repository),
        now(),
      );
      return token;
    },
    tick: async (repository, token, dispatchPaused) => {
      const dir = await ensureCheckout(config.stateDir, repository, token);
      const repoLog = log.child({ repository });
      // Bound to this repository's own checkout and token, never the
      // daemon process's own `process.cwd()` — see `execAtRepo`'s own doc
      // for why a daemon ticking several repositories concurrently needs
      // this instead of the every-other-caller default.
      const exec = execAtRepo(dir, token);
      const scope = await readScopeFromLabel(withDebugLogging(exec, repoLog));
      const repoConfig = resolveConfig(loadConfigFile(dir), {}, scope);
      return tickOnce(repoConfig, false, dispatchPaused, {
        log: repoLog,
        now,
        scheduleInterval,
        cwd: dir,
        exec,
        container: {
          repository,
          image: config.image,
          ghToken: token,
          claudeCodeOAuthToken: config.claudeCodeOAuthToken,
          transcriptsRoot,
        },
      });
    },
    pruneTranscripts: (repository) => {
      const repoLog = log.child({ repository });
      return pruneTranscripts(
        repository,
        transcriptsRoot,
        config.transcriptRetentionMs,
        withDebugLogging(realExec, repoLog),
        realListTranscripts,
        realRemoveTranscript,
        now(),
      );
    },
    probe: () => probeEnvironment(config.probeModel),
    now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log,
    pollSeconds: config.pollSeconds,
  };
}

/** The real context: today's collaborators, wired exactly as the entry point wired them before. */
export function buildRealContext(
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): Context {
  const cliProcess = nodeProcessAdapter();
  const { log, setVerbose } = buildLog(cliProcess, cwd, env);
  const now = () => Date.now();
  const scheduleInterval: IntervalScheduler = (ms, callback) => {
    const id = setInterval(callback, ms);
    return () => clearInterval(id);
  };
  return {
    process: cliProcess,
    loadConfig: async (flags) => {
      const scope =
        scopeFromFlags(flags) ??
        (await readScopeFromLabel(withDebugLogging(realExec, log)));
      return resolveConfig(loadConfigFile(cwd), flags, scope);
    },
    loadWorkerConfig: (flags) =>
      resolveWorkerConfig(loadConfigFile(cwd), flags),
    loadDaemonConfig: (flags) => resolveDaemonConfig(flags, env, homedir()),
    tick: (config, dryRun, dispatchPaused) =>
      tickOnce(config, dryRun, dispatchPaused, {
        log,
        now,
        scheduleInterval,
        // GitHub sets this on every Actions runner; see TickDeps.remoteDispatch.
        remoteDispatch: cliProcess.env?.GITHUB_ACTIONS === "true",
        cwd,
      }),
    runWorker: (config, ticket, attempt, inPlace) =>
      workerAttemptOnce(config, ticket, attempt, inPlace, { log }),
    runConflictWorker: (config, pr, ticket, headRef, inPlace) =>
      conflictWorkerOnce(config, pr, ticket, headRef, inPlace, { log }),
    runRefinement: (config, pr, ticket, headRef, round, inPlace) =>
      refinementWorkerOnce(config, pr, ticket, headRef, round, inPlace, {
        log,
      }),
    probe: (model) => probeEnvironment(model),
    declare: (config) => declareOnce(config, { log }),
    initScaffold: (force) => initScaffoldOnce(cwd, force),
    initLabels: () => initLabelsOnce(),
    daemon: (config) =>
      runDaemon(buildDaemonDeps(config, log, now, scheduleInterval)),
    now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    scheduleInterval,
    log,
    setVerbose,
  };
}
