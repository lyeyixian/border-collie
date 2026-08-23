import { describe, expect, it } from "vitest";
import {
  type DeclareExclusion,
  type DeclareOutcome,
  DeclareSidecarError,
  declareFailed,
  declareRefused,
  declareRegressions,
  declareTroubled,
  findRedBaselineIssue,
  parseDeclareSidecar,
  parseRedBaselineMarker,
  redBaselineBody,
  redBaselineCreateCommand,
  redBaselineMarker,
  redBaselineTitle,
  renderDeclareReport,
  type TrackerIssueRef,
} from "../../src/core/declare.js";
import { EMPTY_CONTRACT } from "../../src/core/workflow.js";

describe("parseDeclareSidecar", () => {
  it("parses an object with an excluded array of {name, kind, reason} entries", () => {
    const sidecar = parseDeclareSidecar(
      JSON.stringify({
        excluded: [
          { name: "e2e", kind: "missing", reason: "does not exist" },
          { name: "build", kind: "red", reason: "exits 1" },
        ],
      }),
    );

    expect(sidecar.excluded).toEqual([
      { name: "e2e", kind: "missing", reason: "does not exist" },
      { name: "build", kind: "red", reason: "exits 1" },
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
      parseDeclareSidecar(
        JSON.stringify({ excluded: [{ name: "build", kind: "red" }] }),
      ),
    ).toThrow(DeclareSidecarError);
  });

  it("rejects an excluded entry missing name", () => {
    expect(() =>
      parseDeclareSidecar(
        JSON.stringify({ excluded: [{ kind: "red", reason: "exits 1" }] }),
      ),
    ).toThrow(DeclareSidecarError);
  });

  it("rejects an excluded entry with an unrecognised kind", () => {
    expect(() =>
      parseDeclareSidecar(
        JSON.stringify({
          excluded: [{ name: "build", kind: "flaky", reason: "exits 1" }],
        }),
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
    redBaselines: [],
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
        excluded: [{ name: "e2e", kind: "missing", reason: "does not exist" }],
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

  it("has no red baselines section when none were excluded as red", () => {
    const report = renderDeclareReport(outcome());

    expect(report).not.toContain("Red baselines:");
  });

  it("lists a filed red baseline with its issue number", () => {
    const report = renderDeclareReport(
      outcome({
        redBaselines: [{ command: "build", outcome: "filed", issue: 42 }],
      }),
    );

    expect(report).toContain("Red baselines:");
    expect(report).toContain("build — filed as #42");
  });

  it("lists an already-recorded red baseline with its issue number", () => {
    const report = renderDeclareReport(
      outcome({
        redBaselines: [
          { command: "lint", outcome: "already-recorded", issue: 7 },
        ],
      }),
    );

    expect(report).toContain("lint — already recorded as #7");
  });

  it("reports a failed filing with the hand-run command, keyed off the exclusion it came from", () => {
    const report = renderDeclareReport(
      outcome({
        excluded: [{ name: "build", kind: "red", reason: "exits 1" }],
        redBaselines: [
          { command: "build", outcome: "failed", error: "no `gh` on PATH" },
        ],
      }),
    );

    expect(report).toContain("build — failed");
    expect(report).toContain("no `gh` on PATH");
    expect(report).toContain("File them by hand:");
    expect(report).toContain("gh issue create");
    expect(report).toContain("red baseline: build");
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

describe("declareFailed", () => {
  it("is false for a clean run with nothing regressed", () => {
    expect(declareFailed(outcome())).toBe(false);
  });

  it("is true when the session itself did not finish cleanly", () => {
    expect(declareFailed(outcome({ exitCode: 1 }))).toBe(true);
  });

  it("is true when the contract's rewrite was refused over a regression", () => {
    expect(declareFailed(outcome({ regressions: ["test"] }))).toBe(true);
  });
});

describe("redBaselineMarker / parseRedBaselineMarker", () => {
  it("round-trips the command the marker names", () => {
    const body = `some prose\n${redBaselineMarker("build")}\nmore prose`;

    expect(parseRedBaselineMarker(body)).toBe("build");
  });

  it("is undefined when the body carries no marker", () => {
    expect(
      parseRedBaselineMarker("just an ordinary issue body"),
    ).toBeUndefined();
  });

  it("is undefined when the marker is present but mangled", () => {
    expect(
      parseRedBaselineMarker("<!-- border-collie:red-baseline not json -->"),
    ).toBeUndefined();
  });

  it("names a different command for a different marker", () => {
    expect(parseRedBaselineMarker(redBaselineMarker("lint"))).toBe("lint");
  });
});

describe("findRedBaselineIssue", () => {
  const exclusion: DeclareExclusion = {
    name: "build",
    kind: "red",
    reason: "exits 1",
  };

  function issueRef(number: number, command: string): TrackerIssueRef {
    return { number, body: redBaselineMarker(command) };
  }

  it("finds the issue whose marker names the command", () => {
    const issues = [issueRef(1, "lint"), issueRef(2, "build")];

    expect(findRedBaselineIssue(issues, "build")).toBe(2);
  });

  it("is undefined when no open issue carries a marker for the command", () => {
    expect(
      findRedBaselineIssue([issueRef(1, "lint")], "build"),
    ).toBeUndefined();
  });

  it("ignores an issue whose body carries no marker at all", () => {
    const issues: TrackerIssueRef[] = [{ number: 3, body: "unrelated issue" }];

    expect(findRedBaselineIssue(issues, "build")).toBeUndefined();
  });

  it("builds a title and body naming the command, marker embedded", () => {
    expect(redBaselineTitle(exclusion.name)).toContain("build");

    const body = redBaselineBody(exclusion);
    expect(body).toContain(redBaselineMarker("build"));
    expect(body).toContain("exits 1");
  });
});

describe("redBaselineCreateCommand", () => {
  it("names a gh issue create command carrying the title and the marker-bearing body, single-quoted", () => {
    const command = redBaselineCreateCommand({
      name: "build",
      kind: "red",
      reason: "exits 1",
    });

    expect(command).toContain("gh issue create");
    expect(command).toContain(`--title '${redBaselineTitle("build")}'`);
    // Single-quoted, not JSON-escaped: the marker and the backtick-carrying
    // prose appear verbatim rather than as \" / \n escapes a shell would not
    // undo, and the backticks never sit inside a double-quoted argument
    // where bash would read them as command substitution.
    expect(command).toContain(redBaselineMarker("build"));
    expect(command).toContain("`build`");
    expect(command).not.toContain('\\"');
  });

  it("escapes a single quote in the exclusion's own reason so the shell still takes it as one argument", () => {
    const command = redBaselineCreateCommand({
      name: "build",
      kind: "red",
      reason: "can't find the binary",
    });

    expect(command).toContain("can'\\''t find the binary");
  });
});
