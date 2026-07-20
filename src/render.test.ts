import { describe, expect, it } from "vitest";
import { renderPlan } from "./render.js";
import { plan } from "./plan.js";
import type { ResolvedConfig } from "./config.js";
import type { Ticket, WorldSnapshot } from "./types.js";

function ticket(overrides: Partial<Ticket> & { number: number; title: string }): Ticket {
  return {
    state: "open",
    assignees: [],
    labels: ["ready-for-agent"],
    openBlockers: 0,
    hasAgentClaim: false,
    agentClaimCount: 0,
    attemptFailures: [],
    ...overrides,
  };
}

function config(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    scope: { kind: "parent", parent: 1 },
    maxWorkers: 3,
    model: "sonnet",
    retryModel: "opus",
    timeoutMinutes: 45,
    stallMinutes: 10,
    ...overrides,
  };
}

describe("renderPlan", () => {
  const world: WorldSnapshot = {
    tickets: [
      ticket({ number: 2, title: "Walking skeleton" }),
      ticket({ number: 3, title: "Claiming", openBlockers: 1 }),
      ticket({ number: 4, title: "Done already", state: "closed" }),
    ],
    openAgentPrTickets: [],
  };

  it("shows the scope, the dispatchable set, and the planned claims and spawns", () => {
    const actions = plan(world, { maxWorkers: 3 });

    expect(renderPlan(config(), world, actions, { dryRun: true })).toBe(
      [
        "Scope: sub-issues of #1 — 3 tickets (2 open)",
        "Dispatchable: #2",
        "Plan (max_workers=3):",
        "  claim #2 — Walking skeleton",
        "  spawn Worker for #2 — Walking skeleton (model sonnet, attempt 1)",
        "Dry run: no writes performed.",
      ].join("\n"),
    );
  });

  it("says so when nothing is dispatchable", () => {
    const empty: WorldSnapshot = { tickets: [], openAgentPrTickets: [] };

    expect(
      renderPlan(config({ scope: { kind: "all" } }), empty, [], { dryRun: true }),
    ).toBe(
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
        ticket({
          number: 5,
          title: "Stranded by a crash",
          assignees: ["operator"],
          hasAgentClaim: true,
        }),
      ],
      openAgentPrTickets: [],
    };
    const actions = plan(orphaned, { maxWorkers: 3 });

    expect(renderPlan(config(), orphaned, actions, { dryRun: false })).toBe(
      [
        "Scope: sub-issues of #1 — 1 tickets (1 open)",
        "Dispatchable: none",
        "Plan (max_workers=3):",
        "  release #5 — Stranded by a crash (orphaned agent claim)",
      ].join("\n"),
    );
  });

  it("shows the retry model on second attempts and planned escalations", () => {
    const laddered: WorldSnapshot = {
      tickets: [
        ticket({ number: 6, title: "Failed once", agentClaimCount: 1 }),
        ticket({ number: 7, title: "Failed twice", agentClaimCount: 2 }),
      ],
      openAgentPrTickets: [],
    };
    const actions = plan(laddered, { maxWorkers: 3 });

    expect(renderPlan(config(), laddered, actions, { dryRun: true })).toBe(
      [
        "Scope: sub-issues of #1 — 2 tickets (2 open)",
        "Dispatchable: #6, #7",
        "Plan (max_workers=3):",
        "  escalate #7 — Failed twice (attempts exhausted → ready-for-human)",
        "  claim #6 — Failed once",
        "  spawn Worker for #6 — Failed once (model opus, attempt 2)",
        "Dry run: no writes performed.",
      ].join("\n"),
    );
  });
});
