import { describe, expect, it } from "vitest";
import { renderPlan } from "./render.js";
import { plan } from "./plan.js";
import type { WorldSnapshot } from "./types.js";

describe("renderPlan", () => {
  const world: WorldSnapshot = {
    tickets: [
      {
        number: 2,
        title: "Walking skeleton",
        state: "open",
        assignees: [],
        labels: ["ready-for-agent"],
        openBlockers: 0,
      },
      {
        number: 3,
        title: "Claiming",
        state: "open",
        assignees: [],
        labels: ["ready-for-agent"],
        openBlockers: 1,
      },
      {
        number: 4,
        title: "Done already",
        state: "closed",
        assignees: [],
        labels: ["ready-for-agent"],
        openBlockers: 0,
      },
    ],
  };

  it("shows the scope, the dispatchable set, and the planned claims", () => {
    const actions = plan(world, { maxWorkers: 3 });

    const config = { scope: { kind: "parent", parent: 1 } as const, maxWorkers: 3 };

    expect(renderPlan(config, world, actions)).toBe(
      [
        "Scope: sub-issues of #1 — 3 tickets (2 open)",
        "Dispatchable: #2",
        "Plan (max_workers=3):",
        "  claim #2 — Walking skeleton",
        "Dry run: no writes performed.",
      ].join("\n"),
    );
  });

  it("says so when nothing is dispatchable", () => {
    const empty: WorldSnapshot = { tickets: [] };

    expect(renderPlan({ scope: { kind: "all" }, maxWorkers: 3 }, empty, [])).toBe(
      [
        "Scope: repo-wide (--all) — 0 tickets (0 open)",
        "Dispatchable: none",
        "Plan (max_workers=3): nothing to do",
        "Dry run: no writes performed.",
      ].join("\n"),
    );
  });
});
