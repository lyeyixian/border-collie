import { describe, expect, it } from "vitest";
import type { ResolvedConfig } from "../../src/core/config.js";
import type { WorkerHeartbeat } from "../../src/core/heartbeat.js";
import {
  buildCompleteReport,
  buildForensicReport,
  buildPlanReport,
  buildStuckReport,
  type CompleteReport,
  FORENSIC_FINAL_TURNS,
  type ForensicReport,
  MAX_FORENSIC_LENGTH,
  type PlanReport,
  renderCompleteReport,
  renderForensicReport,
  renderHeartbeat,
  renderPlanReport,
  renderStuckReport,
  type StuckReport,
} from "../../src/core/render.js";
import type {
  Action,
  OpenAgentPr,
  Ticket,
  WorkerOutcome,
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
    voidedAtMs: undefined,
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
    operatorSteered: false,
    refinement: { rounds: 0, triggerDue: false, givenUp: false },
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
        ticket({ number: 8, title: "Refining" }),
        ticket({ number: 9, title: "Refinement exhausted" }),
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
      {
        type: "refine-pr",
        pr: 80,
        ticket: 8,
        headRef: "border-collie/ticket-8-attempt-1",
        round: 2,
      },
      { type: "refinement-give-up", pr: 90, ticket: 9, rounds: 3 },
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
      { type: "refine-pr", pr: 80, title: "Refining", round: 2 },
      {
        type: "refinement-give-up",
        pr: 90,
        title: "Refinement exhausted",
        rounds: 3,
      },
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
        { type: "refine-pr", pr: 80, title: "Refining", round: 2 },
        {
          type: "refinement-give-up",
          pr: 90,
          title: "Refinement exhausted",
          rounds: 3,
        },
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
        "  Refine PR #80 — Refining (round 2, failing check or review feedback)",
        "  give up Refining PR #90 — Refinement exhausted (3 rounds exhausted → ready-for-human)",
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

function outcome(overrides: Partial<WorkerOutcome> = {}): WorkerOutcome {
  return {
    ticket: 7,
    attempt: 2,
    branch: "border-collie/ticket-7-attempt-2",
    base: "base-sha",
    transcript: ".border-collie/transcripts/ticket-7-attempt-2.jsonl",
    model: "sonnet",
    exitCode: 1,
    newCommits: 0,
    failure: "budget",
    infra: undefined,
    costUsd: 9.5,
    turns: 200,
    durationMs: 723_000,
    subtype: "error_max_turns",
    costOverrun: false,
    ok: false,
    ...overrides,
  };
}

const textBlock = (text: string) => ({ type: "text", text });
const toolUseBlock = (name: string, input: unknown = {}) => ({
  type: "tool_use",
  id: `toolu_${name}_${Math.random()}`,
  name,
  input,
});

/** One assistant stream-json line, content blocks in order. */
const assistantLine = (...content: unknown[]) =>
  JSON.stringify({ type: "assistant", message: { content } });

/** `count` assistant turns, each calling `toolName` once with `input` — a Worker stuck looping the same call. */
function loopingTranscript(
  count: number,
  toolName: string,
  input: unknown = { command: "pytest" },
): string {
  return Array.from({ length: count }, () =>
    assistantLine(toolUseBlock(toolName, input)),
  ).join("\n");
}

describe("buildForensicReport", () => {
  it("carries the outcome's own result facts untouched, independent of the transcript", () => {
    const report = buildForensicReport(outcome(), "");

    expect(report.facts).toEqual({
      turns: 200,
      costUsd: 9.5,
      durationMs: 723_000,
      subtype: "error_max_turns",
    });
  });

  it("yields empty evidence for an empty or unparseable transcript, without throwing", () => {
    const report = buildForensicReport(outcome(), "not json\n{ broken\n\n");

    expect(report.histogram).toEqual([]);
    expect(report.finalTurns).toEqual([]);
  });

  it("tallies every tool call across the whole session, not just the final turns window", () => {
    const transcript = [
      ...Array.from({ length: 4 }, () => assistantLine(toolUseBlock("Read"))),
      ...Array.from({ length: 6 }, () => assistantLine(toolUseBlock("Bash"))),
      ...Array.from({ length: 2 }, () => assistantLine(toolUseBlock("Edit"))),
    ].join("\n");

    const report = buildForensicReport(outcome(), transcript);

    expect(report.histogram).toEqual([
      { name: "Bash", count: 6 },
      { name: "Read", count: 4 },
      { name: "Edit", count: 2 },
    ]);
    // Every turn beyond the final-turns window still counted: 12 turns total
    // against an 8-turn window.
    expect(report.histogram.reduce((sum, tally) => sum + tally.count, 0)).toBe(
      12,
    );
  });

  it("renders only the session's final turns, numbered against the whole session", () => {
    const transcript = Array.from({ length: 10 }, (_, i) =>
      assistantLine(textBlock(`turn ${i + 1}`)),
    ).join("\n");

    const report = buildForensicReport(outcome(), transcript);

    expect(report.finalTurns).toHaveLength(FORENSIC_FINAL_TURNS);
    expect(report.finalTurns[0]).toMatchObject({ index: 3, text: "turn 3" });
    expect(report.finalTurns.at(-1)).toMatchObject({
      index: 10,
      text: "turn 10",
    });
  });

  it("drops empty text, keeping a tool-only turn readable", () => {
    const transcript = assistantLine(toolUseBlock("Bash", { command: "ls" }));

    const report = buildForensicReport(outcome(), transcript);

    expect(report.finalTurns).toEqual([
      { index: 1, text: undefined, toolCalls: ['Bash({"command":"ls"})'] },
    ]);
  });

  it("diagnoses a turn-cap breach from the whole-session histogram, where the final turns alone would not", () => {
    // 200 turns, all the same looping Bash call — exactly what burns a turn
    // cap. The rendered tail only ever shows the last FORENSIC_FINAL_TURNS.
    const transcript = loopingTranscript(200, "Bash", {
      command: "pytest -k flaky",
    });

    const report = buildForensicReport(
      outcome({ failure: "budget", subtype: "error_max_turns", turns: 200 }),
      transcript,
    );

    expect(report.histogram).toEqual([{ name: "Bash", count: 200 }]);
    expect(report.finalTurns).toHaveLength(FORENSIC_FINAL_TURNS);
    // The tail alone (8 identical-looking calls) is indistinguishable from
    // ordinary progress; only the whole-session count proves the loop.
    expect(report.histogram[0]?.count).toBeGreaterThan(FORENSIC_FINAL_TURNS);

    // The rendered comment text itself must carry that proof, not just the
    // intermediate report struct — this is what a human actually reads.
    const rendered = renderForensicReport(report);
    expect(rendered).toContain("- Bash: 200");
    expect(rendered).toContain("terminated `error_max_turns`");
    const renderedTurnCount = (rendered.match(/^Turn \d+:$/gm) ?? []).length;
    expect(renderedTurnCount).toBe(FORENSIC_FINAL_TURNS);
    expect(renderedTurnCount).toBeLessThan(200);
  });
});

describe("renderForensicReport", () => {
  function report(overrides: Partial<ForensicReport> = {}): ForensicReport {
    return {
      facts: {
        turns: 200,
        costUsd: 9.5,
        durationMs: 723_000,
        subtype: "error_max_turns",
      },
      histogram: [{ name: "Bash", count: 200 }],
      finalTurns: [
        {
          index: 199,
          text: "Running the tests again.",
          toolCalls: ['Bash({"command":"pytest -k flaky"})'],
        },
      ],
      ...overrides,
    };
  }

  it("renders turns, cost, duration, and the terminating subtype", () => {
    const rendered = renderForensicReport(report());

    expect(rendered).toContain("200 turns");
    expect(rendered).toContain("$9.50");
    expect(rendered).toContain("12m3s");
    expect(rendered).toContain("error_max_turns");
  });

  it("renders 'unknown' facts when no result event survived (e.g. a stall or timeout)", () => {
    const rendered = renderForensicReport(
      report({
        facts: {
          turns: undefined,
          costUsd: undefined,
          durationMs: undefined,
          subtype: undefined,
        },
      }),
    );

    expect(rendered).toContain("unknown turns, unknown, unknown");
    expect(rendered).toContain("terminated `unknown`");
  });

  it("renders the tool histogram as a readable list, not raw stream-json", () => {
    const rendered = renderForensicReport(
      report({
        histogram: [
          { name: "Bash", count: 6 },
          { name: "Read", count: 4 },
        ],
      }),
    );

    expect(rendered).toContain("- Bash: 6");
    expect(rendered).toContain("- Read: 4");
    expect(rendered).not.toContain('"type"');
  });

  it("renders final turns readably, distinguishing narration from tool calls", () => {
    const rendered = renderForensicReport(report());

    expect(rendered).toContain("Turn 199:");
    expect(rendered).toContain("Running the tests again.");
    expect(rendered).toContain('→ Bash({"command":"pytest -k flaky"})');
    expect(rendered).not.toContain('"type":"assistant"');
  });

  it("notes when no tool calls or final turns were recorded, rather than rendering nothing", () => {
    const rendered = renderForensicReport(
      report({ histogram: [], finalTurns: [] }),
    );

    expect(rendered).toContain("(no tool calls recorded)");
    expect(rendered).toContain("(none recorded)");
  });

  it("stays within the hard size ceiling even for a pathological report", () => {
    const huge = report({
      histogram: Array.from({ length: 5000 }, (_, i) => ({
        name: `tool-${i}`,
        count: i,
      })),
      finalTurns: Array.from({ length: FORENSIC_FINAL_TURNS }, (_, i) => ({
        index: i + 1,
        text: "x".repeat(10_000),
        toolCalls: [],
      })),
    });

    expect(renderForensicReport(huge).length).toBeLessThanOrEqual(
      MAX_FORENSIC_LENGTH,
    );
  });
});
