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

  it("scrubs credential-shaped content out of the durable log file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "border-collie-context-test-"));
    const token = `ghp_${"A".repeat(36)}`;
    const secretUrl = `https://x-access-token:${token}@github.com/o/r.git`;

    const context = buildRealContext(dir);
    context.log({
      kind: "claim",
      level: "debug",
      ticket: 1,
      msg: `git push ${secretUrl}`,
    });

    const logsDir = join(dir, ".border-collie", "logs");
    await vi.waitFor(() => {
      expect(existsSync(logsDir)).toBe(true);
    });
    const [fileName] = readdirSync(logsDir);
    const logPath = join(logsDir, String(fileName));

    await vi.waitFor(() => {
      const contents = readFileSync(logPath, "utf8").trim();
      expect(contents.length).toBeGreaterThan(0);
    });

    const contents = readFileSync(logPath, "utf8");
    expect(contents).not.toContain(token);
    expect(contents).not.toContain("x-access-token");
    expect(contents).toContain("https://<redacted>@github.com/o/r.git");
  });

  it("names the log file from BORDER_COLLIE_RUN_ID when set, so it correlates with the job that produced it (issue #75)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "border-collie-context-test-"));

    const context = buildRealContext(dir, { BORDER_COLLIE_RUN_ID: "12345678" });
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
    expect(readdirSync(logsDir)).toEqual(["12345678.jsonl"]);
  });

  it("falls back to a timestamp-derived name when BORDER_COLLIE_RUN_ID is unset", async () => {
    const dir = mkdtempSync(join(tmpdir(), "border-collie-context-test-"));

    const context = buildRealContext(dir, {});
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
    expect(fileName).not.toBe("12345678.jsonl");
    expect(fileName).toMatch(/^\d{4}-\d{2}-\d{2}T.*\.jsonl$/);
  });
});

/**
 * Another real-filesystem integration test: `initScaffold` writes this
 * package's own workflow templates into a target repo, so this proves the
 * whole chain — package-relative template lookup through to a file the
 * target repo can actually run — rather than trusting the injected-deps
 * unit tests that stand in for it in tests/app/init.test.ts.
 */
describe("buildRealContext's initScaffold", () => {
  it("scaffolds both workflow files into a fresh target repo, matching this package's own", async () => {
    const dir = mkdtempSync(join(tmpdir(), "border-collie-context-test-"));
    const context = buildRealContext(dir);

    const actions = context.initScaffold(false);

    expect(actions).toEqual([
      {
        relPath: ".github/workflows/border-collie-tick.yml",
        outcome: "written",
      },
      {
        relPath: ".github/workflows/border-collie-worker.yml",
        outcome: "written",
      },
    ]);
    for (const { relPath } of actions) {
      expect(readFileSync(join(dir, relPath), "utf8")).toBe(
        readFileSync(relPath, "utf8"),
      );
    }
  });

  it("skips a file already present, and only overwrites it with --force", async () => {
    const dir = mkdtempSync(join(tmpdir(), "border-collie-context-test-"));
    const context = buildRealContext(dir);
    context.initScaffold(false);

    const skipped = context.initScaffold(false);
    expect(skipped.every((a) => a.outcome === "skipped-exists")).toBe(true);

    const forced = context.initScaffold(true);
    expect(forced.every((a) => a.outcome === "overwritten")).toBe(true);
  });
});
