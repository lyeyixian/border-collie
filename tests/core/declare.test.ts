import { describe, expect, it } from "vitest";
import {
  type DeclareOutcome,
  DeclareSidecarError,
  declareRefused,
  declareRegressions,
  declareTroubled,
  parseDeclareSidecar,
  renderDeclareReport,
} from "../../src/core/declare.js";
import { EMPTY_CONTRACT } from "../../src/core/workflow.js";

describe("parseDeclareSidecar", () => {
  it("parses an object with an excluded array of {name, reason} entries", () => {
    const sidecar = parseDeclareSidecar(
      JSON.stringify({
        excluded: [
          { name: "e2e", reason: "does not exist" },
          { name: "build", reason: "exits 1" },
        ],
      }),
    );

    expect(sidecar.excluded).toEqual([
      { name: "e2e", reason: "does not exist" },
      { name: "build", reason: "exits 1" },
    ]);
  });

  it("accepts an empty excluded array", () => {
    expect(parseDeclareSidecar('{"excluded":[]}').excluded).toEqual([]);
  });

  it("rejects invalid JSON", () => {
    expect(() => parseDeclareSidecar("not json")).toThrow(DeclareSidecarError);
  });

  it("rejects a top-level array", () => {
    expect(() => parseDeclareSidecar("[]")).toThrow(DeclareSidecarError);
  });

  it("rejects a missing excluded key", () => {
    expect(() => parseDeclareSidecar("{}")).toThrow(DeclareSidecarError);
  });

  it("rejects an excluded entry missing reason", () => {
    expect(() =>
      parseDeclareSidecar(JSON.stringify({ excluded: [{ name: "build" }] })),
    ).toThrow(DeclareSidecarError);
  });

  it("rejects an excluded entry missing name", () => {
    expect(() =>
      parseDeclareSidecar(
        JSON.stringify({ excluded: [{ reason: "exits 1" }] }),
      ),
    ).toThrow(DeclareSidecarError);
  });
});

function outcome(overrides: Partial<DeclareOutcome> = {}): DeclareOutcome {
  return {
    endedBy: "exit",
    exitCode: 0,
    costUsd: undefined,
    costOverrun: false,
    contract: EMPTY_CONTRACT,
    excluded: [],
    regressions: [],
    ...overrides,
  };
}

describe("declareRegressions", () => {
  it("is empty when every previously declared command is still declared", () => {
    const previous = { afterCreate: undefined, verify: { lint: "pnpm lint" } };
    const next = {
      afterCreate: undefined,
      verify: { lint: "pnpm lint", test: "pnpm test" },
    };

    expect(declareRegressions(previous, next)).toEqual([]);
  });

  it("names a previously declared command missing from the new contract", () => {
    const previous = {
      afterCreate: undefined,
      verify: { lint: "pnpm lint", test: "pnpm test" },
    };
    const next = { afterCreate: undefined, verify: { lint: "pnpm lint" } };

    expect(declareRegressions(previous, next)).toEqual(["test"]);
  });

  it("is empty when there was no previous contract", () => {
    const next = { afterCreate: undefined, verify: { lint: "pnpm lint" } };

    expect(declareRegressions(EMPTY_CONTRACT, next)).toEqual([]);
  });

  it("names every previously declared command the new contract drops", () => {
    const previous = {
      afterCreate: undefined,
      verify: { lint: "pnpm lint", test: "pnpm test", build: "pnpm build" },
    };

    expect(declareRegressions(previous, EMPTY_CONTRACT)).toEqual([
      "lint",
      "test",
      "build",
    ]);
  });
});

describe("renderDeclareReport", () => {
  it("reports an empty contract as none qualified, with no excluded section", () => {
    const report = renderDeclareReport(outcome());

    expect(report).toContain(
      "(none — no candidate command both existed and passed)",
    );
    expect(report).not.toContain("Excluded:");
    expect(report).not.toContain("Warning:");
  });

  it("lists every declared command by name and its exact command string", () => {
    const report = renderDeclareReport(
      outcome({
        contract: {
          afterCreate: undefined,
          verify: { lint: "pnpm lint", test: "pnpm test" },
        },
      }),
    );

    expect(report).toContain("lint: pnpm lint");
    expect(report).toContain("test: pnpm test");
  });

  it("lists every excluded candidate with its reason", () => {
    const report = renderDeclareReport(
      outcome({
        excluded: [{ name: "e2e", reason: "does not exist" }],
      }),
    );

    expect(report).toContain("Excluded:");
    expect(report).toContain("e2e — does not exist");
  });

  it("warns when the session hit its wall-clock timeout", () => {
    const report = renderDeclareReport(outcome({ endedBy: "timeout" }));

    expect(report).toContain("Warning:");
    expect(report).toContain("wall-clock timeout");
  });

  it("leads with the warning and flags the contract below as possibly stale when the session did not finish cleanly", () => {
    const report = renderDeclareReport(
      outcome({
        endedBy: "timeout",
        contract: { afterCreate: undefined, verify: { lint: "pnpm lint" } },
      }),
    );

    expect(report.indexOf("Warning:")).toBeLessThan(
      report.indexOf("Declared verify contract:"),
    );
    expect(report).toContain("may be stale");
  });

  it("warns when the session stalled", () => {
    const report = renderDeclareReport(outcome({ endedBy: "stall" }));

    expect(report).toContain("stopped as stalled");
  });

  it("warns when the session exited non-zero", () => {
    const report = renderDeclareReport(outcome({ exitCode: 1 }));

    expect(report).toContain("exited with code 1");
  });

  it("warns when spend exceeded the cost cap", () => {
    const report = renderDeclareReport(
      outcome({ costUsd: 25, costOverrun: true }),
    );

    expect(report).toContain("spend $25.00 exceeded the cost cap");
  });

  it("carries no warning for a clean, in-budget run", () => {
    const report = renderDeclareReport(outcome());

    expect(report).not.toContain("Warning:");
  });

  it("leads with every regressed command, ahead of the declared contract", () => {
    const report = renderDeclareReport(
      outcome({
        regressions: ["test"],
        contract: { afterCreate: undefined, verify: { lint: "pnpm lint" } },
      }),
    );

    expect(report).toContain("Regression — WORKFLOW.md left unchanged:");
    expect(report).toContain("test was declared and now fails");
    expect(report.indexOf("Regression")).toBeLessThan(
      report.indexOf("Declared verify contract:"),
    );
  });

  it("names every regressed command when more than one broke", () => {
    const report = renderDeclareReport(
      outcome({ regressions: ["lint", "test"] }),
    );

    expect(report).toContain("lint was declared and now fails");
    expect(report).toContain("test was declared and now fails");
  });

  it("carries no regression section for a normal run", () => {
    const report = renderDeclareReport(outcome());

    expect(report).not.toContain("Regression");
  });
});

describe("declareTroubled", () => {
  it("is false for a clean exit", () => {
    expect(declareTroubled(outcome())).toBe(false);
  });

  it.each(["timeout", "stall"] as const)(
    "is true when the session ended by %s",
    (endedBy) => {
      expect(declareTroubled(outcome({ endedBy }))).toBe(true);
    },
  );

  it("is true for a non-zero exit code", () => {
    expect(declareTroubled(outcome({ exitCode: 1 }))).toBe(true);
  });

  it("is false for a cost overrun alone — an alarm, not a failure", () => {
    expect(declareTroubled(outcome({ costUsd: 25, costOverrun: true }))).toBe(
      false,
    );
  });
});

describe("declareRefused", () => {
  it("is false when nothing regressed", () => {
    expect(declareRefused(outcome())).toBe(false);
  });

  it("is true when the contract's rewrite was refused over a regression", () => {
    expect(declareRefused(outcome({ regressions: ["test"] }))).toBe(true);
  });
});
