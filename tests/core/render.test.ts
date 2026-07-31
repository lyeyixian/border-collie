import { describe, expect, it } from "vitest";
import type { ResolvedConfig } from "../../src/core/config.js";
import type { WorkerHeartbeat } from "../../src/core/heartbeat.js";
import {
  buildCompleteReport,
  buildPlanReport,
  buildStuckReport,
  type CompleteReport,
  type PlanReport,
  renderCompleteReport,
  renderHeartbeat,
  renderPlanReport,
  renderStuckReport,
  type StuckReport,
} from "../../src/core/render.js";
import type {
  Action,
  OpenAgentPr,
  Ticket,
  WorldSnapshot,
} from "../../src/core/types.js";

function ticket(
  overrides: Partial<Ticket> & { number: number; title: string },
): Ticket {
  return {
    state: "open",
    assignees: [],
    labels: ["ready-for-agent"],
    openBlockers: 0,
    blockedBy: [],
    hasAgentClaim: false,
    agentClaimCount: 0,
    attemptFailures: [],
    ...overrides,
  };
}

function openPr(ticket: number): OpenAgentPr {
  return {
    number: ticket * 10,
    ticket,
    headRef: `border-collie/ticket-${ticket}-attempt-1`,
    draft: false,
    mergeable: "mergeable",
    behind: false,
    ci: "passing",
    conflictWorkerAsked: false,
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

function stuckWorld(tickets: Ticket[]): WorldSnapshot {
  return { tickets, openAgentPrs: [], mergedAgentPrs: [] };
}

describe("buildPlanReport", () => {
  const world: WorldSnapshot = {
    tickets: [
      ticket({ number: 2, title: "Walking skeleton" }),
      ticket({ number: 3, title: "Claiming", openBlockers: 1 }),
      ticket({ number: 4, title: "Done already", state: "closed" }),
    ],
    openAgentPrs: [],
    mergedAgentPrs: [],
  };

  it("computes the scope label, ticket totals, the dispatchable set, and carries dryRun", () => {
    const report = buildPlanReport(config(), world, [], { dryRun: true });

    expect(report.scopeLabel).toBe("sub-issues of #1");
    expect(report.totalTickets).toBe(3);
    expect(report.openTickets).toBe(2);
    expect(report.dispatchable).toEqual([2]);
    expect(report.dryRun).toBe(true);
  });

  it("labels repo-wide scope for --all", () => {
    const empty: WorldSnapshot = {
      tickets: [],
      openAgentPrs: [],
      mergedAgentPrs: [],
    };

    const report = buildPlanReport(
      config({ scope: { kind: "all" } }),
      empty,
      [],
      { dryRun: true },
    );

    expect(report.scopeLabel).toBe("repo-wide (--all)");
  });

  it("reports no pause when nothing throttles dispatch", () => {
    const report = buildPlanReport(config(), world, [], { dryRun: true });

    expect(report.paused).toBeNull();
  });

  it("reports a breaker pause while the circuit breaker holds dispatch", () => {
    const report = buildPlanReport(config(), world, [], {
      dryRun: false,
      dispatchPaused: true,
    });

    expect(report.paused).toEqual({ kind: "breaker" });
  });

  it("reports a working-hours pause when a dispatchable ticket waits on the off-hours window", () => {
    const report = buildPlanReport(config(), world, [], {
      dryRun: false,
      withinWorkingHours: true,
    });

    expect(report.paused).toEqual({ kind: "working-hours" });
  });

  it("does not report a working-hours pause when nothing is dispatchable", () => {
    const noDispatch: WorldSnapshot = {
      tickets: [ticket({ number: 4, title: "Done already", state: "closed" })],
      openAgentPrs: [],
      mergedAgentPrs: [],
    };

    const report = buildPlanReport(config(), noDispatch, [], {
      dryRun: false,
      withinWorkingHours: true,
    });

    expect(report.paused).toBeNull();
  });

  it("prefers the breaker pause over working hours when both apply", () => {
    const report = buildPlanReport(config(), world, [], {
      dryRun: false,
      dispatchPaused: true,
      withinWorkingHours: true,
    });

    expect(report.paused).toEqual({ kind: "breaker" });
  });

  it("reports a max_open_prs pause when dispatchable tickets wait on headroom", () => {
    const throttled: WorldSnapshot = {
      ...world,
      openAgentPrs: [10, 11, 12, 13, 14].map(openPr),
    };

    const report = buildPlanReport(config(), throttled, [], {
      dryRun: false,
    });

    expect(report.paused).toEqual({ kind: "max-open-prs", openCount: 5 });
  });

  it("does not report a pause when nothing is dispatchable, even at max_open_prs", () => {
    const noDispatch: WorldSnapshot = {
      tickets: [ticket({ number: 4, title: "Done already", state: "closed" })],
      openAgentPrs: [10, 11, 12, 13, 14].map(openPr),
      mergedAgentPrs: [],
    };

    const report = buildPlanReport(config(), noDispatch, [], {
      dryRun: false,
    });

    expect(report.paused).toBeNull();
  });

  it("resolves every action kind to a structured line, including the retry-ladder model", () => {
    const actionWorld: WorldSnapshot = {
      tickets: [
        ticket({ number: 2, title: "Walking skeleton" }),
        ticket({ number: 3, title: "Stranded" }),
        ticket({ number: 4, title: "Failed twice" }),
        ticket({ number: 5, title: "Merged but open" }),
        ticket({ number: 6, title: "Behind base" }),
        ticket({ number: 7, title: "Green draft" }),
      ],
      openAgentPrs: [],
      mergedAgentPrs: [],
    };
    const actions: Action[] = [
      { type: "claim", ticket: 2 },
      { type: "release", ticket: 3 },
      { type: "spawn", ticket: 2, attempt: 2 },
      { type: "escalate", ticket: 4, failures: [] },
      { type: "close", ticket: 5, prUrl: "https://github.com/o/r/pull/50" },
      { type: "update-branch", pr: 60, ticket: 6 },
      {
        type: "conflict-worker",
        pr: 61,
        ticket: 6,
        headRef: "border-collie/ticket-6-attempt-1",
      },
      { type: "mark-ready", pr: 70, ticket: 7 },
    ];

    const report = buildPlanReport(config(), actionWorld, actions, {
      dryRun: true,
    });

    expect(report.actions).toEqual([
      { type: "claim", ticket: 2, title: "Walking skeleton" },
      { type: "release", ticket: 3, title: "Stranded" },
      {
        type: "spawn",
        ticket: 2,
        title: "Walking skeleton",
        model: "opus",
        attempt: 2,
      },
      { type: "escalate", ticket: 4, title: "Failed twice" },
      {
        type: "close",
        ticket: 5,
        title: "Merged but open",
        prUrl: "https://github.com/o/r/pull/50",
      },
      { type: "update-branch", pr: 60, title: "Behind base" },
      { type: "conflict-worker", pr: 61, title: "Behind base" },
      { type: "mark-ready", pr: 70, title: "Green draft" },
    ]);
  });

  it("falls back to an empty title when a ticket isn't in the world snapshot", () => {
    const report = buildPlanReport(
      config(),
      { tickets: [], openAgentPrs: [], mergedAgentPrs: [] },
      [{ type: "claim", ticket: 999 }],
      { dryRun: true },
    );

    expect(report.actions).toEqual([{ type: "claim", ticket: 999, title: "" }]);
  });
});

describe("renderPlanReport", () => {
  it("renders the working-hours pause notice, distinct from the breaker's", () => {
    const report: PlanReport = {
      scopeLabel: "sub-issues of #1",
      totalTickets: 2,
      openTickets: 1,
      dispatchable: [2],
      paused: { kind: "working-hours" },
      maxWorkers: 3,
      maxOpenPrs: 5,
      actions: [],
      dryRun: false,
    };

    expect(renderPlanReport(report)).toBe(
      [
        "Scope: sub-issues of #1 — 2 tickets (1 open)",
        "Dispatchable: #2",
        "Dispatch paused: within working hours — claims, spawns, and Conflict Workers wait for the off-hours window",
        "Plan (max_workers=3, max_open_prs=5): nothing to do",
      ].join("\n"),
    );
  });

  it("renders the familiar unadorned block: header lines, one line per action kind, the paused notice, the dry-run footer", () => {
    const report: PlanReport = {
      scopeLabel: "sub-issues of #1",
      totalTickets: 5,
      openTickets: 4,
      dispatchable: [2, 6],
      paused: { kind: "max-open-prs", openCount: 5 },
      maxWorkers: 3,
      maxOpenPrs: 5,
      actions: [
        { type: "claim", ticket: 2, title: "Walking skeleton" },
        { type: "release", ticket: 3, title: "Stranded" },
        {
          type: "spawn",
          ticket: 2,
          title: "Walking skeleton",
          model: "sonnet",
          attempt: 1,
        },
        { type: "escalate", ticket: 7, title: "Failed twice" },
        {
          type: "close",
          ticket: 6,
          title: "Merged but open",
          prUrl: "https://github.com/o/r/pull/60",
        },
        { type: "update-branch", pr: 50, title: "Behind base" },
        { type: "conflict-worker", pr: 60, title: "Conflicted" },
        { type: "mark-ready", pr: 70, title: "Green draft" },
      ],
      dryRun: true,
    };

    expect(renderPlanReport(report)).toBe(
      [
        "Scope: sub-issues of #1 — 5 tickets (4 open)",
        "Dispatchable: #2, #6",
        "Dispatch paused: 5 open agent PRs at max_open_prs (5)",
        "Plan (max_workers=3, max_open_prs=5):",
        "  claim #2 — Walking skeleton",
        "  release #3 — Stranded (orphaned agent claim)",
        "  spawn Worker for #2 — Walking skeleton (model sonnet, attempt 1)",
        "  escalate #7 — Failed twice (attempts exhausted → ready-for-human)",
        "  close #6 — Merged but open (merged: https://github.com/o/r/pull/60)",
        "  update PR #50 — Behind base (behind base, mechanical rebase)",
        "  conflict Worker for PR #60 — Conflicted (resolve merge conflicts)",
        "  mark PR #70 ready — Green draft (CI green)",
        "Dry run: no writes performed.",
      ].join("\n"),
    );
  });
});

describe("buildStuckReport", () => {
  it("includes only open tickets", () => {
    const report = buildStuckReport(
      stuckWorld([
        ticket({ number: 2, title: "Open one" }),
        ticket({ number: 3, title: "Closed one", state: "closed" }),
      ]),
    );

    expect(report.tickets.map((t) => t.ticket)).toEqual([2]);
  });

  it("flags a human claim", () => {
    const report = buildStuckReport(
      stuckWorld([
        ticket({
          number: 9,
          title: "A colleague's work",
          assignees: ["some-human"],
        }),
      ]),
    );

    expect(report.tickets[0]?.reasons).toEqual([
      { kind: "human-claim", assignees: ["some-human"] },
    ]);
  });

  it("flags labelled ready-for-human distinctly from a missing ready-for-agent label", () => {
    const escalated = buildStuckReport(
      stuckWorld([
        ticket({ number: 7, title: "Escalated", labels: ["ready-for-human"] }),
      ]),
    );
    const untriaged = buildStuckReport(
      stuckWorld([
        ticket({ number: 4, title: "Untriaged", labels: ["needs-triage"] }),
      ]),
    );

    expect(escalated.tickets[0]?.reasons).toEqual([
      { kind: "ready-for-human" },
    ]);
    expect(untriaged.tickets[0]?.reasons).toEqual([
      { kind: "not-ready-for-agent" },
    ]);
  });

  it("names each blocker, flagging ones outside Scope", () => {
    const report = buildStuckReport(
      stuckWorld([
        ticket({ number: 7, title: "Escalated", labels: ["ready-for-human"] }),
        ticket({
          number: 8,
          title: "Downstream",
          openBlockers: 2,
          blockedBy: [7, 99],
        }),
      ]),
    );
    const downstream = report.tickets.find((t) => t.ticket === 8);

    expect(downstream?.reasons).toEqual([
      {
        kind: "blocked-by",
        blockers: [
          { ticket: 7, inScope: true },
          { ticket: 99, inScope: false },
        ],
      },
    ]);
  });

  it("falls back to the blocker count when the blocker list is missing", () => {
    const report = buildStuckReport(
      stuckWorld([
        ticket({ number: 8, title: "Blocked blind", openBlockers: 2 }),
      ]),
    );

    expect(report.tickets[0]?.reasons).toEqual([
      { kind: "blocked-count", count: 2 },
    ]);
  });

  it("combines multiple reasons for one ticket", () => {
    const report = buildStuckReport(
      stuckWorld([
        ticket({
          number: 9,
          title: "Multi",
          assignees: ["operator"],
          labels: ["needs-triage"],
          openBlockers: 1,
          blockedBy: [5],
        }),
      ]),
    );

    expect(report.tickets[0]?.reasons).toEqual([
      { kind: "human-claim", assignees: ["operator"] },
      { kind: "not-ready-for-agent" },
      { kind: "blocked-by", blockers: [{ ticket: 5, inScope: false }] },
    ]);
  });

  it("reports no reasons when nothing is found — the renderer's fallback case", () => {
    const report = buildStuckReport(
      stuckWorld([ticket({ number: 10, title: "Mystery" })]),
    );

    expect(report.tickets[0]?.reasons).toEqual([]);
  });
});

describe("renderHeartbeat", () => {
  it("renders elapsed time and time since output per Worker, on one line", () => {
    const workers: WorkerHeartbeat[] = [
      { ticket: 2, attempt: 1, elapsedMs: 125_000, sinceOutputMs: 5_000 },
      { ticket: 4, attempt: 2, elapsedMs: 60_000, sinceOutputMs: 60_000 },
    ];

    expect(renderHeartbeat(workers)).toBe(
      "Heartbeat: 2 Workers in flight — " +
        "#2 attempt 1 (elapsed 2m5s, since output 5s), " +
        "#4 attempt 2 (elapsed 1m0s, since output 1m0s)",
    );
  });

  it("uses the singular for exactly one Worker", () => {
    const workers: WorkerHeartbeat[] = [
      { ticket: 7, attempt: 1, elapsedMs: 30_000, sinceOutputMs: 0 },
    ];

    expect(renderHeartbeat(workers)).toBe(
      "Heartbeat: 1 Worker in flight — #7 attempt 1 (elapsed 30s, since output 0s)",
    );
  });
});

describe("renderStuckReport", () => {
  it("renders the familiar unadorned block, joining multiple reasons and falling back for none", () => {
    const report: StuckReport = {
      tickets: [
        {
          ticket: 7,
          title: "Escalated",
          reasons: [{ kind: "ready-for-human" }],
        },
        {
          ticket: 8,
          title: "Downstream",
          reasons: [
            {
              kind: "blocked-by",
              blockers: [
                { ticket: 7, inScope: true },
                { ticket: 99, inScope: false },
              ],
            },
          ],
        },
        {
          ticket: 9,
          title: "A colleague's work",
          reasons: [
            { kind: "human-claim", assignees: ["some-human"] },
            { kind: "not-ready-for-agent" },
          ],
        },
        {
          ticket: 10,
          title: "Blocked blind",
          reasons: [{ kind: "blocked-count", count: 2 }],
        },
        { ticket: 11, title: "Unexplained", reasons: [] },
      ],
    };

    expect(renderStuckReport(report)).toBe(
      [
        "Run Stuck: open tickets remain, but every path forward runs through a human.",
        "  #7 — Escalated (labelled ready-for-human)",
        "  #8 — Downstream (blocked by #7, #99 (outside Scope))",
        "  #9 — A colleague's work (claimed by some-human — a human claim, hands off; not labelled ready-for-agent)",
        "  #10 — Blocked blind (2 open blockers)",
        "  #11 — Unexplained (no path forward found)",
      ].join("\n"),
    );
  });
});

describe("buildCompleteReport", () => {
  it("marks a ticket escalated when it carries the ready-for-human label", () => {
    const report = buildCompleteReport([
      ticket({ number: 2, title: "Walking skeleton", state: "closed" }),
      ticket({
        number: 7,
        title: "Hard one",
        state: "closed",
        labels: ["ready-for-human"],
      }),
    ]);

    expect(report.tickets).toEqual([
      { ticket: 2, title: "Walking skeleton", escalated: false },
      { ticket: 7, title: "Hard one", escalated: true },
    ]);
  });

  it("builds an empty report for an empty Scope", () => {
    expect(buildCompleteReport([])).toEqual({ tickets: [] });
  });
});

describe("renderCompleteReport", () => {
  it("renders the familiar unadorned block, noting human closes after Escalation", () => {
    const report: CompleteReport = {
      tickets: [
        { ticket: 2, title: "Walking skeleton", escalated: false },
        { ticket: 7, title: "Hard one", escalated: true },
      ],
    };

    expect(renderCompleteReport(report)).toBe(
      [
        "Run Complete: every ticket in Scope is closed (2 tickets).",
        "  #2 — Walking skeleton",
        "  #7 — Hard one (closed by a human after Escalation)",
      ].join("\n"),
    );
  });
});
