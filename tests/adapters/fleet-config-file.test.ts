import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadFleetConfigFile } from "../../src/adapters/fleet-config-file.js";
import { ConfigError } from "../../src/core/config.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "border-collie-fleet-config-test-"));
}

describe("loadFleetConfigFile", () => {
  it("returns undefined when the file is absent — a missing fleet policy file is valid", () => {
    expect(loadFleetConfigFile(join(tempDir(), "fleet.json"))).toBeUndefined();
  });

  it("parses the file's JSON when present", () => {
    const path = join(tempDir(), "fleet.json");
    writeFileSync(path, JSON.stringify({ defaults: { max_open_prs: 8 } }));

    expect(loadFleetConfigFile(path)).toEqual({
      defaults: { max_open_prs: 8 },
    });
  });

  it("names invalid JSON rather than crashing", () => {
    const path = join(tempDir(), "fleet.json");
    writeFileSync(path, "{ not json");

    expect(() => loadFleetConfigFile(path)).toThrow(ConfigError);
  });
});
