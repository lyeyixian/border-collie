import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  initScaffoldOnce,
  runInitLabels,
  runInitScaffold,
} from "../../src/app/init.js";
import { SCAFFOLD_FILES } from "../../src/core/scaffold.js";
import {
  CLAIM_LABEL,
  ORCHESTRATOR_LABELS,
  type OrchestratorLabel,
  READY_FOR_AGENT,
} from "../../src/core/types.js";
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
      "operator-steered",
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
