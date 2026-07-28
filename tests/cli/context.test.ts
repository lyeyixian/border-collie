import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildRealContext } from "../../src/cli/context.js";

/**
 * The one integration test in the set: builds the real composition root
 * (real tslog instance, real filesystem) against a temporary directory and
 * proves the durable file sink actually exists, rather than trusting the
 * injected-collector unit tests that stand in for it everywhere else.
 */
describe("buildRealContext's durable log file", () => {
  it("creates a log file under <cwd>/.border-collie/logs containing a debug record", async () => {
    const dir = mkdtempSync(join(tmpdir(), "border-collie-context-test-"));

    const context = buildRealContext(dir);
    context.log({
      kind: "claim",
      level: "debug",
      ticket: 1,
      msg: "claimed #1",
    });

    const logsDir = join(dir, ".border-collie", "logs");
    await vi.waitFor(() => {
      expect(existsSync(logsDir)).toBe(true);
    });
    const [fileName] = readdirSync(logsDir);
    expect(fileName).toBeDefined();
    const logPath = join(logsDir, String(fileName));

    await vi.waitFor(() => {
      const contents = readFileSync(logPath, "utf8").trim();
      expect(contents.length).toBeGreaterThan(0);
    });

    const line = readFileSync(logPath, "utf8").trim().split("\n")[0];
    const record = JSON.parse(String(line));
    expect(record).toMatchObject({ message: "claimed #1", level: "DEBUG" });
  });
});
