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
        hasAgentClaim: false,
      },
      {
        number: 3,
        title: "Claiming",
        state: "open",
        assignees: [],
        labels: ["ready-for-agent"],
        openBlockers: 1,
        hasAgentClaim: false,
      },
      {
        number: 4,
        title: "Done already",
        state: "closed",
        assignees: [],
        labels: ["ready-for-agent"],
        openBlockers: 0,
        hasAgentClaim: false,
      },
    ],
    openAgentPrTickets: [],
  };

  it("shows the scope, the dispatchable set, and the planned claims", () => {
    const actions = plan(world, { maxWorkers: 3 });

    const config = { scope: { kind: "parent", parent: 1 } as const, maxWorkers: 3 };

    expect(renderPlan(config, world, actions, { dryRun: true })).toBe(
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
    const empty: WorldSnapshot = { tickets: [], openAgentPrTickets: [] };

    expect(renderPlan({ scope: { kind: "all" }, maxWorkers: 3 }, empty, [], { dryRun: true })).toBe(
      [
        "Scope: repo-wide (--all) — 0 tickets (0 open)",
        "Dispatchable: none",
        "Plan (max_workers=3): nothing to do",
        "Dry run: no writes performed.",
      ].join("\n"),
    );
  });

  it("shows planned releases and drops the dry-run footer when acting", () => {
    const orphaned: WorldSnapshot = {
      tickets: [
        {
          number: 5,
          title: "Stranded by a crash",
          state: "open",
          assignees: ["operator"],
          labels: ["ready-for-agent"],
          openBlockers: 0,
          hasAgentClaim: true,
        },
      ],
      openAgentPrTickets: [],
    };
    const actions = plan(orphaned, { maxWorkers: 3 });

    expect(
      renderPlan({ scope: { kind: "parent", parent: 1 }, maxWorkers: 3 }, orphaned, actions, {
        dryRun: false,
      }),
    ).toBe(
      [
        "Scope: sub-issues of #1 — 1 tickets (1 open)",
        "Dispatchable: none",
        "Plan (max_workers=3):",
        "  release #5 — Stranded by a crash (orphaned agent claim)",
      ].join("\n"),
    );
  });
});
