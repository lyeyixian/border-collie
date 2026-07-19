import { readFileSync } from "node:fs";
import { join } from "node:path";

/** File name looked up at the target repo's root. */
export const CONFIG_FILE = "border-collie.json";

const DEFAULT_MAX_WORKERS = 3;

export class ConfigError extends Error {}

/** Flags parsed from the command line; every field optional. */
export interface Flags {
  parent?: number;
  maxWorkers?: number;
  all?: boolean;
}

export type Scope = { kind: "parent"; parent: number } | { kind: "all" };

export interface ResolvedConfig {
  scope: Scope;
  maxWorkers: number;
}

function asPositiveInt(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new ConfigError(`${name} must be a positive integer, got ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * Merge the target repo's config file with CLI flags. Flags win. Repo-wide
 * scope is never implicit: only the explicit `all` flag selects it, and it
 * refuses to combine with a `parent` flag.
 */
export function resolveConfig(fileConfig: unknown, flags: Flags): ResolvedConfig {
  if (fileConfig !== undefined && (typeof fileConfig !== "object" || fileConfig === null || Array.isArray(fileConfig))) {
    throw new ConfigError(`${CONFIG_FILE} must contain a JSON object`);
  }
  const file = (fileConfig ?? {}) as Record<string, unknown>;

  const maxWorkers = asPositiveInt(
    flags.maxWorkers ?? file["max_workers"] ?? DEFAULT_MAX_WORKERS,
    "max_workers",
  );

  if (flags.all) {
    if (flags.parent !== undefined) {
      throw new ConfigError("--all and --parent are mutually exclusive");
    }
    return { scope: { kind: "all" }, maxWorkers };
  }

  const parent = flags.parent ?? file["parent"];
  if (parent === undefined) {
    throw new ConfigError(
      `no scope: set "parent" in ${CONFIG_FILE} or pass --parent <n> (repo-wide scope requires the explicit --all flag)`,
    );
  }
  return { scope: { kind: "parent", parent: asPositiveInt(parent, "parent") }, maxWorkers };
}

/** Read the config file from the target repo root; absent file is fine. */
export function loadConfigFile(repoDir: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(join(repoDir, CONFIG_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new ConfigError(`${CONFIG_FILE} is not valid JSON`);
  }
}
