import { describe, expect, it } from "vitest";
import type { OnboardingOutcome } from "../../src/adapters/worker.js";
import type { LoadContract } from "../../src/adapters/workflow.js";
import { type DeclareDeps, runDeclare } from "../../src/app/declare.js";
import {
  type DeclareExclusion,
  redBaselineMarker,
  type TrackerIssueRef,
} from "../../src/core/declare.js";
import type { Log, LogEvent } from "../../src/core/log.js";
import { EMPTY_CONTRACT } from "../../src/core/workflow.js";

function recordingLog(): { log: Log; events: LogEvent[] } {
  const events: LogEvent[] = [];
  const log = ((event: LogEvent) => {
    events.push(event);
  }) as Log;
  log.child = () => log;
  return { log, events };
}

function session(
  overrides: Partial<OnboardingOutcome> = {},
): OnboardingOutcome {
  return {
    transcript: ".border-collie/transcripts/declare.jsonl",
    exitCode: 0,
    endedBy: "exit",
    costUsd: undefined,
    costOverrun: false,
    ...overrides,
  };
}

function fakeDeps(overrides: Partial<DeclareDeps> = {}): DeclareDeps {
  const { log } = recordingLog();
  return {
    dispatch: async () => session(),
    loadContractFn: async () => EMPTY_CONTRACT,
    readExistingContract: async () => undefined,
    restoreContract: async () => {},
    loadSidecar: async () => [],
    clearSidecar: async () => {},
    listOpenIssues: async () => [],
    createIssue: async () => {
      throw new Error("createIssue not stubbed");
    },
    checkDockerfile: async () => false,
    log,
    ...overrides,
  };
}

function redExclusion(name: string, reason = "exits 1"): DeclareExclusion {
  return { name, kind: "red", reason };
}

describe("runDeclare", () => {
  it("runs the session, then reads the contract and the sidecar it left behind", async () => {
    const contract = {
      afterCreate: undefined,
      dockerfile: undefined,
      verify: { lint: "pnpm lint" },
    };
    const excluded: DeclareExclusion[] = [
      { name: "e2e", kind: "missing", reason: "does not exist" },
    ];
    const clearedAfterRead: string[] = [];
    const deps = fakeDeps({
      loadContractFn: (async () => {
        clearedAfterRead.push("contract");
        return contract;
      }) as LoadContract,
      loadSidecar: async () => {
        clearedAfterRead.push("sidecar");
        return excluded;
      },
      clearSidecar: async () => {
        clearedAfterRead.push("cleared");
      },
    });

    const outcome = await runDeclare(deps);

    expect(outcome.contract).toEqual(contract);
    expect(outcome.excluded).toEqual(excluded);
    expect(clearedAfterRead).toEqual(["contract", "sidecar", "cleared"]);
  });

  it("carries the session's own run facts into the outcome", async () => {
    const deps = fakeDeps({
      dispatch: async () => session({ endedBy: "stall", exitCode: null }),
    });

    const outcome = await runDeclare(deps);

    expect(outcome.endedBy).toBe("stall");
    expect(outcome.exitCode).toBeNull();
  });

  it("carries cost and the overrun flag from the session", async () => {
    const deps = fakeDeps({
      dispatch: async () => session({ costUsd: 25, costOverrun: true }),
    });

    const outcome = await runDeclare(deps);

    expect(outcome.costUsd).toBe(25);
    expect(outcome.costOverrun).toBe(true);
  });

  it("degrades to an empty contract, logging a warning, when the written WORKFLOW.md fails to parse", async () => {
    const { log, events } = recordingLog();
    const deps = fakeDeps({
      loadContractFn: (async () => {
        throw new Error("front matter is not a mapping");
      }) as LoadContract,
      log,
    });

    const outcome = await runDeclare(deps);

    expect(outcome.contract).toEqual(EMPTY_CONTRACT);
    expect(events).toEqual([
      expect.objectContaining({
        kind: "declare-contract-invalid",
        level: "warn",
      }),
    ]);
  });

  it("degrades to no exclusions, logging a warning, when the sidecar fails to parse — and still clears it", async () => {
    const { log, events } = recordingLog();
    let cleared = false;
    const deps = fakeDeps({
      loadSidecar: async () => {
        throw new Error("declare-sidecar.json is not valid JSON");
      },
      clearSidecar: async () => {
        cleared = true;
      },
      log,
    });

    const outcome = await runDeclare(deps);

    expect(outcome.excluded).toEqual([]);
    expect(cleared).toBe(true);
    expect(events).toEqual([
      expect.objectContaining({
        kind: "declare-sidecar-invalid",
        level: "warn",
      }),
    ]);
  });

  it("clears the sidecar even when nothing was excluded", async () => {
    let cleared = false;
    const deps = fakeDeps({
      clearSidecar: async () => {
        cleared = true;
      },
    });

    await runDeclare(deps);

    expect(cleared).toBe(true);
  });

  it("reports no Dockerfile found, without failing, when the checked path does not exist", async () => {
    const deps = fakeDeps({ checkDockerfile: async () => false });

    const outcome = await runDeclare(deps);

    expect(outcome.dockerfileFound).toBe(false);
    expect(outcome.exitCode).toBe(0);
  });

  it("checks the contract's resolved Dockerfile path, and reports it found", async () => {
    const seen: string[] = [];
    const deps = fakeDeps({
      loadContractFn: async () => ({
        afterCreate: undefined,
        dockerfile: "docker/agent.Dockerfile",
        verify: {},
      }),
      checkDockerfile: async (path) => {
        seen.push(path);
        return true;
      },
    });

    const outcome = await runDeclare(deps);

    expect(seen).toEqual(["docker/agent.Dockerfile"]);
    expect(outcome.dockerfileFound).toBe(true);
  });

  describe("regression refusal", () => {
    const previousRaw =
      "---\nverify:\n  lint: pnpm lint\n  test: pnpm test\n---\n";

    it("restores the existing contract byte-identical when a declared command now fails", async () => {
      const restored: Array<{ cwd: string; raw: string }> = [];
      const deps = fakeDeps({
        readExistingContract: async () => previousRaw,
        loadContractFn: async () => ({
          afterCreate: undefined,
          dockerfile: undefined,
          verify: { lint: "pnpm lint" },
        }),
        loadSidecar: async () => [redExclusion("test")],
        restoreContract: async (cwd, raw) => {
          restored.push({ cwd, raw });
        },
      });

      const outcome = await runDeclare(deps);

      expect(restored).toEqual([{ cwd: ".", raw: previousRaw }]);
      expect(outcome.contract).toEqual({
        afterCreate: undefined,
        dockerfile: undefined,
        verify: { lint: "pnpm lint", test: "pnpm test" },
      });
    });

    it("reports the regression naming the command that broke", async () => {
      const deps = fakeDeps({
        readExistingContract: async () => previousRaw,
        loadContractFn: async () => ({
          afterCreate: undefined,
          dockerfile: undefined,
          verify: { lint: "pnpm lint" },
        }),
      });

      const outcome = await runDeclare(deps);

      expect(outcome.regressions).toEqual(["test"]);
    });

    it("discards this run's exclusions when refusing over a regression", async () => {
      const deps = fakeDeps({
        readExistingContract: async () => previousRaw,
        loadContractFn: async () => ({
          afterCreate: undefined,
          dockerfile: undefined,
          verify: { lint: "pnpm lint" },
        }),
        loadSidecar: async () => [redExclusion("test")],
      });

      const outcome = await runDeclare(deps);

      expect(outcome.excluded).toEqual([]);
    });

    it("rewrites the contract normally when every previously declared command still passes", async () => {
      const restored: unknown[] = [];
      const nextContract = {
        afterCreate: undefined,
        dockerfile: undefined,
        verify: { lint: "pnpm lint", test: "pnpm test", build: "pnpm build" },
      };
      const deps = fakeDeps({
        readExistingContract: async () => previousRaw,
        loadContractFn: async () => nextContract,
        restoreContract: async () => {
          restored.push(undefined);
        },
      });

      const outcome = await runDeclare(deps);

      expect(outcome.contract).toEqual(nextContract);
      expect(outcome.regressions).toEqual([]);
      expect(restored).toEqual([]);
    });

    it("is unaffected on a first declare with no existing contract", async () => {
      const nextContract = {
        afterCreate: undefined,
        dockerfile: undefined,
        verify: { lint: "pnpm lint" },
      };
      const deps = fakeDeps({
        readExistingContract: async () => undefined,
        loadContractFn: async () => nextContract,
      });

      const outcome = await runDeclare(deps);

      expect(outcome.contract).toEqual(nextContract);
      expect(outcome.regressions).toEqual([]);
    });

    it("does not report every previously declared command as regressed when the session's own contract fails to parse", async () => {
      const restored: unknown[] = [];
      const deps = fakeDeps({
        readExistingContract: async () => previousRaw,
        loadContractFn: (async () => {
          throw new Error("front matter is not a mapping");
        }) as LoadContract,
        restoreContract: async () => {
          restored.push(undefined);
        },
      });

      const outcome = await runDeclare(deps);

      expect(outcome.regressions).toEqual([]);
      expect(outcome.contract).toEqual(EMPTY_CONTRACT);
      expect(restored).toEqual([]);
    });
  });

  it("files a red command excluded from the contract as its own tracker issue", async () => {
    const created: { title: string; body: string }[] = [];
    const deps = fakeDeps({
      loadSidecar: async () => [redExclusion("build")],
      listOpenIssues: async () => [],
      createIssue: async (title, body) => {
        created.push({ title, body });
        return 42;
      },
    });

    const outcome = await runDeclare(deps);

    expect(created).toHaveLength(1);
    expect(created[0]?.title).toContain("build");
    expect(created[0]?.body).toContain(redBaselineMarker("build"));
    expect(outcome.redBaselines).toEqual([
      { command: "build", outcome: "filed", issue: 42 },
    ]);
  });

  it("files three red commands as three issues, not one", async () => {
    const created: string[] = [];
    let nextIssue = 100;
    const deps = fakeDeps({
      loadSidecar: async () => [
        redExclusion("lint"),
        redExclusion("typecheck"),
        redExclusion("build"),
      ],
      listOpenIssues: async () => [],
      createIssue: async (title) => {
        created.push(title);
        return nextIssue++;
      },
    });

    const outcome = await runDeclare(deps);

    expect(created).toHaveLength(3);
    expect(outcome.redBaselines.map((r) => r.outcome)).toEqual([
      "filed",
      "filed",
      "filed",
    ]);
  });

  it("never files a candidate excluded for a reason other than red", async () => {
    let createCalls = 0;
    const deps = fakeDeps({
      loadSidecar: async () => [
        { name: "e2e", kind: "missing", reason: "does not exist" },
        { name: "flaky", kind: "no-teardown", reason: "left a container up" },
      ],
      listOpenIssues: async () => {
        throw new Error("should not be read — nothing red to file");
      },
      createIssue: async () => {
        createCalls += 1;
        return 1;
      },
    });

    const outcome = await runDeclare(deps);

    expect(createCalls).toBe(0);
    expect(outcome.redBaselines).toEqual([]);
  });

  it("re-running with the same command still red files nothing and reports it as already recorded", async () => {
    const issues: TrackerIssueRef[] = [
      { number: 7, body: redBaselineMarker("build") },
    ];
    let createCalls = 0;
    const deps = fakeDeps({
      loadSidecar: async () => [redExclusion("build")],
      listOpenIssues: async () => issues,
      createIssue: async () => {
        createCalls += 1;
        return 999;
      },
    });

    const outcome = await runDeclare(deps);

    expect(createCalls).toBe(0);
    expect(outcome.redBaselines).toEqual([
      { command: "build", outcome: "already-recorded", issue: 7 },
    ]);
  });

  it("reports an unreachable tracker without throwing, naming each red command to file by hand", async () => {
    const { log, events } = recordingLog();
    const deps = fakeDeps({
      loadSidecar: async () => [redExclusion("build"), redExclusion("lint")],
      listOpenIssues: async () => {
        throw new Error("gh: command not found");
      },
      log,
    });

    const outcome = await runDeclare(deps);

    expect(outcome.redBaselines).toEqual([
      { command: "build", outcome: "failed", error: "gh: command not found" },
      { command: "lint", outcome: "failed", error: "gh: command not found" },
    ]);
    expect(events).toContainEqual(expect.objectContaining({ level: "warn" }));
    // The contract itself is unaffected by the unreachable tracker.
    expect(outcome.contract).toEqual(EMPTY_CONTRACT);
  });

  it("isolates one red command's filing failure from the rest", async () => {
    const deps = fakeDeps({
      loadSidecar: async () => [redExclusion("build"), redExclusion("lint")],
      listOpenIssues: async () => [],
      createIssue: async (title) => {
        if (title.includes("build")) throw new Error("422 already exists");
        return 55;
      },
    });

    const outcome = await runDeclare(deps);

    expect(outcome.redBaselines).toEqual([
      { command: "build", outcome: "failed", error: "422 already exists" },
      { command: "lint", outcome: "filed", issue: 55 },
    ]);
  });
});
