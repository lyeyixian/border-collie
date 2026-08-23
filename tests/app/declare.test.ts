import { describe, expect, it } from "vitest";
import type { OnboardingOutcome } from "../../src/adapters/worker.js";
import type { LoadContract } from "../../src/adapters/workflow.js";
import { type DeclareDeps, runDeclare } from "../../src/app/declare.js";
import type { DeclareExclusion } from "../../src/core/declare.js";
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
    log,
    ...overrides,
  };
}

describe("runDeclare", () => {
  it("runs the session, then reads the contract and the sidecar it left behind", async () => {
    const contract = { afterCreate: undefined, verify: { lint: "pnpm lint" } };
    const excluded: DeclareExclusion[] = [
      { name: "e2e", reason: "does not exist" },
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

  describe("regression refusal", () => {
    const previousRaw =
      "---\nverify:\n  lint: pnpm lint\n  test: pnpm test\n---\n";

    it("restores the existing contract byte-identical when a declared command now fails", async () => {
      const restored: Array<{ cwd: string; raw: string }> = [];
      const deps = fakeDeps({
        readExistingContract: async () => previousRaw,
        loadContractFn: async () => ({
          afterCreate: undefined,
          verify: { lint: "pnpm lint" },
        }),
        loadSidecar: async () => [{ name: "test", reason: "exits 1" }],
        restoreContract: async (cwd, raw) => {
          restored.push({ cwd, raw });
        },
      });

      const outcome = await runDeclare(deps);

      expect(restored).toEqual([{ cwd: ".", raw: previousRaw }]);
      expect(outcome.contract).toEqual({
        afterCreate: undefined,
        verify: { lint: "pnpm lint", test: "pnpm test" },
      });
    });

    it("reports the regression naming the command that broke", async () => {
      const deps = fakeDeps({
        readExistingContract: async () => previousRaw,
        loadContractFn: async () => ({
          afterCreate: undefined,
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
          verify: { lint: "pnpm lint" },
        }),
        loadSidecar: async () => [{ name: "test", reason: "exits 1" }],
      });

      const outcome = await runDeclare(deps);

      expect(outcome.excluded).toEqual([]);
    });

    it("rewrites the contract normally when every previously declared command still passes", async () => {
      const restored: unknown[] = [];
      const nextContract = {
        afterCreate: undefined,
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
});
