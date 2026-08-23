import { describe, expect, it } from "vitest";
import {
  AGENT_DOC_FILES,
  CHECKLIST_WIDTH,
  labelCreateCommand,
  pinCliVersion,
  planScaffold,
  renderChecklist,
  renderLabelReport,
  renderScaffoldReport,
  SCAFFOLD_FILES,
  SKILL_FILES,
  scaffoldContent,
  scaffoldWrites,
  WORKER_SKILL_FILE,
  WORKFLOW_FILES,
} from "../../src/core/scaffold.js";
import {
  CLAIM_LABEL,
  OPERATOR_STEERED_LABEL,
  ORCHESTRATOR_LABELS,
  READY_FOR_AGENT,
  READY_FOR_HUMAN,
  WORKER_SKILL,
} from "../../src/core/types.js";
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

/**
 * Issue #153: the Worker's skills stopped being installed inside each Worker
 * job and became files `init` writes into the target repository. What the
 * Worker can reach is therefore a property of this list, not of whatever an
 * upstream marketplace happened to serve the night the cron fired.
 */
describe("SCAFFOLD_FILES", () => {
  it("is the workflows, then the vendored skill closure, then the docs those skills read", () => {
    expect(SCAFFOLD_FILES).toEqual([
      ...WORKFLOW_FILES,
      ...SKILL_FILES,
      ...AGENT_DOC_FILES,
    ]);
  });

  it("vendors the one skill whose name the Worker prompt invokes", () => {
    expect(SKILL_FILES).toContain(`.claude/skills/${WORKER_SKILL}/SKILL.md`);
  });

  it("names the load-bearing skill's own file (issue #155's dispatch-refusal check reads this path)", () => {
    expect(WORKER_SKILL_FILE).toBe(`.claude/skills/${WORKER_SKILL}/SKILL.md`);
    expect(SKILL_FILES[0]).toBe(WORKER_SKILL_FILE);
  });

  it("vendors the skills that one reaches, not merely that one", () => {
    for (const skill of ["tdd", "code-review", "codebase-design"]) {
      expect(SKILL_FILES).toContain(`.claude/skills/${skill}/SKILL.md`);
    }
  });

  it("hands over the tracker doc and the triage-label map a fresh repo has neither of", () => {
    expect(AGENT_DOC_FILES).toContain("docs/agents/issue-tracker.md");
    expect(AGENT_DOC_FILES).toContain("docs/agents/triage-labels.md");
  });

  it("keeps border-collie's own skills to itself", () => {
    expect(
      SCAFFOLD_FILES.filter((relPath) =>
        relPath.startsWith(".claude/skills/release/"),
      ),
    ).toEqual([]);
  });
});

describe("scaffoldContent", () => {
  it("re-pins a workflow to the version doing the scaffolding", () => {
    const content = scaffoldContent(
      ".github/workflows/border-collie-tick.yml",
      "run: npm install -g border-collie@0.3.0\n",
      "0.4.0",
    );

    expect(pinnedCliVersion(content)).toBe("0.4.0");
  });

  /**
   * The whole point of vendoring: a patched copy is a fork somebody has to
   * maintain against a moving upstream, so nothing is rewritten on the way
   * out — and a skill naming no CLI install must not be mistaken for the
   * broken workflow `pinCliVersion` refuses.
   */
  it("hands a vendored file over byte-identical", () => {
    const upstream = "---\nname: tdd\n---\n\n# Test-Driven Development\n";

    expect(
      scaffoldContent(
        `.claude/skills/${WORKER_SKILL}/SKILL.md`,
        upstream,
        "0.4.0",
      ),
    ).toBe(upstream);
  });

  it("still refuses a workflow that pins nothing", () => {
    expect(() =>
      scaffoldContent(
        ".github/workflows/border-collie-tick.yml",
        "name: border-collie Tick\n",
        "0.4.0",
      ),
    ).toThrow(/npm install -g border-collie/);
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

  /**
   * Issue #153: a vendored skill is the file an operator is most likely to
   * have edited, so it earns the same never-silently-overwritten treatment
   * the workflows have always had, named explicitly rather than inferred
   * from whichever path happens to sort first.
   */
  it("gives a vendored skill the same skip-then-force treatment as a workflow", () => {
    const skill = `.claude/skills/${WORKER_SKILL}/SKILL.md`;

    expect(planScaffold(new Set([skill]), false)).toContainEqual({
      relPath: skill,
      outcome: "skipped-exists",
    });
    expect(planScaffold(new Set([skill]), true)).toContainEqual({
      relPath: skill,
      outcome: "overwritten",
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

  it("heads the list as files, now that it is more than workflows", () => {
    expect(renderScaffoldReport([])).toBe("Scaffolded files:");
  });

  it("names every file it touched, whatever kind", () => {
    const report = renderScaffoldReport(
      SCAFFOLD_FILES.map((relPath) => ({
        relPath,
        outcome: "written" as const,
      })),
    );

    for (const relPath of SCAFFOLD_FILES) {
      expect(report).toContain(relPath);
    }
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

  /**
   * Issue #100: a scaffolded repo with every credential still failed its
   * first Claim, and the checklist — the place a gap is meant to surface
   * before a run rather than during one — said nothing about labels.
   */
  it("names every label the loop depends on", () => {
    for (const label of ORCHESTRATOR_LABELS) {
      expect(checklist).toContain(label.name);
    }
  });

  it("singles out the one label a human applies", () => {
    expect(checklist).toContain(
      `Only ${OPERATOR_STEERED_LABEL} is ever applied`,
    );
  });

  /**
   * Issue #153: the checklist used to promise that Worker skills installed
   * themselves inside each Worker job, which is the run-time install that
   * vendoring removed.
   */
  it("says the skills are written into the repository rather than installed in the job", () => {
    expect(checklist).toContain("install");
    expect(checklist).not.toMatch(/skills install automatically/);
    expect(checklist).toMatch(/\.claude\/skills/);
  });

  it("names the one skill whose name is load-bearing", () => {
    expect(checklist).toContain(`\`${WORKER_SKILL}\``);
  });

  it("keeps every line inside the block width the rest of it holds to", () => {
    for (const line of checklist.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(CHECKLIST_WIDTH);
    }
  });
});

/**
 * Issue #100: every label the Orchestrator reads or writes, defined once so
 * the set `init` creates cannot drift from the set the loop uses. This asserts
 * the constants the rest of the codebase imports are all *in* that set —
 * the drift the issue named, in the direction it named it.
 */
describe("ORCHESTRATOR_LABELS", () => {
  const names = ORCHESTRATOR_LABELS.map((label) => label.name);

  it("covers every label constant the loop is written against", () => {
    expect(names).toContain(READY_FOR_AGENT);
    expect(names).toContain(READY_FOR_HUMAN);
    expect(names).toContain(CLAIM_LABEL);
    expect(names).toContain(OPERATOR_STEERED_LABEL);
  });

  it("gives each label a description and a six-digit hex colour", () => {
    for (const label of ORCHESTRATOR_LABELS) {
      expect(label.description).not.toBe("");
      expect(label.color).toMatch(/^[0-9a-f]{6}$/);
    }
  });
});

describe("labelCreateCommand", () => {
  it("quotes the description, so a multi-word one survives a copy-paste", () => {
    const command = labelCreateCommand({
      name: "claimed",
      description: "Claimed by border-collie: a Worker is in flight",
      color: "5319e7",
    });

    expect(command).toBe(
      'gh label create claimed --color 5319e7 --description "Claimed by border-collie: a Worker is in flight"',
    );
  });
});

describe("renderLabelReport", () => {
  it("reports a created label", () => {
    const report = renderLabelReport([
      { name: CLAIM_LABEL, outcome: "created" },
    ]);

    expect(report).toContain(`created    ${CLAIM_LABEL}`);
  });

  it("says an existing label was left as it was", () => {
    const report = renderLabelReport([
      { name: READY_FOR_AGENT, outcome: "exists" },
    ]);

    expect(report).toContain(`exists     ${READY_FOR_AGENT}`);
    expect(report).toContain("left as-is");
  });

  it("gives a failed label the reason and the command to run by hand", () => {
    const report = renderLabelReport([
      { name: CLAIM_LABEL, outcome: "failed", error: "gh: no such remote" },
    ]);

    expect(report).toContain(`failed     ${CLAIM_LABEL}`);
    expect(report).toContain("gh: no such remote");
    expect(report).toContain(`gh label create ${CLAIM_LABEL} --color`);
  });

  /**
   * An unreachable tracker fails every label with one and the same refusal;
   * four copies of it would bury the four commands that actually matter.
   */
  it("states a shared refusal once, however many labels it took down", () => {
    const report = renderLabelReport(
      ORCHESTRATOR_LABELS.map((label) => ({
        name: label.name,
        outcome: "failed" as const,
        error: "gh: not authenticated",
      })),
    );

    expect(report.match(/gh: not authenticated/g)).toHaveLength(1);
    expect(report.match(/gh label create /g)).toHaveLength(
      ORCHESTRATOR_LABELS.length,
    );
  });

  /**
   * A refused `gh` arrives as a message with the command's own stderr and its
   * trailing blank lines glued on, which would open a hole mid-report.
   */
  it("flattens a multi-line subprocess message into indented lines", () => {
    const report = renderLabelReport([
      {
        name: CLAIM_LABEL,
        outcome: "failed",
        error: "Command failed: gh label list\nfatal: not a git repository\n\n",
      },
    ]);

    expect(report).toContain("  Command failed: gh label list\n");
    expect(report).toContain("  fatal: not a git repository\n");
    expect(report).not.toContain("\n\n\n");
  });

  it("adds no hand-run block when every label landed", () => {
    const report = renderLabelReport(
      ORCHESTRATOR_LABELS.map((label) => ({
        name: label.name,
        outcome: "created" as const,
      })),
    );

    expect(report).not.toContain("gh label create");
  });
});
