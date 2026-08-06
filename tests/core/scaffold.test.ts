import { describe, expect, it } from "vitest";
import {
  pinCliVersion,
  planScaffold,
  renderChecklist,
  renderScaffoldReport,
  SCAFFOLD_FILES,
  scaffoldWrites,
} from "../../src/core/scaffold.js";
import { pinnedCliVersion } from "../helpers/workflow-template.js";

describe("pinCliVersion", () => {
  it("rewrites the pin to the given version", () => {
    const pinned = pinCliVersion(
      "      - name: Install border-collie\n        run: npm install -g border-collie@0.3.0\n",
      "0.4.0",
    );

    expect(pinnedCliVersion(pinned)).toBe("0.4.0");
  });

  it("leaves everything but the version untouched", () => {
    const template = "before\nrun: npm install -g border-collie@0.3.0\nafter\n";

    expect(pinCliVersion(template, "0.3.0")).toBe(template);
  });

  it("moves every pin, so a workflow can't install two versions of one CLI", () => {
    const pinned = pinCliVersion(
      "npm install -g border-collie@0.3.0\nnpm install -g border-collie@0.2.0\n",
      "0.4.0",
    );

    expect(pinned).not.toContain("border-collie@0.3.0");
    expect(pinned).not.toContain("border-collie@0.2.0");
    expect(pinned.match(/border-collie@0\.4\.0/g)).toHaveLength(2);
  });

  it("leaves the neighbouring Claude Code install alone", () => {
    const pinned = pinCliVersion(
      "npm install -g border-collie@0.3.0\nnpm install -g @anthropic-ai/claude-code@latest\n",
      "0.4.0",
    );

    expect(pinned).toContain("@anthropic-ai/claude-code@latest");
  });

  it("refuses a template that installs no border-collie at all", () => {
    expect(() => pinCliVersion("name: border-collie Tick\n", "0.4.0")).toThrow(
      /npm install -g border-collie/,
    );
  });
});

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
