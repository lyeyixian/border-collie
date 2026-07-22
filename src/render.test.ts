import { describe, expect, it } from "vitest";
import { renderPlan, renderStuck } from "./render.js";
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
    maxOpenPrs: 5,
    pollSeconds: 30,
    model: "sonnet",
    retryModel: "opus",
    timeoutMinutes: 45,
    stallMinutes: 10,
    maxTurns: 200,
    maxCostUsd: 20,
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
    mergedAgentPrs: [],
  };

  it("shows the scope, the dispatchable set, and the planned claims and spawns", () => {
    const actions = plan(world, { maxWorkers: 3, maxOpenPrs: 5 });

    expect(renderPlan(config(), world, actions, { dryRun: true })).toBe(
      [
        "Scope: sub-issues of #1 — 3 tickets (2 open)",
        "Dispatchable: #2",
        "Plan (max_workers=3, max_open_prs=5):",
        "  claim #2 — Walking skeleton",
        "  spawn Worker for #2 — Walking skeleton (model sonnet, attempt 1)",
        "Dry run: no writes performed.",
      ].join("\n"),
    );
  });

  it("says so when nothing is dispatchable", () => {
    const empty: WorldSnapshot = { tickets: [], openAgentPrTickets: [], mergedAgentPrs: [] };

    expect(
      renderPlan(config({ scope: { kind: "all" } }), empty, [], { dryRun: true }),
    ).toBe(
      [
        "Scope: repo-wide (--all) — 0 tickets (0 open)",
        "Dispatchable: none",
        "Plan (max_workers=3, max_open_prs=5): nothing to do",
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
      mergedAgentPrs: [],
    };
    const actions = plan(orphaned, { maxWorkers: 3, maxOpenPrs: 5 });

    expect(renderPlan(config(), orphaned, actions, { dryRun: false })).toBe(
      [
        "Scope: sub-issues of #1 — 1 tickets (1 open)",
        "Dispatchable: none",
        "Plan (max_workers=3, max_open_prs=5):",
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
      mergedAgentPrs: [],
    };
    const actions = plan(laddered, { maxWorkers: 3, maxOpenPrs: 5 });

    expect(renderPlan(config(), laddered, actions, { dryRun: true })).toBe(
      [
        "Scope: sub-issues of #1 — 2 tickets (2 open)",
        "Dispatchable: #6, #7",
        "Plan (max_workers=3, max_open_prs=5):",
        "  escalate #7 — Failed twice (attempts exhausted → ready-for-human)",
        "  claim #6 — Failed once",
        "  spawn Worker for #6 — Failed once (model opus, attempt 2)",
        "Dry run: no writes performed.",
      ].join("\n"),
    );
  });

  it("shows planned closes with the merged PR", () => {
    const merged: WorldSnapshot = {
      tickets: [
        ticket({
          number: 6,
          title: "Merged but open",
          assignees: ["operator"],
          hasAgentClaim: true,
        }),
      ],
      openAgentPrTickets: [],
      mergedAgentPrs: [{ ticket: 6, url: "https://github.com/o/r/pull/60" }],
    };
    const actions = plan(merged, { maxWorkers: 3, maxOpenPrs: 5 });

    expect(renderPlan(config(), merged, actions, { dryRun: false })).toBe(
      [
        "Scope: sub-issues of #1 — 1 tickets (1 open)",
        "Dispatchable: none",
        "Plan (max_workers=3, max_open_prs=5):",
        "  close #6 — Merged but open (merged: https://github.com/o/r/pull/60)",
      ].join("\n"),
    );
  });

  it("notes paused dispatch when dispatchable tickets wait on max_open_prs headroom", () => {
    const throttled: WorldSnapshot = {
      ...world,
      openAgentPrTickets: [10, 11, 12, 13, 14],
    };
    const actions = plan(throttled, { maxWorkers: 3, maxOpenPrs: 5 });

    expect(renderPlan(config(), throttled, actions, { dryRun: false })).toBe(
      [
        "Scope: sub-issues of #1 — 3 tickets (2 open)",
        "Dispatchable: #2",
        "Dispatch paused: 5 open agent PRs at max_open_prs (5)",
        "Plan (max_workers=3, max_open_prs=5): nothing to do",
      ].join("\n"),
    );
  });

  it("notes the open circuit breaker when dispatch is paused for infrastructure failure", () => {
    const actions = plan(world, { maxWorkers: 3, maxOpenPrs: 5, dispatchPaused: true });

    expect(renderPlan(config(), world, actions, { dryRun: false, dispatchPaused: true })).toBe(
      [
        "Scope: sub-issues of #1 — 3 tickets (2 open)",
        "Dispatchable: #2",
        "Dispatch paused: circuit breaker open (infrastructure failure), claims held",
        "Plan (max_workers=3, max_open_prs=5): nothing to do",
      ].join("\n"),
    );
  });
});

describe("renderStuck", () => {
  it("names each open ticket and why it cannot move without a human", () => {
    const report = renderStuck([
      ticket({ number: 7, title: "Escalated", labels: ["ready-for-human"] }),
      ticket({
        number: 8,
        title: "A colleague's work",
        assignees: ["some-human"],
        openBlockers: 1,
      }),
    ]);

    expect(report).toBe(
      [
        "Run Stuck: open tickets remain, but every path forward runs through a human.",
        "  #7 — Escalated (not labelled ready-for-agent)",
        "  #8 — A colleague's work (claimed by some-human; 1 open blocker)",
      ].join("\n"),
    );
  });
});
