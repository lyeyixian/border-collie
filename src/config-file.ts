import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_FILE, ConfigError } from "./config.js";

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
