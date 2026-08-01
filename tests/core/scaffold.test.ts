import { describe, expect, it } from "vitest";
import {
  pinIsAhead,
  pinnedCliVersion,
  planScaffold,
  renderChecklist,
  renderScaffoldReport,
  SCAFFOLD_FILES,
  scaffoldWrites,
} from "../../src/core/scaffold.js";

describe("planScaffold", () => {
  it("writes every file when nothing exists yet", () => {
    const actions = planScaffold(new Set(), false);

    expect(actions).toEqual(
      SCAFFOLD_FILES.map((relPath) => ({ relPath, outcome: "written" })),
    );
  });

  it("skips an existing file without force, and says so", () => {
    const [first] = SCAFFOLD_FILES;
    const actions = planScaffold(new Set([first as string]), false);

    expect(actions[0]).toEqual({ relPath: first, outcome: "skipped-exists" });
  });

  it("overwrites an existing file when force is set", () => {
    const [first] = SCAFFOLD_FILES;
    const actions = planScaffold(new Set([first as string]), true);

    expect(actions[0]).toEqual({ relPath: first, outcome: "overwritten" });
  });

  it("never overwrites a file that doesn't exist yet, force or not", () => {
    const [, second] = SCAFFOLD_FILES;
    const actions = planScaffold(new Set(), true);

    expect(actions.find((a) => a.relPath === second)).toEqual({
      relPath: second,
      outcome: "written",
    });
  });
});

describe("pinnedCliVersion", () => {
  it("reads the version a template pins the orchestrator to", () => {
    const template = [
      "      - name: Install border-collie",
      "        run: npm install -g border-collie@1.2.3",
    ].join("\n");

    expect(pinnedCliVersion(template)).toBe("1.2.3");
  });

  it("is null for a template that installs nothing", () => {
    expect(pinnedCliVersion("name: Worker\n")).toBeNull();
  });

  it("ignores another package's pin on a neighbouring line", () => {
    const template = [
      "        run: npm install -g @anthropic-ai/claude-code@latest",
      "        run: npm install -g border-collie@0.9.0",
    ].join("\n");

    expect(pinnedCliVersion(template)).toBe("0.9.0");
  });

  it("is null when the install floats instead of pinning", () => {
    expect(pinnedCliVersion("run: npm install -g border-collie\n")).toBeNull();
  });
});

describe("pinIsAhead", () => {
  it("is false for a pin this package has exactly reached", () => {
    expect(pinIsAhead("0.3.0", "0.3.0")).toBe(false);
  });

  it("is false for a pin lagging behind, the normal state mid-release", () => {
    expect(pinIsAhead("0.3.0", "0.3.1")).toBe(false);
    expect(pinIsAhead("0.9.9", "1.0.0")).toBe(false);
  });

  it("is true for a pin naming a version that cannot be on npm yet", () => {
    expect(pinIsAhead("0.3.1", "0.3.0")).toBe(true);
    expect(pinIsAhead("1.0.0", "0.9.9")).toBe(true);
  });

  it("compares numerically, not as strings", () => {
    expect(pinIsAhead("0.10.0", "0.9.0")).toBe(true);
    expect(pinIsAhead("0.9.0", "0.10.0")).toBe(false);
  });

  it("compares a prerelease on its release triple", () => {
    expect(pinIsAhead("0.4.0-beta.1", "0.4.0")).toBe(false);
    expect(pinIsAhead("0.5.0-beta.1", "0.4.0")).toBe(true);
  });
});

describe("scaffoldWrites", () => {
  it("excludes skipped-exists but keeps written and overwritten", () => {
    const actions = [
      { relPath: "a", outcome: "written" as const },
      { relPath: "b", outcome: "skipped-exists" as const },
      { relPath: "c", outcome: "overwritten" as const },
    ];

    expect(scaffoldWrites(actions)).toEqual([
      { relPath: "a", outcome: "written" },
      { relPath: "c", outcome: "overwritten" },
    ]);
  });
});

describe("renderScaffoldReport", () => {
  it("reports a written file", () => {
    const report = renderScaffoldReport([
      {
        relPath: ".github/workflows/border-collie-tick.yml",
        outcome: "written",
      },
    ]);

    expect(report).toContain("wrote");
    expect(report).toContain(".github/workflows/border-collie-tick.yml");
  });

  it("reports a skipped file with a hint to use --force", () => {
    const report = renderScaffoldReport([
      {
        relPath: ".github/workflows/border-collie-tick.yml",
        outcome: "skipped-exists",
      },
    ]);

    expect(report).toContain("skipped");
    expect(report).toContain("--force");
  });

  it("reports an overwritten file", () => {
    const report = renderScaffoldReport([
      {
        relPath: ".github/workflows/border-collie-tick.yml",
        outcome: "overwritten",
      },
    ]);

    expect(report).toContain("overwrote");
  });
});

describe("renderChecklist", () => {
  const checklist = renderChecklist();

  it("lists the required secrets", () => {
    expect(checklist).toContain("BORDER_COLLIE_APP_PRIVATE_KEY");
    expect(checklist).toContain("CLAUDE_CODE_OAUTH_TOKEN");
  });

  it("lists the App ID as a variable, not a secret", () => {
    expect(checklist).toContain("Variable BORDER_COLLIE_APP_ID");
  });

  it("excludes the Workflows permission, so a Worker can never rewrite its own workflow", () => {
    expect(checklist).toContain("Leave Workflows ungranted");
    expect(checklist).not.toMatch(/Workflows:\s*Read/);
  });

  it("says how the orchestrator itself arrives, so no build is expected of the target repo", () => {
    expect(checklist).toContain("install border-collie from npm");
    expect(checklist).toContain("border-collie init --force");
  });

  it("lists the minimum repository permissions", () => {
    expect(checklist).toContain("Contents: Read and write");
    expect(checklist).toContain("Issues: Read and write");
    expect(checklist).toContain("Pull requests: Read and write");
    expect(checklist).toContain("Actions: Read and write");
  });
});
