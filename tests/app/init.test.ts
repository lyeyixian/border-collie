import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { initScaffoldOnce, runInitScaffold } from "../../src/app/init.js";
import { SCAFFOLD_FILES } from "../../src/core/scaffold.js";
import { pinnedCliVersion } from "../helpers/workflow-template.js";

function fakeDeps(existing: string[] = [], version = "9.9.9") {
  const writes: { cwd: string; relPath: string; content: string }[] = [];
  return {
    deps: {
      exists: (_cwd: string, relPath: string) => existing.includes(relPath),
      write: (cwd: string, relPath: string, content: string) => {
        writes.push({ cwd, relPath, content });
      },
      loadTemplate: (relPath: string) =>
        `template:${relPath}\nrun: npm install -g border-collie@0.0.1\n`,
      cliVersion: () => version,
    },
    writes,
  };
}

describe("runInitScaffold", () => {
  it("writes every scaffold file's template content on a fresh repo", () => {
    const { deps, writes } = fakeDeps();

    const actions = runInitScaffold("/repo", false, deps);

    expect(actions).toEqual(
      SCAFFOLD_FILES.map((relPath) => ({ relPath, outcome: "written" })),
    );
    expect(writes).toEqual(
      SCAFFOLD_FILES.map((relPath) => ({
        cwd: "/repo",
        relPath,
        content: `template:${relPath}\nrun: npm install -g border-collie@9.9.9\n`,
      })),
    );
  });

  /**
   * Issue #99: the version written is the version scaffolding, not the one
   * the template text happened to carry — which, in a published tarball,
   * is always the release before it.
   */
  it("pins every written file to the running CLI's own version", () => {
    const { deps, writes } = fakeDeps([], "1.2.3");

    runInitScaffold("/repo", false, deps);

    for (const write of writes) {
      expect(pinnedCliVersion(write.content)).toBe("1.2.3");
    }
  });

  it("skips an existing file without writing it, and reports the skip", () => {
    const [first] = SCAFFOLD_FILES as [string, string];
    const { deps, writes } = fakeDeps([first]);

    const actions = runInitScaffold("/repo", false, deps);

    expect(actions.find((a) => a.relPath === first)).toEqual({
      relPath: first,
      outcome: "skipped-exists",
    });
    expect(writes.some((w) => w.relPath === first)).toBe(false);
  });

  it("overwrites an existing file when force is set", () => {
    const [first] = SCAFFOLD_FILES as [string, string];
    const { deps, writes } = fakeDeps([first]);

    const actions = runInitScaffold("/repo", true, deps);

    expect(actions.find((a) => a.relPath === first)).toEqual({
      relPath: first,
      outcome: "overwritten",
    });
    expect(writes.some((w) => w.relPath === first)).toBe(true);
  });
});

/**
 * The guard the lag-by-one bug slipped past (issue #99). The template guard
 * in tests/adapters/scaffold.test.ts only rejects a pin *ahead* of
 * package.json, so a published version N shipping templates that named N-1 —
 * which is what building the tarball from the `v<N>` tag guarantees — was
 * invisible to it. This asserts the thing that actually matters to a user:
 * the version on disk in a repo that has just been scaffolded is the version
 * that scaffolded it. Runs the real composition, so nothing between
 * `loadTemplate` and the write can drop the re-pin.
 */
describe("initScaffoldOnce", () => {
  it("scaffolds workflows pinned to this package's own version", () => {
    const dir = mkdtempSync(join(tmpdir(), "border-collie-init-test-"));
    const packageVersion = JSON.parse(readFileSync("package.json", "utf8"))
      .version as string;

    const actions = initScaffoldOnce(dir, false);

    expect(actions.map((a) => a.outcome)).toEqual(
      SCAFFOLD_FILES.map(() => "written"),
    );
    for (const relPath of SCAFFOLD_FILES) {
      const scaffolded = readFileSync(join(dir, relPath), "utf8");

      expect(pinnedCliVersion(scaffolded)).toBe(packageVersion);
    }
  });

  it("changes nothing else about the templates it copies", () => {
    const dir = mkdtempSync(join(tmpdir(), "border-collie-init-test-"));
    const packageVersion = JSON.parse(readFileSync("package.json", "utf8"))
      .version as string;

    initScaffoldOnce(dir, false);

    for (const relPath of SCAFFOLD_FILES) {
      const scaffolded = readFileSync(join(dir, relPath), "utf8");
      const template = readFileSync(relPath, "utf8");

      expect(scaffolded).toBe(
        template.replace(
          /(npm install -g border-collie@)\S+/g,
          `$1${packageVersion}`,
        ),
      );
    }
  });
});
