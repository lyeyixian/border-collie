import { join } from "node:path";
import { APP_ID_ENV, APP_PRIVATE_KEY_ENV } from "./app-auth.js";
import { DEFAULT_TRANSCRIPT_RETENTION_DAYS } from "./container.js";
import { isValidTimeZone, type WorkingHours } from "./work-hours.js";

/**
 * File name looked up at the path `DaemonConfig.fleetConfigPath` resolves
 * (default `<state-dir>/fleet.json`, issue #184) — one file on the daemon's
 * own host, never the target repository's, which is exactly what retires
 * `border-collie.json`: loop policy stops living somewhere a repository can
 * edit it.
 */
export const FLEET_CONFIG_FILE = "fleet.json";

/** Env var name the operator sets a Claude subscription OAuth token in — handed to a session container as `CLAUDE_CODE_OAUTH_TOKEN` (issue #183). */
export const CLAUDE_CODE_OAUTH_TOKEN_ENV = "CLAUDE_CODE_OAUTH_TOKEN";

/** Env var name naming the border-collie session image a Worker Attempt's container runs (issue #177; repository-specific images are issue #180). */
export const WORKER_IMAGE_ENV = "BORDER_COLLIE_WORKER_IMAGE";

/** The daemon's own local checkout directory, under the operator-supplied home directory (issue #183). */
export const DEFAULT_STATE_DIR_NAME = ".border-collie";

/** Env var name for the transcript retention sweep's window, in days (issue #196). */
export const TRANSCRIPT_RETENTION_DAYS_ENV =
  "BORDER_COLLIE_TRANSCRIPT_RETENTION_DAYS";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

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

/**
 * The scope-independent half of config resolution, shared by `resolveConfig`
 * and `resolveWorkerConfig` — CLI flags over this package's own built-in
 * defaults. `border-collie.json` used to sit between the two (issue #184);
 * it is gone, and with it the per-repository file these two commands ever
 * read. The daemon's per-repository policy is a separate concern entirely,
 * resolved by `resolveFleetPolicy` below from its own fleet policy file.
 */
function resolveSharedConfig(flags: Flags): WorkerAttemptConfig {
  const maxWorkers = asPositiveInt(
    flags.maxWorkers ?? DEFAULT_MAX_WORKERS,
    "max_workers",
  );
  const maxOpenPrs = asPositiveInt(
    flags.maxOpenPrs ?? DEFAULT_MAX_OPEN_PRS,
    "max_open_prs",
  );
  const pollSeconds = asPositiveInt(
    flags.pollSeconds ?? DEFAULT_POLL_SECONDS,
    "poll_seconds",
  );
  const model = asNonEmptyString(
    flags.model ?? DEFAULT_WORKER_MODEL,
    "worker_model",
  );
  const retryModel = asNonEmptyString(
    flags.retryModel ?? DEFAULT_RETRY_MODEL,
    "retry_model",
  );
  const timeoutMinutes = asPositiveInt(
    flags.timeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES,
    "worker_timeout_minutes",
  );
  const stallMinutes = asPositiveInt(
    DEFAULT_STALL_MINUTES,
    "worker_stall_minutes",
  );
  const maxTurns = asPositiveInt(DEFAULT_MAX_TURNS, "worker_max_turns");
  const maxCostUsd = asPositiveNumber(
    DEFAULT_MAX_COST_USD,
    "worker_max_cost_usd",
  );
  return {
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
}

/**
 * The Scope flags settle Scope on their own, with no tracker read (CONTEXT.md
 * "Scope"): `--all` is the only way to select repo-wide Scope, and it refuses
 * to combine with `--parent`, which overrides whatever the tracker's Scope
 * label says. Undefined means neither flag settled it — the caller falls
 * back to the tracker's Scope label (`SCOPE_LABEL`, adapters/tracker.ts's
 * `readScopeFromLabel`), which needs a network read this pure function
 * cannot make itself.
 */
export function scopeFromFlags(flags: Flags): Scope | undefined {
  if (flags.all) {
    if (flags.parent !== undefined) {
      throw new ConfigError("--all and --parent are mutually exclusive");
    }
    return { kind: "all" };
  }
  if (flags.parent !== undefined) {
    return { kind: "parent", parent: asPositiveInt(flags.parent, "parent") };
  }
  return undefined;
}

/**
 * Merge CLI flags over this package's built-in defaults, and attach an
 * already-decided Scope. Scope itself is never read from a file (CONTEXT.md
 * "Scope": the tracker is the only state store for it) — the caller resolves
 * it first, via `scopeFromFlags` and, when that is undefined, a tracker
 * read, keeping this function itself pure and synchronous.
 */
export function resolveConfig(flags: Flags, scope: Scope): ResolvedConfig {
  return { scope, ...resolveSharedConfig(flags) };
}

/**
 * Config resolution for a single Worker attempt (issue #71): the same fields
 * `resolveConfig` produces, minus Scope — a Worker is told exactly which
 * Ticket and Attempt to run, so no Scope is ever resolved for it, and no
 * tracker read for a Scope label is ever needed to run this command.
 */
export function resolveWorkerConfig(flags: Flags): WorkerAttemptConfig {
  return resolveSharedConfig(flags);
}

/** The retry ladder's model binding: attempt two runs the stronger retry model. */
export function modelForAttempt(
  config: WorkerAttemptConfig,
  attempt: number,
): string {
  return attempt >= 2 ? config.retryModel : config.model;
}

/**
 * The fields the daemon's fleet policy file controls for one repository's
 * Tick (issue #184; ADR 0009 "Fleet policy") — every `WorkerAttemptConfig`
 * field except `pollSeconds`, which is the daemon's own single poll interval
 * (`DaemonConfig.pollSeconds`, issue #183) and is never per-repository: the
 * daemon walks the whole fleet on one interval, not one interval per
 * repository.
 */
export type FleetPolicy = Omit<WorkerAttemptConfig, "pollSeconds">;

/** One policy object's fields as the fleet file's `defaults` or a single repository's override may state them — everything optional, since either may state only what it wants to state and fall back for the rest. */
export type ParsedFleetPolicy = Partial<FleetPolicy>;

const FLEET_POLICY_KEYS = new Set([
  "max_workers",
  "max_open_prs",
  "worker_model",
  "retry_model",
  "worker_timeout_minutes",
  "worker_stall_minutes",
  "worker_max_turns",
  "worker_max_cost_usd",
  "timezone",
  "work_start_hour",
  "work_end_hour",
]);

/** Parses one policy object (the fleet file's `defaults`, or one entry under `repositories`) — an unknown key is a named error rather than silently ignored (issue #184). */
function parsePolicyObject(raw: unknown, context: string): ParsedFleetPolicy {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ConfigError(
      `${FLEET_CONFIG_FILE}: ${context} must be a JSON object`,
    );
  }
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!FLEET_POLICY_KEYS.has(key)) {
      throw new ConfigError(
        `${FLEET_CONFIG_FILE}: ${context} has an unknown key ${JSON.stringify(key)}`,
      );
    }
  }
  const policy: ParsedFleetPolicy = {};
  if (obj.max_workers !== undefined) {
    policy.maxWorkers = asPositiveInt(
      obj.max_workers,
      `${context}.max_workers`,
    );
  }
  if (obj.max_open_prs !== undefined) {
    policy.maxOpenPrs = asPositiveInt(
      obj.max_open_prs,
      `${context}.max_open_prs`,
    );
  }
  if (obj.worker_model !== undefined) {
    policy.model = asNonEmptyString(
      obj.worker_model,
      `${context}.worker_model`,
    );
  }
  if (obj.retry_model !== undefined) {
    policy.retryModel = asNonEmptyString(
      obj.retry_model,
      `${context}.retry_model`,
    );
  }
  if (obj.worker_timeout_minutes !== undefined) {
    policy.timeoutMinutes = asPositiveInt(
      obj.worker_timeout_minutes,
      `${context}.worker_timeout_minutes`,
    );
  }
  if (obj.worker_stall_minutes !== undefined) {
    policy.stallMinutes = asPositiveInt(
      obj.worker_stall_minutes,
      `${context}.worker_stall_minutes`,
    );
  }
  if (obj.worker_max_turns !== undefined) {
    policy.maxTurns = asPositiveInt(
      obj.worker_max_turns,
      `${context}.worker_max_turns`,
    );
  }
  if (obj.worker_max_cost_usd !== undefined) {
    policy.maxCostUsd = asPositiveNumber(
      obj.worker_max_cost_usd,
      `${context}.worker_max_cost_usd`,
    );
  }
  const workingHours = resolveWorkingHours(obj);
  if (workingHours !== undefined) policy.workingHours = workingHours;
  return policy;
}

/** The fleet policy file, already parsed: fleet-wide defaults plus per-repository overrides, keyed by full name (`"owner/name"`, the same identifier `listFleet` returns and every daemon repository log line already carries). */
export interface FleetConfig {
  defaults: ParsedFleetPolicy;
  repositories: Record<string, ParsedFleetPolicy>;
}

const FLEET_CONFIG_KEYS = new Set(["defaults", "repositories"]);

/**
 * Parses the daemon's fleet policy file (issue #184) into `defaults` plus
 * per-repository `repositories` overrides. A missing file is `undefined`
 * here (`adapters/fleet-config-file.ts`'s `loadFleetConfigFile`) and is
 * valid: it yields no defaults and no overrides, so `resolveFleetPolicy`
 * falls all the way back to this package's own built-in defaults.
 */
export function parseFleetConfig(raw: unknown): FleetConfig {
  if (raw === undefined) return { defaults: {}, repositories: {} };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ConfigError(`${FLEET_CONFIG_FILE} must contain a JSON object`);
  }
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!FLEET_CONFIG_KEYS.has(key)) {
      throw new ConfigError(
        `${FLEET_CONFIG_FILE} has an unknown key ${JSON.stringify(key)}`,
      );
    }
  }
  const defaults = parsePolicyObject(obj.defaults ?? {}, "defaults");
  const rawRepositories = obj.repositories ?? {};
  if (
    typeof rawRepositories !== "object" ||
    rawRepositories === null ||
    Array.isArray(rawRepositories)
  ) {
    throw new ConfigError(
      `${FLEET_CONFIG_FILE}: repositories must be a JSON object`,
    );
  }
  const repositories: Record<string, ParsedFleetPolicy> = {};
  for (const [repository, value] of Object.entries(
    rawRepositories as Record<string, unknown>,
  )) {
    repositories[repository] = parsePolicyObject(
      value,
      `repositories["${repository}"]`,
    );
  }
  return { defaults, repositories };
}

/**
 * The pure defaults-then-override merge issue #184 calls for: a
 * per-repository override wins field by field over the fleet-wide defaults,
 * and any field neither states falls back to this package's own built-in
 * default. Takes an already-parsed `FleetConfig` (`parseFleetConfig`) and
 * does no I/O of its own, so it is testable as plain inputs and outputs.
 */
export function resolveFleetPolicy(
  fleetConfig: FleetConfig,
  repository: string,
): FleetPolicy {
  const merged: ParsedFleetPolicy = {
    ...fleetConfig.defaults,
    ...fleetConfig.repositories[repository],
  };
  const policy: FleetPolicy = {
    maxWorkers: merged.maxWorkers ?? DEFAULT_MAX_WORKERS,
    maxOpenPrs: merged.maxOpenPrs ?? DEFAULT_MAX_OPEN_PRS,
    model: merged.model ?? DEFAULT_WORKER_MODEL,
    retryModel: merged.retryModel ?? DEFAULT_RETRY_MODEL,
    timeoutMinutes: merged.timeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES,
    stallMinutes: merged.stallMinutes ?? DEFAULT_STALL_MINUTES,
    maxTurns: merged.maxTurns ?? DEFAULT_MAX_TURNS,
    maxCostUsd: merged.maxCostUsd ?? DEFAULT_MAX_COST_USD,
  };
  if (merged.workingHours !== undefined) {
    policy.workingHours = merged.workingHours;
  }
  return policy;
}

const DEFAULT_PROBE_MODEL = "sonnet";

/** Flags parsed from the command line for `daemon`; every field optional. */
export interface DaemonFlags {
  pollSeconds?: number;
  image?: string;
  stateDir?: string;
  /** Model the circuit breaker's recovery probe runs on — shared across every repository (an infrastructure failure is account-wide, not per-repository). */
  probeModel?: string;
  /** Transcript retention sweep's window, in days (issue #196; default `DEFAULT_TRANSCRIPT_RETENTION_DAYS`). */
  transcriptRetentionDays?: number;
  /** Path to the fleet policy file (issue #184); default `<state-dir>/fleet.json`. */
  fleetConfig?: string;
}

/**
 * The daemon's own config (issue #183) — deliberately not the target repos'
 * `border-collie.json`, which is retired: `fleetConfigPath` below is its
 * replacement, one file on the daemon's own host rather than one per
 * repository (ADR 0009, issue #184).
 */
export interface DaemonConfig {
  /** Seconds between polls, and the round-robin interval a repository must idle before it is due again. */
  pollSeconds: number;
  /** The border-collie session image a Worker Attempt's container runs. */
  image: string;
  /** The daemon's own local checkout directory (`adapters/checkout.ts`). */
  stateDir: string;
  /** The GitHub App's own id (the JWT's `iss` claim). */
  appId: string;
  /** The GitHub App's private key (PEM) — never forwarded to a Worker's environment (`stripAppPrivateKey`, core/app-auth.ts). */
  appPrivateKey: string;
  /** A Claude subscription OAuth token, handed to every session container as `CLAUDE_CODE_OAUTH_TOKEN`. */
  claudeCodeOAuthToken: string;
  /** Model the circuit breaker's recovery probe runs on, shared across every repository. */
  probeModel: string;
  /**
   * The transcript retention sweep's window (issue #196), run once per
   * repository after that repository's own Tick — see `pruneTranscripts`
   * (adapters/container.ts) and `transcriptsToPrune` (core/container.ts).
   */
  transcriptRetentionMs: number;
  /** Path to the fleet policy file (issue #184) — fleet-wide defaults plus per-repository overrides, read fresh each Tick (`adapters/fleet-config-file.ts`) so an operator's edit takes effect without a daemon restart. */
  fleetConfigPath: string;
}

/**
 * Resolves the daemon's own config from CLI flags, environment variables,
 * and the operator's home directory (for `stateDir`'s and `fleetConfigPath`'s
 * defaults) — pure over those three inputs, so the CLI layer's own
 * `os.homedir()` read is the only I/O involved (ADR 0005: the pure/impure
 * boundary sits at the read, not inside this function).
 */
export function resolveDaemonConfig(
  flags: DaemonFlags,
  env: NodeJS.ProcessEnv,
  homeDir: string,
): DaemonConfig {
  const pollSeconds = asPositiveInt(
    flags.pollSeconds ?? DEFAULT_POLL_SECONDS,
    "poll_seconds",
  );
  const image = asNonEmptyString(
    flags.image ?? env[WORKER_IMAGE_ENV],
    `worker image (--image or ${WORKER_IMAGE_ENV})`,
  );
  const stateDir = asNonEmptyString(
    flags.stateDir ?? join(homeDir, DEFAULT_STATE_DIR_NAME),
    "state dir (--state-dir)",
  );
  const appId = asNonEmptyString(env[APP_ID_ENV], APP_ID_ENV);
  const appPrivateKey = asNonEmptyString(
    env[APP_PRIVATE_KEY_ENV],
    APP_PRIVATE_KEY_ENV,
  );
  const claudeCodeOAuthToken = asNonEmptyString(
    env[CLAUDE_CODE_OAUTH_TOKEN_ENV],
    CLAUDE_CODE_OAUTH_TOKEN_ENV,
  );
  const probeModel = asNonEmptyString(
    flags.probeModel ?? DEFAULT_PROBE_MODEL,
    "probe_model",
  );
  const rawTranscriptRetentionDaysEnv = env[TRANSCRIPT_RETENTION_DAYS_ENV];
  const transcriptRetentionDays = asPositiveInt(
    flags.transcriptRetentionDays ??
      (rawTranscriptRetentionDaysEnv === undefined
        ? DEFAULT_TRANSCRIPT_RETENTION_DAYS
        : /^\d+$/.test(rawTranscriptRetentionDaysEnv)
          ? Number(rawTranscriptRetentionDaysEnv)
          : rawTranscriptRetentionDaysEnv),
    `transcript retention days (--transcript-retention-days or ${TRANSCRIPT_RETENTION_DAYS_ENV})`,
  );
  const transcriptRetentionMs = transcriptRetentionDays * MS_PER_DAY;
  const fleetConfigPath = asNonEmptyString(
    flags.fleetConfig ?? join(stateDir, FLEET_CONFIG_FILE),
    "fleet config path (--fleet-config)",
  );
  return {
    pollSeconds,
    image,
    stateDir,
    appId,
    appPrivateKey,
    claudeCodeOAuthToken,
    probeModel,
    transcriptRetentionMs,
    fleetConfigPath,
  };
}
