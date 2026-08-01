import { describe, expect, it } from "vitest";
import { runInitScaffold } from "../../src/app/init.js";
import { SCAFFOLD_FILES } from "../../src/core/scaffold.js";

function fakeDeps(existing: string[] = []) {
  const writes: { cwd: string; relPath: string; content: string }[] = [];
  return {
    deps: {
      exists: (_cwd: string, relPath: string) => existing.includes(relPath),
      write: (cwd: string, relPath: string, content: string) => {
        writes.push({ cwd, relPath, content });
      },
      loadTemplate: (relPath: string) => `template:${relPath}`,
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
        content: `template:${relPath}`,
      })),
    );
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
