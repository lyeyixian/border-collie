import { describe, expect, it } from "vitest";
import { plan } from "./plan.js";
import type { AttemptFailure, MergedAgentPr, Ticket, WorldSnapshot } from "./types.js";

function ticket(overrides: Partial<Ticket> & { number: number }): Ticket {
  return {
    title: `Ticket #${overrides.number}`,
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

function failure(attempt: number): AttemptFailure {
  return {
    attempt,
    reason: "timeout",
    model: attempt === 1 ? "sonnet" : "opus",
    branch: "border-collie/ticket-7",
    transcript: ".border-collie/transcripts/ticket-7.jsonl",
  };
}

function world(
  tickets: Ticket[],
  openAgentPrTickets: number[] = [],
  mergedAgentPrs: MergedAgentPr[] = [],
): WorldSnapshot {
  return { tickets, openAgentPrTickets, mergedAgentPrs };
}

function mergedPr(ticket: number): MergedAgentPr {
  return { ticket, url: `https://github.com/o/r/pull/${ticket}0` };
}

describe("plan", () => {
  it("claims a dispatchable ticket and spawns a Worker for it", () => {
    const actions = plan(world([ticket({ number: 7 })]), { maxWorkers: 3, maxOpenPrs: 5 });

    expect(actions).toEqual([
      { type: "claim", ticket: 7 },
      { type: "spawn", ticket: 7, attempt: 1 },
    ]);
  });

  it("produces no actions for an empty world", () => {
    expect(plan(world([]), { maxWorkers: 3, maxOpenPrs: 5 })).toEqual([]);
  });

  it("excludes closed tickets", () => {
    const actions = plan(
      world([ticket({ number: 1, state: "closed" })]),
      { maxWorkers: 3, maxOpenPrs: 5 },
    );

    expect(actions).toEqual([]);
  });

  it("excludes assigned tickets", () => {
    const actions = plan(
      world([ticket({ number: 1, assignees: ["some-human"] })]),
      { maxWorkers: 3, maxOpenPrs: 5 },
    );

    expect(actions).toEqual([]);
  });

  it("excludes tickets without the ready-for-agent label", () => {
    const actions = plan(
      world([
        ticket({ number: 1, labels: [] }),
        ticket({ number: 2, labels: ["ready-for-human"] }),
      ]),
      { maxWorkers: 3, maxOpenPrs: 5 },
    );

    expect(actions).toEqual([]);
  });

  it("excludes tickets with open blockers", () => {
    const actions = plan(
      world([ticket({ number: 1, openBlockers: 2 })]),
      { maxWorkers: 3, maxOpenPrs: 5 },
    );

    expect(actions).toEqual([]);
  });

  it("releases an orphaned agent claim: assigned with marker, no open agent PR", () => {
    const actions = plan(
      world([ticket({ number: 5, assignees: ["operator"], hasAgentClaim: true })]),
      { maxWorkers: 3, maxOpenPrs: 5 },
    );

    expect(actions).toEqual([{ type: "release", ticket: 5, assignees: ["operator"] }]);
  });

  it("keeps an agent claim whose ticket has an open agent PR", () => {
    const actions = plan(
      world(
        [ticket({ number: 5, assignees: ["operator"], hasAgentClaim: true })],
        [5],
      ),
      { maxWorkers: 3, maxOpenPrs: 5 },
    );

    expect(actions).toEqual([]);
  });

  it("never touches a human claim: assigned without the marker comment", () => {
    const actions = plan(
      world([ticket({ number: 5, assignees: ["some-human"] })]),
      { maxWorkers: 3, maxOpenPrs: 5 },
    );

    expect(actions).toEqual([]);
  });

  it("does not release a closed ticket that still carries the marker", () => {
    const actions = plan(
      world([
        ticket({ number: 5, state: "closed", assignees: ["operator"], hasAgentClaim: true }),
      ]),
      { maxWorkers: 3, maxOpenPrs: 5 },
    );

    expect(actions).toEqual([]);
  });

  it("plans releases before claims, and does not claim a just-released ticket this tick", () => {
    const actions = plan(
      world([
        ticket({ number: 9 }),
        ticket({ number: 4, assignees: ["operator"], hasAgentClaim: true }),
      ]),
      { maxWorkers: 3, maxOpenPrs: 5 },
    );

    expect(actions).toEqual([
      { type: "release", ticket: 4, assignees: ["operator"] },
      { type: "claim", ticket: 9 },
      { type: "spawn", ticket: 9, attempt: 1 },
    ]);
  });

  it("caps claims at maxWorkers, lowest ticket numbers first, each paired with its spawn", () => {
    const actions = plan(
      world([
        ticket({ number: 9 }),
        ticket({ number: 4 }),
        ticket({ number: 12 }),
        ticket({ number: 6 }),
        ticket({ number: 2 }),
      ]),
      { maxWorkers: 3, maxOpenPrs: 5 },
    );

    expect(actions).toEqual([
      { type: "claim", ticket: 2 },
      { type: "spawn", ticket: 2, attempt: 1 },
      { type: "claim", ticket: 4 },
      { type: "spawn", ticket: 4, attempt: 1 },
      { type: "claim", ticket: 6 },
      { type: "spawn", ticket: 6, attempt: 1 },
    ]);
  });

  it("claims every dispatchable ticket when under the cap", () => {
    const actions = plan(
      world([
        ticket({ number: 3 }),
        ticket({ number: 5, openBlockers: 1 }),
        ticket({ number: 8 }),
      ]),
      { maxWorkers: 3, maxOpenPrs: 5 },
    );

    expect(actions).toEqual([
      { type: "claim", ticket: 3 },
      { type: "spawn", ticket: 3, attempt: 1 },
      { type: "claim", ticket: 8 },
      { type: "spawn", ticket: 8, attempt: 1 },
    ]);
  });
});

describe("plan: retry ladder and Escalation", () => {
  it("re-claims a once-failed ticket as attempt 2 (the retry ladder)", () => {
    const actions = plan(
      world([ticket({ number: 7, agentClaimCount: 1, attemptFailures: [failure(1)] })]),
      { maxWorkers: 3, maxOpenPrs: 5 },
    );

    expect(actions).toEqual([
      { type: "claim", ticket: 7 },
      { type: "spawn", ticket: 7, attempt: 2 },
    ]);
  });

  it("escalates instead of dispatching once attempts are exhausted, citing the failure records", () => {
    const failures = [failure(1), failure(2)];
    const actions = plan(
      world([ticket({ number: 7, agentClaimCount: 2, attemptFailures: failures })]),
      { maxWorkers: 3, maxOpenPrs: 5 },
    );

    expect(actions).toEqual([{ type: "escalate", ticket: 7, failures }]);
  });

  it("escalates a ticket with more claims than failure records (orphan-released attempts)", () => {
    const actions = plan(
      world([ticket({ number: 7, agentClaimCount: 3, attemptFailures: [failure(2)] })]),
      { maxWorkers: 3, maxOpenPrs: 5 },
    );

    expect(actions).toEqual([{ type: "escalate", ticket: 7, failures: [failure(2)] }]);
  });

  it("never escalates an already-escalated ticket (label swap removed ready-for-agent)", () => {
    const actions = plan(
      world([
        ticket({ number: 7, labels: ["ready-for-human"], agentClaimCount: 2 }),
      ]),
      { maxWorkers: 3, maxOpenPrs: 5 },
    );

    expect(actions).toEqual([]);
  });

  it("does not escalate a ticket whose agent PR is still open — the work may land", () => {
    const actions = plan(
      world([ticket({ number: 7, agentClaimCount: 2 })], [7]),
      { maxWorkers: 3, maxOpenPrs: 5 },
    );

    expect(actions).toEqual([]);
  });

  it("does not escalate a ticket whose agent PR merged — the work landed, only closure is due", () => {
    const actions = plan(
      world([ticket({ number: 7, agentClaimCount: 2 })], [], [mergedPr(7)]),
      { maxWorkers: 3, maxOpenPrs: 5 },
    );

    expect(actions).toEqual([
      { type: "close", ticket: 7, prUrl: "https://github.com/o/r/pull/70" },
    ]);
  });

  it("does not escalate an assigned ticket this tick: the orphan release goes first", () => {
    const actions = plan(
      world([
        ticket({ number: 7, assignees: ["operator"], hasAgentClaim: true, agentClaimCount: 2 }),
      ]),
      { maxWorkers: 3, maxOpenPrs: 5 },
    );

    expect(actions).toEqual([{ type: "release", ticket: 7, assignees: ["operator"] }]);
  });

  it("orders escalations after releases and before dispatches, without consuming Worker slots", () => {
    const actions = plan(
      world([
        ticket({ number: 3 }),
        ticket({ number: 5, agentClaimCount: 2, attemptFailures: [failure(1), failure(2)] }),
        ticket({ number: 6, assignees: ["operator"], hasAgentClaim: true }),
      ]),
      { maxWorkers: 1, maxOpenPrs: 5 },
    );

    expect(actions).toEqual([
      { type: "release", ticket: 6, assignees: ["operator"] },
      { type: "escalate", ticket: 5, failures: [failure(1), failure(2)] },
      { type: "claim", ticket: 3 },
      { type: "spawn", ticket: 3, attempt: 1 },
    ]);
  });

  it("closes an open ticket whose agent PR merged, with the PR linked", () => {
    const actions = plan(
      world([ticket({ number: 6, assignees: ["operator"], hasAgentClaim: true })], [], [mergedPr(6)]),
      { maxWorkers: 3, maxOpenPrs: 5 },
    );

    expect(actions).toEqual([
      { type: "close", ticket: 6, prUrl: "https://github.com/o/r/pull/60" },
    ]);
  });

  it("plans no close for a merged PR whose ticket is already closed", () => {
    const actions = plan(
      world([ticket({ number: 6, state: "closed" })], [], [mergedPr(6)]),
      { maxWorkers: 3, maxOpenPrs: 5 },
    );

    expect(actions).toEqual([]);
  });

  it("does not release or re-dispatch a merged ticket awaiting closure", () => {
    // Unassigned, labelled, unblocked — but its PR already merged. Claiming it
    // again would dispatch duplicate work in the same tick as the close.
    const actions = plan(
      world([ticket({ number: 6 })], [], [mergedPr(6)]),
      { maxWorkers: 3, maxOpenPrs: 5 },
    );

    expect(actions).toEqual([
      { type: "close", ticket: 6, prUrl: "https://github.com/o/r/pull/60" },
    ]);
  });

  it("plans closes before releases and dispatches, lowest ticket numbers first", () => {
    const actions = plan(
      world(
        [
          ticket({ number: 9 }),
          ticket({ number: 7, assignees: ["operator"], hasAgentClaim: true }),
          ticket({ number: 4, assignees: ["operator"], hasAgentClaim: true }),
          ticket({ number: 2, assignees: ["operator"], hasAgentClaim: true }),
        ],
        [],
        [mergedPr(4), mergedPr(2)],
      ),
      { maxWorkers: 3, maxOpenPrs: 5 },
    );

    expect(actions).toEqual([
      { type: "close", ticket: 2, prUrl: "https://github.com/o/r/pull/20" },
      { type: "close", ticket: 4, prUrl: "https://github.com/o/r/pull/40" },
      { type: "release", ticket: 7, assignees: ["operator"] },
      { type: "claim", ticket: 9 },
      { type: "spawn", ticket: 9, attempt: 1 },
    ]);
  });

  it("limits dispatch to the open-PR headroom under max_open_prs", () => {
    const actions = plan(
      world(
        [ticket({ number: 6 }), ticket({ number: 7 }), ticket({ number: 8 })],
        [1, 2, 3, 4],
      ),
      { maxWorkers: 3, maxOpenPrs: 5 },
    );

    expect(actions).toEqual([
      { type: "claim", ticket: 6 },
      { type: "spawn", ticket: 6, attempt: 1 },
    ]);
  });

  it("pauses dispatch entirely while open agent PRs are at max_open_prs", () => {
    const actions = plan(
      world([ticket({ number: 6 })], [1, 2, 3, 4, 5]),
      { maxWorkers: 3, maxOpenPrs: 5 },
    );

    expect(actions).toEqual([]);
  });

  it("still closes and releases while dispatch is paused at max_open_prs", () => {
    const actions = plan(
      world(
        [
          ticket({ number: 6 }),
          ticket({ number: 7, assignees: ["operator"], hasAgentClaim: true }),
          ticket({ number: 8, assignees: ["operator"], hasAgentClaim: true }),
        ],
        [1, 2, 3, 4, 5],
        [mergedPr(8)],
      ),
      { maxWorkers: 3, maxOpenPrs: 5 },
    );

    expect(actions).toEqual([
      { type: "close", ticket: 8, prUrl: "https://github.com/o/r/pull/80" },
      { type: "release", ticket: 7, assignees: ["operator"] },
    ]);
  });
});
