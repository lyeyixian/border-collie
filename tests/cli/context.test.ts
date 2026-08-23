import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildRealContext } from "../../src/cli/context.js";
import {
  GITIGNORE_ENTRY,
  GITIGNORE_PATH,
  SCAFFOLD_FILES,
  WORKFLOW_FILES,
} from "../../src/core/scaffold.js";
import { templateAsScaffolded } from "../helpers/workflow-template.js";

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
 * package's own workflows, vendored skills and agent docs into a target repo,
 * so this proves the whole chain — package-relative template lookup through
 * to a file the target repo can actually run — rather than trusting the
 * injected-deps unit tests that stand in for it in tests/app/init.test.ts.
 * What it cannot prove is that the tarball carries them: `loadTemplate`
 * resolves against this repo's own root when running from source, so a path
 * missing from package.json's "files" reads back fine here. That guard lives
 * in tests/adapters/scaffold.test.ts, and scripts/smoke.sh proves it cold.
 *
 * A workflow matches "this package's own" only modulo the CLI pin, which a
 * scaffold rewrites on the way out — see `templateAsScaffolded` (tests/
 * helpers/workflow-template.ts) for why comparing that line verbatim made the
 * tagged commit unreleasable by construction (issues #93, #123). A vendored
 * file is compared byte for byte instead, since that rewrite is exactly what
 * must *not* have happened to it (issue #153): normalising the pin away on
 * both sides would wave through a vendored skill the scaffold had re-pinned.
 */
describe("buildRealContext's initScaffold", () => {
  it("scaffolds every file into a fresh target repo, matching this package's own", async () => {
    const dir = mkdtempSync(join(tmpdir(), "border-collie-context-test-"));
    const context = buildRealContext(dir);

    const actions = context.initScaffold(false);

    expect(actions).toEqual([
      ...SCAFFOLD_FILES.map((relPath) => ({ relPath, outcome: "written" })),
      { relPath: GITIGNORE_PATH, outcome: "appended" },
    ]);
    const packageVersion = JSON.parse(readFileSync("package.json", "utf8"))
      .version as string;
    for (const { relPath } of actions) {
      if (relPath === GITIGNORE_PATH) {
        expect(readFileSync(join(dir, relPath), "utf8")).toBe(
          `${GITIGNORE_ENTRY}\n`,
        );
        continue;
      }
      expect(readFileSync(join(dir, relPath), "utf8")).toBe(
        WORKFLOW_FILES.includes(relPath)
          ? templateAsScaffolded(relPath, packageVersion)
          : readFileSync(relPath, "utf8"),
      );
    }
  });

  it("skips a file already present, and only overwrites it with --force", async () => {
    const dir = mkdtempSync(join(tmpdir(), "border-collie-context-test-"));
    const context = buildRealContext(dir);
    context.initScaffold(false);

    const skipped = context.initScaffold(false);
    expect(
      skipped
        .filter((a) => a.relPath !== GITIGNORE_PATH)
        .every((a) => a.outcome === "skipped-exists"),
    ).toBe(true);
    expect(skipped.find((a) => a.relPath === GITIGNORE_PATH)?.outcome).toBe(
      "already-present",
    );

    const forced = context.initScaffold(true);
    expect(
      forced
        .filter((a) => a.relPath !== GITIGNORE_PATH)
        .every((a) => a.outcome === "overwritten"),
    ).toBe(true);
    expect(forced.find((a) => a.relPath === GITIGNORE_PATH)?.outcome).toBe(
      "already-present",
    );
  });
});
