import { readFileSync } from "node:fs";
import { ConfigError, FLEET_CONFIG_FILE } from "../core/config.js";

/**
 * Reads the daemon's fleet policy file (issue #184) from its configured
 * path on the daemon's own host — never a target repository's checkout,
 * which is exactly what retires `border-collie.json`. An absent file is
 * fine: `parseFleetConfig` (core/config.ts) treats `undefined` as no
 * defaults and no overrides.
 */
export function loadFleetConfigFile(path: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new ConfigError(`${FLEET_CONFIG_FILE} is not valid JSON`);
  }
}
