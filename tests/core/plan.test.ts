import { describe, expect, it } from "vitest";
import { plan } from "../../src/core/plan.js";
import {
  type AttemptFailure,
  CLAIM_LABEL,
  MAX_REFINEMENT_ROUNDS,
  type MergedAgentPr,
  type OpenAgentPr,
  type Ticket,
  type WorldSnapshot,
} from "../../src/core/types.js";

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
    voidedAtMs: undefined,
    lastFailureAtMs: undefined,
    lastFailureReason: undefined,
    hasLiveWorker: false,
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

/** A clean, current, non-draft open agent PR — the backdrop that triggers no upkeep. */
function openPr(
  ticket: number,
  overrides: Partial<OpenAgentPr> = {},
): OpenAgentPr {
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
    ...overrides,
  };
}

function world(
  tickets: Ticket[],
  openAgentPrTickets: number[] = [],
  mergedAgentPrs: MergedAgentPr[] = [],
): WorldSnapshot {
  return {
    tickets,
    openAgentPrs: openAgentPrTickets.map((t) => openPr(t)),
    mergedAgentPrs,
  };
}

/** A world whose open agent PRs are given in full — for the PR-upkeep cases. */
function worldWithPrs(
  tickets: Ticket[],
  openAgentPrs: OpenAgentPr[],
): WorldSnapshot {
  return { tickets, openAgentPrs, mergedAgentPrs: [] };
}

function mergedPr(ticket: number): MergedAgentPr {
  return { ticket, url: `https://github.com/o/r/pull/${ticket}0` };
}

describe("plan", () => {
  it("claims a dispatchable ticket and spawns a Worker for it", () => {
    const actions = plan(world([ticket({ number: 7 })]), {
      maxWorkers: 3,
      maxOpenPrs: 5,
    });

    expect(actions).toEqual([
      { type: "claim", ticket: 7 },
      { type: "spawn", ticket: 7, attempt: 1 },
    ]);
  });

  it("produces no actions for an empty world", () => {
    expect(plan(world([]), { maxWorkers: 3, maxOpenPrs: 5 })).toEqual([]);
  });

  it("excludes closed tickets", () => {
    const actions = plan(world([ticket({ number: 1, state: "closed" })]), {
      maxWorkers: 3,
      maxOpenPrs: 5,
    });

    expect(actions).toEqual([]);
  });

  it("excludes assigned tickets", () => {
    const actions = plan(
      world([ticket({ number: 1, assignees: ["some-human"] })]),
      { maxWorkers: 3, maxOpenPrs: 5 },
    );

    expect(actions).toEqual([]);
  });

  it("excludes tickets carrying the claim label, even unassigned", () => {
    const actions = plan(
      world([ticket({ number: 1, labels: ["ready-for-agent", CLAIM_LABEL] })]),
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
    const actions = plan(world([ticket({ number: 1, openBlockers: 2 })]), {
      maxWorkers: 3,
      maxOpenPrs: 5,
    });

    expect(actions).toEqual([]);
  });

  it("releases an orphaned agent claim: claim-labelled with marker, no open agent PR", () => {
    const actions = plan(
      world([
        ticket({
          number: 5,
          labels: ["ready-for-agent", CLAIM_LABEL],
          hasAgentClaim: true,
        }),
      ]),
      { maxWorkers: 3, maxOpenPrs: 5 },
    );

    expect(actions).toEqual([{ type: "release", ticket: 5 }]);
  });

  it("keeps a claim whose Worker job is still live, even with no PR yet (issue #73)", () => {
    // Dispatch is fire-and-forget: by the time this Tick observes the world,
    // the Worker (local or remote) may not have opened its PR yet. Worker
    // liveness read from GitHub is what keeps this from reading as orphaned.
    const actions = plan(
      world([
        ticket({
          number: 5,
          labels: ["ready-for-agent", CLAIM_LABEL],
          hasAgentClaim: true,
          hasLiveWorker: true,
        }),
      ]),
      { maxWorkers: 3, maxOpenPrs: 5 },
    );

    expect(actions).toEqual([]);
  });

  it("keeps an agent claim whose ticket has an open agent PR", () => {
    const actions = plan(
      world(
        [
          ticket({
            number: 5,
            labels: ["ready-for-agent", CLAIM_LABEL],
            hasAgentClaim: true,
          }),
        ],
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
        ticket({
          number: 5,
          state: "closed",
          labels: ["ready-for-agent", CLAIM_LABEL],
          hasAgentClaim: true,
        }),
      ]),
      { maxWorkers: 3, maxOpenPrs: 5 },
    );

    expect(actions).toEqual([]);
  });

  it("plans releases before claims, and does not claim a just-released ticket this tick", () => {
    const actions = plan(
      world([
        ticket({ number: 9 }),
        ticket({
          number: 4,
          labels: ["ready-for-agent", CLAIM_LABEL],
          hasAgentClaim: true,
        }),
      ]),
      { maxWorkers: 3, maxOpenPrs: 5 },
    );

    expect(actions).toEqual([
      { type: "release", ticket: 4 },
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
      world([
        ticket({
          number: 7,
          agentClaimCount: 1,
          attemptFailures: [failure(1)],
        }),
      ]),
      { maxWorkers: 3, maxOpenPrs: 5 },
    );

    expect(actions).toEqual([
      { type: "claim", ticket: 7 },
      { type: "spawn", ticket: 7, attempt: 2 },
    ]);
  });

  it("self-heals from a crash between the two release writes: label already off, stale claim marker still says held", () => {
    // The label goes first on release too, so a crash after it but before the
    // release marker leaves the ticket unlabelled with a marker history that
    // still reads hasAgentClaim — indistinguishable from a fresh dispatchable
    // ticket, so it just claims afresh at the next rung.
    const actions = plan(
      world([ticket({ number: 7, hasAgentClaim: true, agentClaimCount: 1 })]),
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
      world([
        ticket({ number: 7, agentClaimCount: 2, attemptFailures: failures }),
      ]),
      { maxWorkers: 3, maxOpenPrs: 5 },
    );

    expect(actions).toEqual([{ type: "escalate", ticket: 7, failures }]);
  });

  it("escalates a ticket with more claims than failure records (orphan-released attempts)", () => {
    const actions = plan(
      world([
        ticket({
          number: 7,
          agentClaimCount: 3,
          attemptFailures: [failure(2)],
        }),
      ]),
      { maxWorkers: 3, maxOpenPrs: 5 },
    );

    expect(actions).toEqual([
      { type: "escalate", ticket: 7, failures: [failure(2)] },
    ]);
  });

  it("releases an exhausted orphaned claim instead of also escalating it the same tick", () => {
    // Still claim-labelled: releases before escalations, and the claim label
    // is what vetoes escalation until the release actually lands next Tick.
    const actions = plan(
      world([
        ticket({
          number: 7,
          labels: ["ready-for-agent", CLAIM_LABEL],
          hasAgentClaim: true,
          agentClaimCount: 2,
        }),
      ]),
      { maxWorkers: 3, maxOpenPrs: 5 },
    );

    expect(actions).toEqual([{ type: "release", ticket: 7 }]);
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

  it("does not escalate an orphaned claim this tick: the orphan release goes first", () => {
    const actions = plan(
      world([
        ticket({
          number: 7,
          labels: ["ready-for-agent", CLAIM_LABEL],
          hasAgentClaim: true,
          agentClaimCount: 2,
        }),
      ]),
      { maxWorkers: 3, maxOpenPrs: 5 },
    );

    expect(actions).toEqual([{ type: "release", ticket: 7 }]);
  });

  it("orders escalations after releases and before dispatches, without consuming Worker slots", () => {
    const actions = plan(
      world([
        ticket({ number: 3 }),
        ticket({
          number: 5,
          agentClaimCount: 2,
          attemptFailures: [failure(1), failure(2)],
        }),
        ticket({
          number: 6,
          labels: ["ready-for-agent", CLAIM_LABEL],
          hasAgentClaim: true,
        }),
      ]),
      { maxWorkers: 1, maxOpenPrs: 5 },
    );

    expect(actions).toEqual([
      { type: "release", ticket: 6 },
      { type: "escalate", ticket: 5, failures: [failure(1), failure(2)] },
      { type: "claim", ticket: 3 },
      { type: "spawn", ticket: 3, attempt: 1 },
    ]);
  });

  it("closes an open ticket whose agent PR merged, with the PR linked", () => {
    const actions = plan(
      world(
        [
          ticket({
            number: 6,
            labels: ["ready-for-agent", CLAIM_LABEL],
            hasAgentClaim: true,
          }),
        ],
        [],
        [mergedPr(6)],
      ),
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
    const actions = plan(world([ticket({ number: 6 })], [], [mergedPr(6)]), {
      maxWorkers: 3,
      maxOpenPrs: 5,
    });

    expect(actions).toEqual([
      { type: "close", ticket: 6, prUrl: "https://github.com/o/r/pull/60" },
    ]);
  });

  it("plans closes before releases and dispatches, lowest ticket numbers first", () => {
    const actions = plan(
      world(
        [
          ticket({ number: 9 }),
          ticket({
            number: 7,
            labels: ["ready-for-agent", CLAIM_LABEL],
            hasAgentClaim: true,
          }),
          ticket({
            number: 4,
            labels: ["ready-for-agent", CLAIM_LABEL],
            hasAgentClaim: true,
          }),
          ticket({
            number: 2,
            labels: ["ready-for-agent", CLAIM_LABEL],
            hasAgentClaim: true,
          }),
        ],
        [],
        [mergedPr(4), mergedPr(2)],
      ),
      { maxWorkers: 3, maxOpenPrs: 5 },
    );

    expect(actions).toEqual([
      { type: "close", ticket: 2, prUrl: "https://github.com/o/r/pull/20" },
      { type: "close", ticket: 4, prUrl: "https://github.com/o/r/pull/40" },
      { type: "release", ticket: 7 },
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
    const actions = plan(world([ticket({ number: 6 })], [1, 2, 3, 4, 5]), {
      maxWorkers: 3,
      maxOpenPrs: 5,
    });

    expect(actions).toEqual([]);
  });

  it("still closes and releases while dispatch is paused at max_open_prs", () => {
    const actions = plan(
      world(
        [
          ticket({ number: 6 }),
          ticket({
            number: 7,
            labels: ["ready-for-agent", CLAIM_LABEL],
            hasAgentClaim: true,
          }),
          ticket({
            number: 8,
            labels: ["ready-for-agent", CLAIM_LABEL],
            hasAgentClaim: true,
          }),
        ],
        [1, 2, 3, 4, 5],
        [mergedPr(8)],
      ),
      { maxWorkers: 3, maxOpenPrs: 5 },
    );

    expect(actions).toEqual([
      { type: "close", ticket: 8, prUrl: "https://github.com/o/r/pull/80" },
      { type: "release", ticket: 7 },
    ]);
  });
});

describe("plan: circuit breaker", () => {
  it("plans only closure verification while dispatch is paused: no claims, no spawns", () => {
    const actions = plan(
      world(
        [ticket({ number: 4 }), ticket({ number: 6, state: "closed" })],
        [],
        [mergedPr(6)],
      ),
      { maxWorkers: 3, maxOpenPrs: 5, dispatchPaused: true },
    );

    expect(actions).toEqual([]);
  });

  it("still closes a merged-but-open ticket while paused — pure bookkeeping of landed work", () => {
    const actions = plan(world([ticket({ number: 6 })], [], [mergedPr(6)]), {
      maxWorkers: 3,
      maxOpenPrs: 5,
      dispatchPaused: true,
    });

    expect(actions).toEqual([
      { type: "close", ticket: 6, prUrl: "https://github.com/o/r/pull/60" },
    ]);
  });

  it("keeps claims held while paused: no orphan releases mid-outage", () => {
    const held = ticket({
      number: 4,
      labels: ["ready-for-agent", CLAIM_LABEL],
      hasAgentClaim: true,
      agentClaimCount: 1,
    });

    expect(
      plan(world([held]), {
        maxWorkers: 3,
        maxOpenPrs: 5,
        dispatchPaused: true,
      }),
    ).toEqual([]);
  });

  it("does not escalate while paused: tickets are judged only against a healthy environment", () => {
    const exhausted = ticket({
      number: 7,
      agentClaimCount: 2,
      attemptFailures: [failure(1), failure(2)],
    });

    expect(
      plan(world([exhausted]), {
        maxWorkers: 3,
        maxOpenPrs: 5,
        dispatchPaused: true,
      }),
    ).toEqual([]);
  });

  it("does not count a voided attempt: a claim history net of voids re-dispatches at the same rung", () => {
    // agentClaimCount arrives net of void markers from the tracker read: one
    // claim voided by an infrastructure failure leaves the counter at 0.
    const voided = ticket({ number: 4, agentClaimCount: 0 });

    expect(plan(world([voided]), { maxWorkers: 3, maxOpenPrs: 5 })).toEqual([
      { type: "claim", ticket: 4 },
      { type: "spawn", ticket: 4, attempt: 1 },
    ]);
  });
});

describe("plan: working hours", () => {
  it("plans no claim or spawn for a dispatchable ticket within working hours", () => {
    const actions = plan(world([ticket({ number: 7 })]), {
      maxWorkers: 3,
      maxOpenPrs: 5,
      withinWorkingHours: true,
    });

    expect(actions).toEqual([]);
  });

  it("still closes, releases, and escalates within working hours", () => {
    const actions = plan(
      world(
        [
          ticket({ number: 9 }),
          ticket({
            number: 6,
            labels: ["ready-for-agent", CLAIM_LABEL],
            hasAgentClaim: true,
          }),
          ticket({
            number: 5,
            agentClaimCount: 2,
            attemptFailures: [failure(1), failure(2)],
          }),
        ],
        [],
        [mergedPr(9)],
      ),
      { maxWorkers: 3, maxOpenPrs: 5, withinWorkingHours: true },
    );

    expect(actions).toEqual([
      { type: "close", ticket: 9, prUrl: "https://github.com/o/r/pull/90" },
      { type: "release", ticket: 6 },
      { type: "escalate", ticket: 5, failures: [failure(1), failure(2)] },
    ]);
  });

  it("still mechanically updates a behind PR and flips a green draft ready within working hours", () => {
    const actions = plan(
      worldWithPrs(
        [
          ticket({ number: 3, assignees: ["operator"], hasAgentClaim: true }),
          ticket({ number: 4, assignees: ["operator"], hasAgentClaim: true }),
        ],
        [
          openPr(3, { number: 30, behind: true }),
          openPr(4, { number: 40, draft: true, ci: "passing" }),
        ],
      ),
      { maxWorkers: 3, maxOpenPrs: 5, withinWorkingHours: true },
    );

    expect(actions).toEqual([
      { type: "update-branch", pr: 30, ticket: 3 },
      { type: "mark-ready", pr: 40, ticket: 4 },
    ]);
  });

  it("suppresses the Conflict Worker within working hours, without touching update or ready", () => {
    const actions = plan(
      worldWithPrs(
        [ticket({ number: 3, assignees: ["operator"], hasAgentClaim: true })],
        [openPr(3, { number: 30, mergeable: "conflicted" })],
      ),
      { maxWorkers: 3, maxOpenPrs: 5, withinWorkingHours: true },
    );

    expect(actions).toEqual([]);
  });

  it("is independent of the circuit breaker: both suppress dispatch, but the breaker also suppresses PR upkeep and releases", () => {
    const held = ticket({
      number: 4,
      labels: ["ready-for-agent", CLAIM_LABEL],
      hasAgentClaim: true,
    });
    const bothGated = plan(world([held]), {
      maxWorkers: 3,
      maxOpenPrs: 5,
      withinWorkingHours: true,
      dispatchPaused: true,
    });
    const workingHoursOnly = plan(world([held]), {
      maxWorkers: 3,
      maxOpenPrs: 5,
      withinWorkingHours: true,
    });

    // Breaker open wins: only closes, even with the working-hours gate also active.
    expect(bothGated).toEqual([]);
    // Working hours alone still releases the orphaned claim.
    expect(workingHoursOnly).toEqual([{ type: "release", ticket: 4 }]);
  });

  it("dispatches normally once outside working hours", () => {
    const actions = plan(world([ticket({ number: 7 })]), {
      maxWorkers: 3,
      maxOpenPrs: 5,
      withinWorkingHours: false,
    });

    expect(actions).toEqual([
      { type: "claim", ticket: 7 },
      { type: "spawn", ticket: 7, attempt: 1 },
    ]);
  });
});

describe("plan: PR upkeep", () => {
  it("plans no upkeep for a clean, current, non-draft PR", () => {
    const actions = plan(
      worldWithPrs(
        [
          ticket({
            number: 3,
            labels: ["ready-for-agent", CLAIM_LABEL],
            hasAgentClaim: true,
          }),
        ],
        [openPr(3)],
      ),
      { maxWorkers: 3, maxOpenPrs: 5 },
    );

    expect(actions).toEqual([]);
  });

  it("mechanically updates a cleanly-mergeable PR that has fallen behind the base", () => {
    const actions = plan(
      worldWithPrs(
        [
          ticket({
            number: 3,
            labels: ["ready-for-agent", CLAIM_LABEL],
            hasAgentClaim: true,
          }),
        ],
        [openPr(3, { number: 30, behind: true })],
      ),
      { maxWorkers: 3, maxOpenPrs: 5 },
    );

    expect(actions).toEqual([{ type: "update-branch", pr: 30, ticket: 3 }]);
  });

  it("dispatches one conflict Worker for a conflicted PR with no human ask yet", () => {
    const actions = plan(
      worldWithPrs(
        [
          ticket({
            number: 3,
            labels: ["ready-for-agent", CLAIM_LABEL],
            hasAgentClaim: true,
          }),
        ],
        [openPr(3, { number: 30, mergeable: "conflicted" })],
      ),
      { maxWorkers: 3, maxOpenPrs: 5 },
    );

    expect(actions).toEqual([
      {
        type: "conflict-worker",
        pr: 30,
        ticket: 3,
        headRef: "border-collie/ticket-3-attempt-1",
      },
    ]);
  });

  it("never re-dispatches a conflict Worker once one has asked for a human", () => {
    const actions = plan(
      worldWithPrs(
        [
          ticket({
            number: 3,
            labels: ["ready-for-agent", CLAIM_LABEL],
            hasAgentClaim: true,
          }),
        ],
        [
          openPr(3, {
            number: 30,
            mergeable: "conflicted",
            conflictWorkerAsked: true,
          }),
        ],
      ),
      { maxWorkers: 3, maxOpenPrs: 5 },
    );

    expect(actions).toEqual([]);
  });

  it("neither updates nor readies a conflicted PR (conflict handling is exclusive)", () => {
    const actions = plan(
      worldWithPrs(
        [
          ticket({
            number: 3,
            labels: ["ready-for-agent", CLAIM_LABEL],
            hasAgentClaim: true,
          }),
        ],
        [
          openPr(3, {
            number: 30,
            mergeable: "conflicted",
            behind: true,
            draft: true,
            conflictWorkerAsked: true,
          }),
        ],
      ),
      { maxWorkers: 3, maxOpenPrs: 5 },
    );

    expect(actions).toEqual([]);
  });

  it("plans no branch update while GitHub is still computing mergeability", () => {
    // A ready (non-draft) PR with unknown mergeability: we cannot tell whether
    // it is behind, so neither update nor ready is due — leave it for next Tick.
    const actions = plan(
      worldWithPrs(
        [
          ticket({
            number: 3,
            labels: ["ready-for-agent", CLAIM_LABEL],
            hasAgentClaim: true,
          }),
        ],
        [openPr(3, { number: 30, mergeable: "unknown", draft: false })],
      ),
      { maxWorkers: 3, maxOpenPrs: 5 },
    );

    expect(actions).toEqual([]);
  });

  it("still flips a green draft to ready even while mergeability is unknown", () => {
    // draft→ready is decided on CI alone; a fresh no-CI draft need not wait for
    // GitHub to finish computing whether it is behind.
    const actions = plan(
      worldWithPrs(
        [
          ticket({
            number: 3,
            labels: ["ready-for-agent", CLAIM_LABEL],
            hasAgentClaim: true,
          }),
        ],
        [
          openPr(3, {
            number: 30,
            mergeable: "unknown",
            draft: true,
            ci: "none",
          }),
        ],
      ),
      { maxWorkers: 3, maxOpenPrs: 5 },
    );

    expect(actions).toEqual([{ type: "mark-ready", pr: 30, ticket: 3 }]);
  });

  it("flips a green draft to ready for review", () => {
    const actions = plan(
      worldWithPrs(
        [
          ticket({
            number: 3,
            labels: ["ready-for-agent", CLAIM_LABEL],
            hasAgentClaim: true,
          }),
        ],
        [openPr(3, { number: 30, draft: true, ci: "passing" })],
      ),
      { maxWorkers: 3, maxOpenPrs: 5 },
    );

    expect(actions).toEqual([{ type: "mark-ready", pr: 30, ticket: 3 }]);
  });

  it("flips a draft immediately when the repo has no CI configured", () => {
    const actions = plan(
      worldWithPrs(
        [
          ticket({
            number: 3,
            labels: ["ready-for-agent", CLAIM_LABEL],
            hasAgentClaim: true,
          }),
        ],
        [openPr(3, { number: 30, draft: true, ci: "none" })],
      ),
      { maxWorkers: 3, maxOpenPrs: 5 },
    );

    expect(actions).toEqual([{ type: "mark-ready", pr: 30, ticket: 3 }]);
  });

  it("does not flip a draft while CI is pending or failing (a failing one is Refined instead)", () => {
    const actions = plan(
      worldWithPrs(
        [
          ticket({
            number: 3,
            labels: ["ready-for-agent", CLAIM_LABEL],
            hasAgentClaim: true,
          }),
          ticket({
            number: 4,
            labels: ["ready-for-agent", CLAIM_LABEL],
            hasAgentClaim: true,
          }),
        ],
        [
          openPr(3, { number: 30, draft: true, ci: "pending" }),
          openPr(4, {
            number: 40,
            draft: true,
            ci: "failing",
            refinement: { rounds: 0, triggerDue: true, givenUp: false },
          }),
        ],
      ),
      { maxWorkers: 3, maxOpenPrs: 5 },
    );

    expect(actions).toEqual([
      {
        type: "refine-pr",
        pr: 40,
        ticket: 4,
        headRef: "border-collie/ticket-4-attempt-1",
        round: 1,
      },
    ]);
  });

  it("updates a behind draft this tick and defers the ready flip to the next", () => {
    const actions = plan(
      worldWithPrs(
        [
          ticket({
            number: 3,
            labels: ["ready-for-agent", CLAIM_LABEL],
            hasAgentClaim: true,
          }),
        ],
        [openPr(3, { number: 30, draft: true, behind: true, ci: "passing" })],
      ),
      { maxWorkers: 3, maxOpenPrs: 5 },
    );

    expect(actions).toEqual([{ type: "update-branch", pr: 30, ticket: 3 }]);
  });

  it("does not mark a non-draft (already ready) PR ready again", () => {
    const actions = plan(
      worldWithPrs(
        [
          ticket({
            number: 3,
            labels: ["ready-for-agent", CLAIM_LABEL],
            hasAgentClaim: true,
          }),
        ],
        [openPr(3, { number: 30, draft: false, ci: "passing" })],
      ),
      { maxWorkers: 3, maxOpenPrs: 5 },
    );

    expect(actions).toEqual([]);
  });

  it("plans PR upkeep after closes and before releases, lowest PR number first", () => {
    const actions = plan(
      {
        tickets: [
          ticket({
            number: 2,
            labels: ["ready-for-agent", CLAIM_LABEL],
            hasAgentClaim: true,
          }),
          ticket({
            number: 5,
            labels: ["ready-for-agent", CLAIM_LABEL],
            hasAgentClaim: true,
          }),
          ticket({
            number: 7,
            labels: ["ready-for-agent", CLAIM_LABEL],
            hasAgentClaim: true,
          }),
        ],
        openAgentPrs: [
          openPr(7, { number: 70, behind: true }),
          openPr(5, { number: 50, draft: true, ci: "none" }),
        ],
        mergedAgentPrs: [mergedPr(2)],
      },
      { maxWorkers: 3, maxOpenPrs: 5 },
    );

    expect(actions).toEqual([
      { type: "close", ticket: 2, prUrl: "https://github.com/o/r/pull/20" },
      { type: "mark-ready", pr: 50, ticket: 5 },
      { type: "update-branch", pr: 70, ticket: 7 },
    ]);
  });
});

describe("plan: Refinement", () => {
  /** A claimed ticket with an open agent PR — the backdrop every Refinement case needs. */
  function claimedTicket(number: number): Ticket {
    return ticket({
      number,
      labels: ["ready-for-agent", CLAIM_LABEL],
      hasAgentClaim: true,
    });
  }

  it("starts round 1 when a fresh trigger is due and no round has run yet", () => {
    const actions = plan(
      worldWithPrs(
        [claimedTicket(3)],
        [
          openPr(3, {
            number: 30,
            refinement: { rounds: 0, triggerDue: true, givenUp: false },
          }),
        ],
      ),
      { maxWorkers: 3, maxOpenPrs: 5 },
    );

    expect(actions).toEqual([
      {
        type: "refine-pr",
        pr: 30,
        ticket: 3,
        headRef: "border-collie/ticket-3-attempt-1",
        round: 1,
      },
    ]);
  });

  it("charges the next round number when rounds have already run", () => {
    const actions = plan(
      worldWithPrs(
        [claimedTicket(3)],
        [
          openPr(3, {
            number: 30,
            refinement: { rounds: 2, triggerDue: true, givenUp: false },
          }),
        ],
      ),
      { maxWorkers: 3, maxOpenPrs: 5 },
    );

    expect(actions).toEqual([
      {
        type: "refine-pr",
        pr: 30,
        ticket: 3,
        headRef: "border-collie/ticket-3-attempt-1",
        round: 3,
      },
    ]);
  });

  it("plans nothing when no trigger is due, whatever the round count", () => {
    const actions = plan(
      worldWithPrs(
        [claimedTicket(3)],
        [
          openPr(3, {
            number: 30,
            refinement: { rounds: 1, triggerDue: false, givenUp: false },
          }),
        ],
      ),
      { maxWorkers: 3, maxOpenPrs: 5 },
    );

    expect(actions).toEqual([]);
  });

  it("gives up once rounds are exhausted and a trigger is still due", () => {
    const actions = plan(
      worldWithPrs(
        [claimedTicket(3)],
        [
          openPr(3, {
            number: 30,
            refinement: {
              rounds: MAX_REFINEMENT_ROUNDS,
              triggerDue: true,
              givenUp: false,
            },
          }),
        ],
      ),
      { maxWorkers: 3, maxOpenPrs: 5 },
    );

    expect(actions).toEqual([
      {
        type: "refinement-give-up",
        pr: 30,
        ticket: 3,
        rounds: MAX_REFINEMENT_ROUNDS,
      },
    ]);
  });

  it("never starts a round once Refinement has already given up, even if flagged due", () => {
    const actions = plan(
      worldWithPrs(
        [claimedTicket(3)],
        [
          openPr(3, {
            number: 30,
            refinement: {
              rounds: MAX_REFINEMENT_ROUNDS,
              triggerDue: true,
              givenUp: true,
            },
          }),
        ],
      ),
      { maxWorkers: 3, maxOpenPrs: 5 },
    );

    expect(actions).toEqual([]);
  });

  it("skips a PR carrying the operator-steered label entirely", () => {
    const actions = plan(
      worldWithPrs(
        [claimedTicket(3)],
        [
          openPr(3, {
            number: 30,
            operatorSteered: true,
            refinement: {
              rounds: MAX_REFINEMENT_ROUNDS,
              triggerDue: true,
              givenUp: false,
            },
          }),
        ],
      ),
      { maxWorkers: 3, maxOpenPrs: 5 },
    );

    expect(actions).toEqual([]);
  });

  it("never Refines a conflicted PR — conflict handling is exclusive", () => {
    const actions = plan(
      worldWithPrs(
        [claimedTicket(3)],
        [
          openPr(3, {
            number: 30,
            mergeable: "conflicted",
            conflictWorkerAsked: true,
            refinement: { rounds: 0, triggerDue: true, givenUp: false },
          }),
        ],
      ),
      { maxWorkers: 3, maxOpenPrs: 5 },
    );

    expect(actions).toEqual([]);
  });

  it("suppresses a due round within working hours", () => {
    const actions = plan(
      worldWithPrs(
        [claimedTicket(3)],
        [
          openPr(3, {
            number: 30,
            refinement: { rounds: 0, triggerDue: true, givenUp: false },
          }),
        ],
      ),
      { maxWorkers: 3, maxOpenPrs: 5, withinWorkingHours: true },
    );

    expect(actions).toEqual([]);
  });

  it("still gives up within working hours — mechanical, like Escalation", () => {
    const actions = plan(
      worldWithPrs(
        [claimedTicket(3)],
        [
          openPr(3, {
            number: 30,
            refinement: {
              rounds: MAX_REFINEMENT_ROUNDS,
              triggerDue: true,
              givenUp: false,
            },
          }),
        ],
      ),
      { maxWorkers: 3, maxOpenPrs: 5, withinWorkingHours: true },
    );

    expect(actions).toEqual([
      {
        type: "refinement-give-up",
        pr: 30,
        ticket: 3,
        rounds: MAX_REFINEMENT_ROUNDS,
      },
    ]);
  });

  it("does not give up within the circuit breaker's pause either — PR upkeep is suppressed wholesale", () => {
    const actions = plan(
      worldWithPrs(
        [claimedTicket(3)],
        [
          openPr(3, {
            number: 30,
            refinement: {
              rounds: MAX_REFINEMENT_ROUNDS,
              triggerDue: true,
              givenUp: false,
            },
          }),
        ],
      ),
      { maxWorkers: 3, maxOpenPrs: 5, dispatchPaused: true },
    );

    expect(actions).toEqual([]);
  });

  it("Refines instead of escalating a ticket whose Attempts are already exhausted: Refinement rounds count toward no ticket's Attempt cap", () => {
    const exhausted = ticket({
      number: 3,
      labels: ["ready-for-agent", CLAIM_LABEL],
      hasAgentClaim: true,
      agentClaimCount: 2,
    });
    const actions = plan(
      worldWithPrs(
        [exhausted],
        [
          openPr(3, {
            number: 30,
            refinement: { rounds: 0, triggerDue: true, givenUp: false },
          }),
        ],
      ),
      { maxWorkers: 3, maxOpenPrs: 5 },
    );

    expect(actions).toEqual([
      {
        type: "refine-pr",
        pr: 30,
        ticket: 3,
        headRef: "border-collie/ticket-3-attempt-1",
        round: 1,
      },
    ]);
  });
});
