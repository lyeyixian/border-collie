import { isValidTimeZone, type WorkingHours } from "./work-hours.js";

/** File name looked up at the target repo's root. */
export const CONFIG_FILE = "border-collie.json";

const DEFAULT_MAX_WORKERS = 3;
const DEFAULT_MAX_OPEN_PRS = 5;
const DEFAULT_POLL_SECONDS = 30;
const DEFAULT_WORKER_MODEL = "sonnet";
const DEFAULT_RETRY_MODEL = "opus";
const DEFAULT_TIMEOUT_MINUTES = 45;
const DEFAULT_STALL_MINUTES = 10;
// Budget backstops are deliberately generous: they exist to stop runaway
// Workers, not to squeeze normal ones.
const DEFAULT_MAX_TURNS = 200;
const DEFAULT_MAX_COST_USD = 20;

export class ConfigError extends Error {}

/** Flags parsed from the command line; every field optional. */
export interface Flags {
  parent?: number;
  maxWorkers?: number;
  maxOpenPrs?: number;
  pollSeconds?: number;
  all?: boolean;
  model?: string;
  retryModel?: string;
  timeoutMinutes?: number;
}

export type Scope = { kind: "parent"; parent: number } | { kind: "all" };

export interface ResolvedConfig {
  scope: Scope;
  maxWorkers: number;
  /** Open agent PRs at or above this cap pause dispatch (review bandwidth). */
  maxOpenPrs: number;
  /** Seconds a run sleeps between Ticks. */
  pollSeconds: number;
  /** Model Workers run on (`claude --model`). */
  model: string;
  /** Stronger model a second attempt runs on (the retry ladder). */
  retryModel: string;
  /** Wall-clock ceiling per Worker. */
  timeoutMinutes: number;
  /** Max quiet time between Worker output events. */
  stallMinutes: number;
  /** Budget backstop: max agentic turns per Worker; breach is a ticket failure. */
  maxTurns: number;
  /** Budget alarm: spend in USD above which a finished Attempt is flagged, not failed. */
  maxCostUsd: number;
  /**
   * The working-hours gate (CONTEXT.md "Working hours"): confines dispatch
   * to an off-hours window. Absent means the gate never applies — dispatch
   * runs at every hour, today's default.
   */
  workingHours?: WorkingHours;
}

function asPositiveInt(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new ConfigError(
      `${name} must be a positive integer, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/** Costs are money, not counts: any positive finite number is fine. */
function asPositiveNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new ConfigError(
      `${name} must be a positive number, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function asNonEmptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || value === "") {
    throw new ConfigError(
      `${name} must be a non-empty string, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/** An hour of day: an integer in [0,24). */
function asHour(value: unknown, name: string): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > 23
  ) {
    throw new ConfigError(
      `${name} must be an integer from 0 to 23, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/**
 * The working-hours gate's window (CONTEXT.md "Working hours"): timezone,
 * work_start_hour, work_end_hour. All three or none — a partial window has
 * no sensible default. Undefined means the gate never applies.
 */
function resolveWorkingHours(
  file: Record<string, unknown>,
): WorkingHours | undefined {
  const { timezone, work_start_hour, work_end_hour } = file;
  if (
    timezone === undefined &&
    work_start_hour === undefined &&
    work_end_hour === undefined
  ) {
    return undefined;
  }
  const resolvedTimezone = asNonEmptyString(timezone, "timezone");
  if (!isValidTimeZone(resolvedTimezone)) {
    throw new ConfigError(
      `timezone must be a valid IANA time zone, got ${JSON.stringify(timezone)}`,
    );
  }
  const startHour = asHour(work_start_hour, "work_start_hour");
  const endHour = asHour(work_end_hour, "work_end_hour");
  if (startHour === endHour) {
    throw new ConfigError("work_start_hour and work_end_hour must differ");
  }
  return { timezone: resolvedTimezone, startHour, endHour };
}

/** The config fields a single Worker attempt needs — every field except `scope`, which only a Tick's dispatch (tick/run) ever consults. */
export type WorkerAttemptConfig = Omit<ResolvedConfig, "scope">;

function parseFileConfig(fileConfig: unknown): Record<string, unknown> {
  if (
    fileConfig !== undefined &&
    (typeof fileConfig !== "object" ||
      fileConfig === null ||
      Array.isArray(fileConfig))
  ) {
    throw new ConfigError(`${CONFIG_FILE} must contain a JSON object`);
  }
  return (fileConfig ?? {}) as Record<string, unknown>;
}

/** The scope-independent half of config resolution, shared by `resolveConfig` and `resolveWorkerConfig`. */
function resolveSharedConfig(
  file: Record<string, unknown>,
  flags: Flags,
): WorkerAttemptConfig {
  const maxWorkers = asPositiveInt(
    flags.maxWorkers ?? file.max_workers ?? DEFAULT_MAX_WORKERS,
    "max_workers",
  );
  const maxOpenPrs = asPositiveInt(
    flags.maxOpenPrs ?? file.max_open_prs ?? DEFAULT_MAX_OPEN_PRS,
    "max_open_prs",
  );
  const pollSeconds = asPositiveInt(
    flags.pollSeconds ?? file.poll_seconds ?? DEFAULT_POLL_SECONDS,
    "poll_seconds",
  );
  const model = asNonEmptyString(
    flags.model ?? file.worker_model ?? DEFAULT_WORKER_MODEL,
    "worker_model",
  );
  const retryModel = asNonEmptyString(
    flags.retryModel ?? file.retry_model ?? DEFAULT_RETRY_MODEL,
    "retry_model",
  );
  const timeoutMinutes = asPositiveInt(
    flags.timeoutMinutes ??
      file.worker_timeout_minutes ??
      DEFAULT_TIMEOUT_MINUTES,
    "worker_timeout_minutes",
  );
  const stallMinutes = asPositiveInt(
    file.worker_stall_minutes ?? DEFAULT_STALL_MINUTES,
    "worker_stall_minutes",
  );
  const maxTurns = asPositiveInt(
    file.worker_max_turns ?? DEFAULT_MAX_TURNS,
    "worker_max_turns",
  );
  const maxCostUsd = asPositiveNumber(
    file.worker_max_cost_usd ?? DEFAULT_MAX_COST_USD,
    "worker_max_cost_usd",
  );
  const workingHours = resolveWorkingHours(file);
  const shared: WorkerAttemptConfig = {
    maxWorkers,
    maxOpenPrs,
    pollSeconds,
    model,
    retryModel,
    timeoutMinutes,
    stallMinutes,
    maxTurns,
    maxCostUsd,
  };
  if (workingHours !== undefined) shared.workingHours = workingHours;
  return shared;
}

/**
 * Merge the target repo's config file with CLI flags. Flags win. Repo-wide
 * scope is never implicit: only the explicit `all` flag selects it, and it
 * refuses to combine with a `parent` flag.
 */
export function resolveConfig(
  fileConfig: unknown,
  flags: Flags,
): ResolvedConfig {
  const file = parseFileConfig(fileConfig);
  const shared = resolveSharedConfig(file, flags);

  if (flags.all) {
    if (flags.parent !== undefined) {
      throw new ConfigError("--all and --parent are mutually exclusive");
    }
    return { scope: { kind: "all" }, ...shared };
  }

  const parent = flags.parent ?? file.parent;
  if (parent === undefined) {
    throw new ConfigError(
      `no scope: set "parent" in ${CONFIG_FILE} or pass --parent <n> (repo-wide scope requires the explicit --all flag)`,
    );
  }
  return {
    scope: { kind: "parent", parent: asPositiveInt(parent, "parent") },
    ...shared,
  };
}

/**
 * Config resolution for a single Worker attempt (issue #71): the same fields
 * `resolveConfig` produces, minus Scope — a Worker is told exactly which
 * Ticket and Attempt to run, so `resolveConfig`'s scope requirement (a
 * `parent` in the config file or an explicit `--all`/`--parent` flag) does
 * not apply, and does not need to be satisfied for the command to run.
 */
export function resolveWorkerConfig(
  fileConfig: unknown,
  flags: Flags,
): WorkerAttemptConfig {
  return resolveSharedConfig(parseFileConfig(fileConfig), flags);
}

/** The retry ladder's model binding: attempt two runs the stronger retry model. */
export function modelForAttempt(
  config: WorkerAttemptConfig,
  attempt: number,
): string {
  return attempt >= 2 ? config.retryModel : config.model;
}
