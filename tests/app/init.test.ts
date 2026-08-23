import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  initScaffoldOnce,
  runInitLabels,
  runInitScaffold,
} from "../../src/app/init.js";
import {
  GITIGNORE_ENTRY,
  GITIGNORE_PATH,
  SCAFFOLD_FILES,
  SKILL_FILES,
  WORKFLOW_FILES,
} from "../../src/core/scaffold.js";
import {
  CLAIM_LABEL,
  OPERATOR_STEERED_LABEL,
  ORCHESTRATOR_LABELS,
  type OrchestratorLabel,
  READY_FOR_AGENT,
} from "../../src/core/types.js";
import {
  pinnedCliVersion,
  templateAsScaffolded,
} from "../helpers/workflow-template.js";

function fakeDeps(
  existing: string[] = [],
  version = "9.9.9",
  gitignore: string | undefined = undefined,
) {
  const writes: { cwd: string; relPath: string; content: string }[] = [];
  return {
    deps: {
      exists: (_cwd: string, relPath: string) => existing.includes(relPath),
      write: (cwd: string, relPath: string, content: string) => {
        writes.push({ cwd, relPath, content });
      },
      // Shaped like the real templates: a workflow names a CLI install, a
      // vendored skill or doc names nothing of ours at all.
      loadTemplate: (relPath: string) =>
        WORKFLOW_FILES.includes(relPath)
          ? `template:${relPath}\nrun: npm install -g border-collie@0.0.1\n`
          : `template:${relPath}\n`,
      cliVersion: () => version,
      readGitignore: () => gitignore,
    },
    writes,
  };
}

describe("runInitScaffold", () => {
  it("writes every scaffold file's template content on a fresh repo", () => {
    const { deps, writes } = fakeDeps();

    const actions = runInitScaffold("/repo", false, deps);

    expect(actions).toEqual([
      ...SCAFFOLD_FILES.map((relPath) => ({ relPath, outcome: "written" })),
      { relPath: GITIGNORE_PATH, outcome: "appended" },
    ]);
    expect(writes).toEqual([
      ...SCAFFOLD_FILES.map((relPath) => ({
        cwd: "/repo",
        relPath,
        content: WORKFLOW_FILES.includes(relPath)
          ? `template:${relPath}\nrun: npm install -g border-collie@9.9.9\n`
          : `template:${relPath}\n`,
      })),
      {
        cwd: "/repo",
        relPath: GITIGNORE_PATH,
        content: `${GITIGNORE_ENTRY}\n`,
      },
    ]);
  });

  /**
   * Issue #99: the version written is the version scaffolding, not the one
   * the template text happened to carry — which, in a published tarball,
   * is always the release before it.
   */
  it("pins every written workflow to the running CLI's own version", () => {
    const { deps, writes } = fakeDeps([], "1.2.3");

    runInitScaffold("/repo", false, deps);

    for (const write of writes.filter((w) =>
      WORKFLOW_FILES.includes(w.relPath),
    )) {
      expect(pinnedCliVersion(write.content)).toBe("1.2.3");
    }
  });

  /**
   * Issue #153: a vendored skill is worth vendoring only if what lands is
   * what upstream wrote. It also names no CLI install, so routing it through
   * the pin rewrite would fail the whole scaffold rather than rewrite
   * anything.
   */
  it("writes a vendored skill exactly as the template gave it", () => {
    const { deps, writes } = fakeDeps([], "1.2.3");

    runInitScaffold("/repo", false, deps);

    for (const relPath of SKILL_FILES) {
      expect(writes.find((w) => w.relPath === relPath)?.content).toBe(
        `template:${relPath}\n`,
      );
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

  /**
   * Issue #154: `init` also appends one ignore entry for the fleet's own
   * local run directory, the only scaffolded path that edits a file the
   * repository already owns rather than writing a fresh one.
   */
  describe("the .gitignore entry", () => {
    it("creates the file when the repo has none", () => {
      const { deps, writes } = fakeDeps([], "9.9.9", undefined);

      const actions = runInitScaffold("/repo", false, deps);

      expect(actions.at(-1)).toEqual({
        relPath: GITIGNORE_PATH,
        outcome: "appended",
      });
      expect(writes.find((w) => w.relPath === GITIGNORE_PATH)?.content).toBe(
        `${GITIGNORE_ENTRY}\n`,
      );
    });

    it("appends to an existing file, preserving its lines in order", () => {
      const { deps, writes } = fakeDeps([], "9.9.9", "node_modules\ndist\n");

      const actions = runInitScaffold("/repo", false, deps);

      expect(actions.at(-1)).toEqual({
        relPath: GITIGNORE_PATH,
        outcome: "appended",
      });
      expect(writes.find((w) => w.relPath === GITIGNORE_PATH)?.content).toBe(
        `node_modules\ndist\n${GITIGNORE_ENTRY}\n`,
      );
    });

    it("writes nothing and reports already-present when the entry is there", () => {
      const { deps, writes } = fakeDeps(
        [],
        "9.9.9",
        `node_modules\n${GITIGNORE_ENTRY}\n`,
      );

      const actions = runInitScaffold("/repo", false, deps);

      expect(actions.at(-1)).toEqual({
        relPath: GITIGNORE_PATH,
        outcome: "already-present",
      });
      expect(writes.some((w) => w.relPath === GITIGNORE_PATH)).toBe(false);
    });
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

    expect(actions.map((a) => a.outcome)).toEqual([
      ...SCAFFOLD_FILES.map(() => "written"),
      "appended",
    ]);
    for (const relPath of WORKFLOW_FILES) {
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

      expect(scaffolded).toBe(templateAsScaffolded(relPath, packageVersion));
    }
  });

  /**
   * Issue #154's re-run invariant: unlike a scaffolded file, `.gitignore` is
   * never behind `--force` — the entry either lands once or is already there,
   * on every rerun.
   */
  it("appends its ignore entry once, and leaves the file alone on a rerun", () => {
    const dir = mkdtempSync(join(tmpdir(), "border-collie-init-test-"));

    const first = initScaffoldOnce(dir, false);
    const written = readFileSync(join(dir, GITIGNORE_PATH), "utf8");
    const second = initScaffoldOnce(dir, false);
    const rewritten = readFileSync(join(dir, GITIGNORE_PATH), "utf8");

    expect(first.find((a) => a.relPath === GITIGNORE_PATH)?.outcome).toBe(
      "appended",
    );
    expect(second.find((a) => a.relPath === GITIGNORE_PATH)?.outcome).toBe(
      "already-present",
    );
    expect(rewritten).toBe(written);
    expect(written).toBe(`${GITIGNORE_ENTRY}\n`);
  });
});

function fakeLabelDeps(
  existing: string[] = [],
  refuse: (label: OrchestratorLabel) => Error | undefined = () => undefined,
) {
  const created: OrchestratorLabel[] = [];
  return {
    deps: {
      listLabels: async () => existing,
      createLabel: async (label: OrchestratorLabel) => {
        const refusal = refuse(label);
        if (refusal !== undefined) throw refusal;
        created.push(label);
      },
    },
    created,
  };
}

/**
 * Issue #100: a scaffolded repo had none of the labels the Orchestrator
 * writes, so a repo that had followed every printed step still failed at the
 * first Claim of the first Tick.
 */
describe("runInitLabels", () => {
  it("creates every label the loop depends on, on a repo that has none", async () => {
    const { deps, created } = fakeLabelDeps();

    const actions = await runInitLabels(deps);

    expect(created).toEqual([...ORCHESTRATOR_LABELS]);
    expect(actions).toEqual(
      ORCHESTRATOR_LABELS.map((label) => ({
        name: label.name,
        outcome: "created",
      })),
    );
  });

  it("leaves an existing label untouched and says it was already there", async () => {
    const { deps, created } = fakeLabelDeps([READY_FOR_AGENT]);

    const actions = await runInitLabels(deps);

    expect(created.some((label) => label.name === READY_FOR_AGENT)).toBe(false);
    expect(actions).toContainEqual({
      name: READY_FOR_AGENT,
      outcome: "exists",
    });
  });

  /**
   * The exact state issue #100 found this repository in: the two triage
   * labels present, `claimed` never created, and nothing that would have
   * noticed until a Claim tried to write it.
   */
  it("adds only what is missing from a partly-labelled repo", async () => {
    const { deps, created } = fakeLabelDeps([
      "ready-for-agent",
      "ready-for-human",
      "bug",
    ]);

    await runInitLabels(deps);

    expect(created.map((label) => label.name)).toEqual([
      CLAIM_LABEL,
      OPERATOR_STEERED_LABEL,
    ]);
  });

  it("reports an unreachable tracker instead of failing the whole init", async () => {
    const deps = {
      listLabels: async () => {
        throw new Error("gh: not authenticated");
      },
      createLabel: async () => {
        throw new Error("never reached");
      },
    };

    const actions = await runInitLabels(deps);

    expect(actions).toEqual(
      ORCHESTRATOR_LABELS.map((label) => ({
        name: label.name,
        outcome: "failed",
        error: "gh: not authenticated",
      })),
    );
  });

  it("keeps going past a refused label, so one refusal costs only itself", async () => {
    const { deps, created } = fakeLabelDeps([], (label) =>
      label.name === CLAIM_LABEL ? new Error("HTTP 403") : undefined,
    );

    const actions = await runInitLabels(deps);

    expect(actions).toContainEqual({
      name: CLAIM_LABEL,
      outcome: "failed",
      error: "HTTP 403",
    });
    expect(created).toHaveLength(ORCHESTRATOR_LABELS.length - 1);
  });
});
