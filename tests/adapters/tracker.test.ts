import { describe, expect, it } from "vitest";
import {
  claimTicket,
  closeTicket,
  commentConflictUnresolved,
  createDraftPr,
  type Exec,
  escalateTicket,
  giveUpOnPr,
  liveWorkerTickets,
  markPrReady,
  readScope,
  readTicketTitle,
  releaseFailedTicket,
  releaseTicket,
  startRefinementRound,
  updatePrBranch,
  voidAttempt,
  WORKER_WORKFLOW_FILE,
  withDebugLogging,
  workerRunName,
} from "../../src/adapters/tracker.js";
import type { Log, LogEvent } from "../../src/core/log.js";
import {
  type AttemptFailure,
  attemptMarker,
  CLAIM_LABEL,
  CLAIM_MARKER,
  CONFLICT_UNRESOLVED_MARKER,
  READY_FOR_AGENT,
  READY_FOR_HUMAN,
  REFINEMENT_GIVE_UP_MARKER,
  REFINEMENT_ROUND_MARKER,
  RELEASE_MARKER,
  VOID_MARKER,
} from "../../src/core/types.js";

const FAILURE: AttemptFailure = {
  attempt: 1,
  reason: "stall",
  model: "sonnet",
  branch: "border-collie/ticket-5",
  transcript: ".border-collie/transcripts/ticket-5.jsonl",
};

const issue = (overrides: Record<string, unknown>) => ({
  number: 2,
  title: "Walking skeleton",
  state: "open",
  assignees: [],
  labels: [{ name: "ready-for-agent" }],
  issue_dependencies_summary: { blocked_by: 0 },
  ...overrides,
});

/** A clean `gh pr list` item for an agent branch — the shape the upkeep read parses. */
const prItem = (overrides: Record<string, unknown> = {}) => ({
  number: 50,
  headRefName: "border-collie/ticket-5-attempt-1",
  isDraft: false,
  mergeable: "MERGEABLE",
  statusCheckRollup: [] as unknown[],
  ...overrides,
});

/**
 * Fake the subprocess seam. `gh api <endpoint> --paginate --slurp` calls are
 * answered from `api` keyed by endpoint; `gh pr list` from `prList`; `gh run
 * list` (Worker liveness) from `runList`. An un-mapped gh api endpoint
 * throws, so a test also asserts which reads do NOT happen.
 */
function fakeExec(opts: {
  api?: Record<string, unknown>;
  prList?: unknown[];
  runList?: unknown[];
}): {
  exec: Exec;
  calls: string[][];
} {
  const calls: string[][] = [];
  const api = opts.api ?? {};
  const exec: Exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args[0] === "pr" && args[1] === "list") {
      if (opts.prList === undefined) {
        throw new Error(`unexpected gh pr list: ${[cmd, ...args].join(" ")}`);
      }
      return JSON.stringify(opts.prList);
    }
    if (args[0] === "run" && args[1] === "list") {
      if (opts.runList === undefined) {
        throw new Error(`unexpected gh run list: ${[cmd, ...args].join(" ")}`);
      }
      return JSON.stringify(opts.runList);
    }
    if (args[0] === "api") {
      const endpoint = args[1] ?? "";
      if (!(endpoint in api)) {
        throw new Error(`unexpected gh api call: ${[cmd, ...args].join(" ")}`);
      }
      return JSON.stringify(api[endpoint]);
    }
    throw new Error(`unexpected gh call: ${[cmd, ...args].join(" ")}`);
  };
  return { exec, calls };
}

const SUB_ISSUES = "repos/{owner}/{repo}/issues/1/sub_issues?per_page=100";
const ALL_ISSUES =
  "repos/{owner}/{repo}/issues?labels=ready-for-agent&state=open&per_page=100";
const comments = (n: number) =>
  `repos/{owner}/{repo}/issues/${n}/comments?per_page=100`;
const blockedBy = (n: number) =>
  `repos/{owner}/{repo}/issues/${n}/dependencies/blocked_by?per_page=100`;
/** Inline PR review comments — GitHub's Review flow, distinct from `comments`. */
const pullComments = (n: number) =>
  `repos/{owner}/{repo}/pulls/${n}/comments?per_page=100`;
/** PR review submissions (Approve/Request-changes/Comment). */
const pullReviews = (n: number) =>
  `repos/{owner}/{repo}/pulls/${n}/reviews?per_page=100`;
const CLOSED_PULLS = "repos/{owner}/{repo}/pulls?state=closed&per_page=100";
const compare = (base: string, head: string) =>
  `repos/{owner}/{repo}/compare/${base}...${head}`;

/** The gh operation a recorded call performed, for asserting read order. */
const op = (call: string[]) => {
  if (call[1] === "pr" && call[2] === "list") return "pr-list";
  if (call[1] === "run" && call[2] === "list") return "run-list";
  return call[2];
};

describe("readScope", () => {
  it("reads a parent's sub-issues, then comments, then the open and closed PR listings", async () => {
    const { exec, calls } = fakeExec({
      api: {
        [SUB_ISSUES]: [[issue({})]],
        [comments(2)]: [[]],
        [CLOSED_PULLS]: [[]],
      },
      prList: [],
    });

    await readScope({ kind: "parent", parent: 1 }, exec);

    expect(calls.map(op)).toEqual([
      SUB_ISSUES,
      comments(2),
      "pr-list",
      CLOSED_PULLS,
    ]);
    expect(calls[0]).toEqual([
      "gh",
      "api",
      SUB_ISSUES,
      "--paginate",
      "--slurp",
    ]);
    expect(calls.find((c) => c[1] === "pr")).toEqual([
      "gh",
      "pr",
      "list",
      "--state",
      "open",
      "--limit",
      "100",
      "--json",
      "number,headRefName,baseRefName,isDraft,mergeable,statusCheckRollup,labels,createdAt",
    ]);
  });

  it("reads repo-wide agent-ready issues when scope is all", async () => {
    const { exec, calls } = fakeExec({
      api: {
        [ALL_ISSUES]: [[issue({})]],
        [comments(2)]: [[]],
        [CLOSED_PULLS]: [[]],
      },
      prList: [],
    });

    await readScope({ kind: "all" }, exec);

    expect(calls.map(op)).toEqual([
      ALL_ISSUES,
      comments(2),
      "pr-list",
      CLOSED_PULLS,
    ]);
  });

  it("skips both PR reads when no ticket in Scope is open", async () => {
    const { exec, calls } = fakeExec({
      api: { [SUB_ISSUES]: [[issue({ number: 3, state: "closed" })]] },
      // Neither PR read is mapped: performing them would throw.
    });

    const world = await readScope({ kind: "parent", parent: 1 }, exec);

    expect(calls.map(op)).toEqual([SUB_ISSUES]);
    expect(world.openAgentPrs).toEqual([]);
    expect(world.mergedAgentPrs).toEqual([]);
  });

  it("maps issues to Tickets and flattens pages", async () => {
    const { exec } = fakeExec({
      api: {
        [SUB_ISSUES]: [
          [
            issue({
              number: 3,
              state: "closed",
              assignees: [{ login: "someone" }],
              issue_dependencies_summary: { blocked_by: 2 },
            }),
          ],
          [issue({ number: 4, title: "Second page" })],
        ],
        [comments(4)]: [[]],
        [CLOSED_PULLS]: [[]],
      },
      prList: [],
    });

    const world = await readScope({ kind: "parent", parent: 1 }, exec);

    expect(world.tickets).toEqual([
      {
        number: 3,
        title: "Walking skeleton",
        state: "closed",
        assignees: ["someone"],
        labels: ["ready-for-agent"],
        openBlockers: 2,
        blockedBy: [],
        hasAgentClaim: false,
        agentClaimCount: 0,
        attemptFailures: [],
        hasLiveWorker: false,
      },
      {
        number: 4,
        title: "Second page",
        state: "open",
        assignees: [],
        labels: ["ready-for-agent"],
        openBlockers: 0,
        blockedBy: [],
        hasAgentClaim: false,
        agentClaimCount: 0,
        attemptFailures: [],
        hasLiveWorker: false,
      },
    ]);
  });

  it("drops pull requests from a repo-wide listing", async () => {
    const { exec } = fakeExec({
      api: {
        [ALL_ISSUES]: [
          [
            issue({ number: 5 }),
            issue({ number: 6, pull_request: { url: "x" } }),
          ],
        ],
        [comments(5)]: [[]],
        [CLOSED_PULLS]: [[]],
      },
      prList: [],
    });

    const world = await readScope({ kind: "all" }, exec);

    expect(world.tickets.map((t) => t.number)).toEqual([5]);
  });

  it("treats a missing dependency summary as zero open blockers", async () => {
    const { exec } = fakeExec({
      api: {
        [SUB_ISSUES]: [
          [issue({ number: 7, issue_dependencies_summary: undefined })],
        ],
        [comments(7)]: [[]],
        [CLOSED_PULLS]: [[]],
      },
      prList: [],
    });

    const world = await readScope({ kind: "parent", parent: 1 }, exec);

    expect(world.tickets[0]?.openBlockers).toBe(0);
  });

  it("reads comments for claim-labelled tickets and unassigned dispatch candidates, detecting the claim marker", async () => {
    const { exec, calls } = fakeExec({
      api: {
        [SUB_ISSUES]: [
          [
            issue({
              number: 5,
              labels: [{ name: "ready-for-agent" }, { name: CLAIM_LABEL }],
            }),
            issue({ number: 6 }),
          ],
        ],
        [comments(5)]: [
          [{ body: "human chatter" }, { body: `${CLAIM_MARKER}\n🐕 claimed` }],
        ],
        [comments(6)]: [[]],
        [CLOSED_PULLS]: [[]],
      },
      prList: [],
      runList: [],
    });

    const world = await readScope({ kind: "parent", parent: 1 }, exec);

    expect(world.tickets.map((t) => [t.number, t.hasAgentClaim])).toEqual([
      [5, true],
      [6, false],
    ]);
    expect(calls.map(op)).toContain(comments(5));
    expect(calls.map(op)).toContain(comments(6));
  });

  it("reads comments for a claim-labelled ticket even while blocked, so an orphan release can still fire", async () => {
    const { exec, calls } = fakeExec({
      api: {
        [SUB_ISSUES]: [
          [
            issue({
              number: 5,
              labels: [{ name: "ready-for-agent" }, { name: CLAIM_LABEL }],
              issue_dependencies_summary: { blocked_by: 1 },
            }),
          ],
        ],
        [comments(5)]: [[{ body: `${CLAIM_MARKER}\n🐕 claimed` }]],
        [blockedBy(5)]: [[{ number: 2, state: "open" }]],
        [CLOSED_PULLS]: [[]],
      },
      prList: [],
      runList: [],
    });

    const world = await readScope({ kind: "parent", parent: 1 }, exec);

    expect(world.tickets[0]?.hasAgentClaim).toBe(true);
    expect(calls.map(op)).toContain(comments(5));
  });

  it("skips comment reads for closed, blocked, non-agent, and human-assigned tickets with no claim label", async () => {
    const { exec, calls } = fakeExec({
      api: {
        [SUB_ISSUES]: [
          [
            issue({ number: 3, state: "closed" }),
            issue({ number: 4, issue_dependencies_summary: { blocked_by: 1 } }),
            issue({ number: 8, labels: [] }),
            issue({
              number: 9,
              issue_dependencies_summary: { blocked_by: 1 },
              assignees: [{ login: "operator" }],
            }),
          ],
        ],
        [blockedBy(4)]: [[{ number: 2, state: "open" }]],
        [blockedBy(9)]: [[{ number: 2, state: "open" }]],
        [CLOSED_PULLS]: [[]],
      },
      prList: [],
    });

    const world = await readScope({ kind: "parent", parent: 1 }, exec);

    expect(calls.map(op)).toEqual([
      SUB_ISSUES,
      blockedBy(4),
      blockedBy(9),
      "pr-list",
      CLOSED_PULLS,
    ]);
    expect(world.tickets.map((t) => t.agentClaimCount)).toEqual([0, 0, 0, 0]);
  });

  it("names the open blockers of an open blocked ticket, dropping closed ones", async () => {
    const { exec } = fakeExec({
      api: {
        [SUB_ISSUES]: [
          [issue({ number: 4, issue_dependencies_summary: { blocked_by: 2 } })],
        ],
        [blockedBy(4)]: [
          [
            { number: 2, state: "open" },
            { number: 3, state: "closed" },
            { number: 9, state: "open" },
          ],
        ],
        [CLOSED_PULLS]: [[]],
      },
      prList: [],
    });

    const world = await readScope({ kind: "parent", parent: 1 }, exec);

    expect(world.tickets[0]?.blockedBy).toEqual([2, 9]);
  });

  it("never fetches the blocker list for closed or unblocked tickets", async () => {
    const { exec, calls } = fakeExec({
      api: {
        [SUB_ISSUES]: [
          [
            issue({
              number: 3,
              state: "closed",
              issue_dependencies_summary: { blocked_by: 2 },
            }),
            issue({ number: 4 }),
          ],
        ],
        [comments(4)]: [[]],
        // Dependency endpoints deliberately unmapped: fetching them would throw.
        [CLOSED_PULLS]: [[]],
      },
      prList: [],
    });

    const world = await readScope({ kind: "parent", parent: 1 }, exec);

    expect(calls.map(op)).toEqual([
      SUB_ISSUES,
      comments(4),
      "pr-list",
      CLOSED_PULLS,
    ]);
    expect(world.tickets.map((t) => t.blockedBy)).toEqual([[], []]);
  });

  it("derives the Attempt counter and failure records from the comment history", async () => {
    const { exec } = fakeExec({
      api: {
        [SUB_ISSUES]: [[issue({ number: 5 })]],
        [comments(5)]: [
          [
            { body: `${CLAIM_MARKER}\n🐕 claimed` },
            {
              body: `${RELEASE_MARKER}\n${attemptMarker(FAILURE)}\n🐕 Attempt 1 failed`,
            },
            { body: `${CLAIM_MARKER}\n🐕 claimed again` },
            {
              body: `${RELEASE_MARKER}\n${attemptMarker({ ...FAILURE, attempt: 2, model: "opus" })}\n🐕 Attempt 2 failed`,
            },
          ],
        ],
        [CLOSED_PULLS]: [[]],
      },
      prList: [],
    });

    const world = await readScope({ kind: "parent", parent: 1 }, exec);

    expect(world.tickets[0]).toMatchObject({
      hasAgentClaim: false,
      agentClaimCount: 2,
      attemptFailures: [FAILURE, { ...FAILURE, attempt: 2, model: "opus" }],
    });
  });

  it("uncounts a voided claim while keeping it agent-held (infrastructure failures burn nothing)", async () => {
    const { exec } = fakeExec({
      api: {
        [SUB_ISSUES]: [
          [
            issue({
              number: 5,
              labels: [{ name: "ready-for-agent" }, { name: CLAIM_LABEL }],
            }),
          ],
        ],
        [comments(5)]: [
          [
            { body: `${CLAIM_MARKER}\n🐕 claimed` },
            {
              body: `${VOID_MARKER}\n🐕 Attempt 1 voided: the account usage limit was reached`,
              created_at: "2026-01-01T00:05:00.000Z",
            },
          ],
        ],
        [CLOSED_PULLS]: [[]],
      },
      prList: [],
      runList: [],
    });

    const world = await readScope({ kind: "parent", parent: 1 }, exec);

    expect(world.tickets[0]).toMatchObject({
      hasAgentClaim: true,
      agentClaimCount: 0,
      attemptFailures: [],
      voidedAtMs: Date.parse("2026-01-01T00:05:00.000Z"),
    });
  });

  it("resolves the held void once a later release lands, even without a reclaim yet", async () => {
    const { exec } = fakeExec({
      api: {
        [SUB_ISSUES]: [[issue({ number: 5 })]],
        [comments(5)]: [
          [
            { body: `${CLAIM_MARKER}\n🐕 claimed` },
            {
              body: `${VOID_MARKER}\n🐕 Attempt 1 voided`,
              created_at: "2026-01-01T00:05:00.000Z",
            },
            {
              body: `${RELEASE_MARKER}\n🐕 released (orphaned after the outage)`,
            },
          ],
        ],
        [CLOSED_PULLS]: [[]],
      },
      prList: [],
    });

    const world = await readScope({ kind: "parent", parent: 1 }, exec);

    expect(world.tickets[0]).toMatchObject({ voidedAtMs: undefined });
  });

  it("counts a fresh claim after a voided one as the first Attempt again, and resolves the void", async () => {
    const { exec } = fakeExec({
      api: {
        [SUB_ISSUES]: [[issue({ number: 5 })]],
        [comments(5)]: [
          [
            { body: `${CLAIM_MARKER}\n🐕 claimed` },
            {
              body: `${VOID_MARKER}\n🐕 Attempt 1 voided`,
              created_at: "2026-01-01T00:05:00.000Z",
            },
            {
              body: `${RELEASE_MARKER}\n🐕 released (orphaned after the outage)`,
            },
            { body: `${CLAIM_MARKER}\n🐕 claimed again` },
          ],
        ],
        [CLOSED_PULLS]: [[]],
      },
      prList: [],
    });

    const world = await readScope({ kind: "parent", parent: 1 }, exec);

    expect(world.tickets[0]).toMatchObject({
      hasAgentClaim: true,
      agentClaimCount: 1,
      voidedAtMs: undefined,
    });
  });

  it("leaves voidedAtMs undefined when the void comment's timestamp is missing or unparseable", async () => {
    const { exec } = fakeExec({
      api: {
        [SUB_ISSUES]: [
          [issue({ number: 5, assignees: [{ login: "operator" }] })],
        ],
        [comments(5)]: [
          [
            { body: `${CLAIM_MARKER}\n🐕 claimed` },
            {
              body: `${VOID_MARKER}\n🐕 Attempt 1 voided`,
              created_at: "not-a-date",
            },
          ],
        ],
        [CLOSED_PULLS]: [[]],
      },
      prList: [],
    });

    const world = await readScope({ kind: "parent", parent: 1 }, exec);

    expect(world.tickets[0]).toMatchObject({ voidedAtMs: undefined });
  });

  it("records the latest Ticket-failure release's timestamp and reason for the correlation heuristic", async () => {
    const { exec } = fakeExec({
      api: {
        [SUB_ISSUES]: [[issue({ number: 5 })]],
        [comments(5)]: [
          [
            { body: `${CLAIM_MARKER}\n🐕 claimed` },
            {
              body: `${RELEASE_MARKER}\n${attemptMarker(FAILURE)}\n🐕 Attempt 1 failed`,
              created_at: "2026-01-01T00:05:00.000Z",
            },
          ],
        ],
        [CLOSED_PULLS]: [[]],
      },
      prList: [],
    });

    const world = await readScope({ kind: "parent", parent: 1 }, exec);

    expect(world.tickets[0]).toMatchObject({
      lastFailureAtMs: Date.parse("2026-01-01T00:05:00.000Z"),
      lastFailureReason: FAILURE.reason,
    });
  });

  it("resolves the last Ticket-failure release once a later claim lands", async () => {
    const { exec } = fakeExec({
      api: {
        [SUB_ISSUES]: [[issue({ number: 5 })]],
        [comments(5)]: [
          [
            { body: `${CLAIM_MARKER}\n🐕 claimed` },
            {
              body: `${RELEASE_MARKER}\n${attemptMarker(FAILURE)}\n🐕 Attempt 1 failed`,
              created_at: "2026-01-01T00:05:00.000Z",
            },
            { body: `${CLAIM_MARKER}\n🐕 claimed again` },
          ],
        ],
        [CLOSED_PULLS]: [[]],
      },
      prList: [],
    });

    const world = await readScope({ kind: "parent", parent: 1 }, exec);

    expect(world.tickets[0]).toMatchObject({
      lastFailureAtMs: undefined,
      lastFailureReason: undefined,
    });
  });

  it("leaves lastFailureAtMs/lastFailureReason undefined after an orphan release (no attempt record)", async () => {
    const { exec } = fakeExec({
      api: {
        [SUB_ISSUES]: [
          [
            issue({
              number: 5,
              labels: [{ name: "ready-for-agent" }, { name: CLAIM_LABEL }],
            }),
          ],
        ],
        [comments(5)]: [
          [
            { body: `${CLAIM_MARKER}\n🐕 claimed` },
            { body: `${RELEASE_MARKER}\n🐕 released an orphaned claim` },
          ],
        ],
        [CLOSED_PULLS]: [[]],
      },
      prList: [],
      runList: [],
    });

    const world = await readScope({ kind: "parent", parent: 1 }, exec);

    expect(world.tickets[0]).toMatchObject({
      lastFailureAtMs: undefined,
      lastFailureReason: undefined,
    });
  });

  it("reads Worker liveness only when an open ticket carries the claim label", async () => {
    const { exec, calls } = fakeExec({
      api: {
        [SUB_ISSUES]: [[issue({ number: 5 })]],
        [comments(5)]: [[]],
        [CLOSED_PULLS]: [[]],
      },
      prList: [],
      // runList deliberately unmapped: fetching it would throw.
    });

    await readScope({ kind: "parent", parent: 1 }, exec);

    expect(calls.map(op)).not.toContain("run-list");
  });

  it("marks a claimed ticket's Worker live when its job is still running", async () => {
    const { exec, calls } = fakeExec({
      api: {
        [SUB_ISSUES]: [
          [
            issue({
              number: 5,
              labels: [{ name: "ready-for-agent" }, { name: CLAIM_LABEL }],
            }),
          ],
        ],
        [comments(5)]: [[{ body: `${CLAIM_MARKER}\n🐕 claimed` }]],
        [CLOSED_PULLS]: [[]],
      },
      prList: [],
      runList: [{ status: "in_progress", displayTitle: workerRunName(5, 1) }],
    });

    const world = await readScope({ kind: "parent", parent: 1 }, exec);

    expect(world.tickets[0]?.hasLiveWorker).toBe(true);
    expect(calls.find((c) => c[1] === "run")).toEqual([
      "gh",
      "run",
      "list",
      "--workflow",
      WORKER_WORKFLOW_FILE,
      "--json",
      "status,displayTitle",
      "--limit",
      "100",
    ]);
  });

  it("does not mark a claimed ticket's Worker live once GitHub marks its job completed", async () => {
    const { exec } = fakeExec({
      api: {
        [SUB_ISSUES]: [
          [
            issue({
              number: 5,
              labels: [{ name: "ready-for-agent" }, { name: CLAIM_LABEL }],
            }),
          ],
        ],
        [comments(5)]: [[{ body: `${CLAIM_MARKER}\n🐕 claimed` }]],
        [CLOSED_PULLS]: [[]],
      },
      prList: [],
      runList: [{ status: "completed", displayTitle: workerRunName(5, 1) }],
    });

    const world = await readScope({ kind: "parent", parent: 1 }, exec);

    expect(world.tickets[0]?.hasLiveWorker).toBe(false);
  });

  it("maps open agent-branch PRs with their upkeep signals, ignoring other branches", async () => {
    const { exec } = fakeExec({
      api: {
        [SUB_ISSUES]: [[issue({ number: 5 })]],
        [comments(5)]: [[]],
        [comments(50)]: [[]],
        [pullComments(50)]: [[]],
        [pullReviews(50)]: [[]],
        [CLOSED_PULLS]: [[]],
      },
      prList: [
        prItem({ number: 50, headRefName: "border-collie/ticket-5-attempt-1" }),
        prItem({ number: 99, headRefName: "feature/unrelated" }),
      ],
    });

    const world = await readScope({ kind: "parent", parent: 1 }, exec);

    expect(world.openAgentPrs).toEqual([
      {
        number: 50,
        ticket: 5,
        headRef: "border-collie/ticket-5-attempt-1",
        draft: false,
        mergeable: "mergeable",
        behind: false,
        ci: "none",
        conflictWorkerAsked: false,
        operatorSteered: false,
        refinement: { rounds: 0, triggerDue: false, givenUp: false },
      },
    ]);
  });

  it("reads the upkeep signals: behind (from the compare API), draft, mergeability, and CI", async () => {
    const head = "border-collie/ticket-5-attempt-1";
    const { exec, calls } = fakeExec({
      api: {
        [SUB_ISSUES]: [[issue({ number: 5 })]],
        [comments(5)]: [[]],
        [comments(50)]: [[]],
        [pullComments(50)]: [[]],
        [pullReviews(50)]: [[]],
        [CLOSED_PULLS]: [[]],
        // The head is two commits behind its base.
        [compare("main", head)]: { behind_by: 2 },
      },
      prList: [
        prItem({
          number: 50,
          baseRefName: "main",
          isDraft: true,
          statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
        }),
      ],
    });

    const world = await readScope({ kind: "parent", parent: 1 }, exec);

    expect(world.openAgentPrs[0]).toMatchObject({
      draft: true,
      mergeable: "mergeable",
      behind: true,
      ci: "passing",
    });
    expect(calls.map(op)).toContain(compare("main", head));
  });

  it("does not read the compare API for a conflicted or still-computing PR", async () => {
    const { exec, calls } = fakeExec({
      api: {
        [SUB_ISSUES]: [[issue({ number: 5 }), issue({ number: 6 })]],
        [comments(5)]: [[]],
        [comments(6)]: [[]],
        [comments(50)]: [[]],
        [comments(60)]: [[]],
        [pullComments(60)]: [[]],
        [pullReviews(60)]: [[]],
        [CLOSED_PULLS]: [[]],
      },
      prList: [
        prItem({ number: 50, baseRefName: "main", mergeable: "CONFLICTING" }),
        prItem({
          number: 60,
          baseRefName: "main",
          headRefName: "border-collie/ticket-6-attempt-1",
          mergeable: "UNKNOWN",
        }),
      ],
    });

    const world = await readScope({ kind: "parent", parent: 1 }, exec);

    expect(world.openAgentPrs.map((pr) => pr.behind)).toEqual([false, false]);
    expect(
      calls.some((c) => c[2]?.startsWith("repos/{owner}/{repo}/compare/")),
    ).toBe(false);
  });

  it("reads every open PR's comments once, for the conflict-unresolved marker and the Refinement signal together", async () => {
    const { exec, calls } = fakeExec({
      api: {
        [SUB_ISSUES]: [[issue({ number: 5 })]],
        [comments(5)]: [[]],
        // Comments for the conflicted PR #50 carry the unresolved marker.
        [comments(50)]: [
          [{ body: `${CONFLICT_UNRESOLVED_MARKER}\n🐕 human, please` }],
        ],
        // PR #60 is clean — no border-collie markers at all.
        [comments(60)]: [[]],
        [pullComments(60)]: [[]],
        [pullReviews(60)]: [[]],
        [CLOSED_PULLS]: [[]],
      },
      prList: [
        prItem({ number: 50, mergeable: "CONFLICTING" }),
        prItem({ number: 60, headRefName: "border-collie/ticket-6-attempt-1" }),
      ],
    });

    const world = await readScope({ kind: "parent", parent: 1 }, exec);

    expect(world.openAgentPrs).toEqual([
      {
        number: 50,
        ticket: 5,
        headRef: "border-collie/ticket-5-attempt-1",
        draft: false,
        mergeable: "conflicted",
        behind: false,
        ci: "none",
        conflictWorkerAsked: true,
        operatorSteered: false,
        refinement: { rounds: 0, triggerDue: false, givenUp: false },
      },
      {
        number: 60,
        ticket: 6,
        headRef: "border-collie/ticket-6-attempt-1",
        draft: false,
        mergeable: "mergeable",
        behind: false,
        ci: "none",
        conflictWorkerAsked: false,
        operatorSteered: false,
        refinement: { rounds: 0, triggerDue: false, givenUp: false },
      },
    ]);
    // Both PRs' comments are read — the single pass serves the conflict check
    // and the Refinement signal at once.
    expect(calls.map(op)).toContain(comments(50));
    expect(calls.map(op)).toContain(comments(60));
  });

  it("classifies a pending check rollup as pending and a failing one as failing", async () => {
    const { exec } = fakeExec({
      api: {
        [SUB_ISSUES]: [[issue({ number: 5 }), issue({ number: 6 })]],
        [comments(5)]: [[]],
        [comments(6)]: [[]],
        [comments(50)]: [[]],
        [comments(60)]: [[]],
        // PR #50 is pending, not failing, so its Refinement trigger still
        // consults formal review activity; PR #60 is already failing, which
        // short-circuits that read.
        [pullComments(50)]: [[]],
        [pullReviews(50)]: [[]],
        [CLOSED_PULLS]: [[]],
      },
      prList: [
        prItem({
          number: 50,
          statusCheckRollup: [
            { status: "COMPLETED", conclusion: "SUCCESS" },
            { status: "IN_PROGRESS" },
          ],
        }),
        prItem({
          number: 60,
          headRefName: "border-collie/ticket-6-attempt-1",
          statusCheckRollup: [{ status: "COMPLETED", conclusion: "FAILURE" }],
        }),
      ],
    });

    const world = await readScope({ kind: "parent", parent: 1 }, exec);

    expect(world.openAgentPrs.map((pr) => [pr.number, pr.ci])).toEqual([
      [50, "pending"],
      [60, "failing"],
    ]);
  });

  it("treats an UNKNOWN mergeability as unknown (GitHub still computing)", async () => {
    const { exec } = fakeExec({
      api: {
        [SUB_ISSUES]: [[issue({ number: 5 })]],
        [comments(5)]: [[]],
        [comments(50)]: [[]],
        [pullComments(50)]: [[]],
        [pullReviews(50)]: [[]],
        [CLOSED_PULLS]: [[]],
      },
      prList: [prItem({ number: 50, mergeable: "UNKNOWN" })],
    });

    const world = await readScope({ kind: "parent", parent: 1 }, exec);

    expect(world.openAgentPrs[0]?.mergeable).toBe("unknown");
  });

  it("surfaces merged agent PRs for tickets in Scope, ignoring closed-unmerged and foreign ones", async () => {
    const { exec } = fakeExec({
      api: {
        [SUB_ISSUES]: [[issue({ number: 5 }), issue({ number: 6 })]],
        [comments(5)]: [[]],
        [comments(6)]: [[]],
        [CLOSED_PULLS]: [
          [
            {
              head: { ref: "border-collie/ticket-5" },
              merged_at: "2026-07-20T10:00:00Z",
              html_url: "https://github.com/o/r/pull/50",
            },
            { head: { ref: "border-collie/ticket-6" }, merged_at: null },
            {
              head: { ref: "border-collie/ticket-99" },
              merged_at: "2026-07-19T10:00:00Z",
              html_url: "https://github.com/o/r/pull/99",
            },
            {
              head: { ref: "feature/unrelated" },
              merged_at: "2026-07-18T10:00:00Z",
              html_url: "https://github.com/o/r/pull/40",
            },
          ],
        ],
      },
      prList: [],
    });

    const world = await readScope({ kind: "parent", parent: 1 }, exec);

    expect(world.mergedAgentPrs).toEqual([
      { ticket: 5, url: "https://github.com/o/r/pull/50" },
    ]);
  });

  it("keeps one merged PR per ticket: the first in the newest-created-first listing", async () => {
    const { exec } = fakeExec({
      api: {
        [SUB_ISSUES]: [[issue({ number: 5 })]],
        [comments(5)]: [[]],
        [CLOSED_PULLS]: [
          [
            {
              head: { ref: "border-collie/ticket-5" },
              merged_at: "2026-07-20T10:00:00Z",
              html_url: "https://github.com/o/r/pull/52",
            },
            {
              head: { ref: "border-collie/ticket-5" },
              merged_at: "2026-07-10T10:00:00Z",
              html_url: "https://github.com/o/r/pull/51",
            },
          ],
        ],
      },
      prList: [],
    });

    const world = await readScope({ kind: "parent", parent: 1 }, exec);

    expect(world.mergedAgentPrs).toEqual([
      { ticket: 5, url: "https://github.com/o/r/pull/52" },
    ]);
  });
});

describe("readScope: Refinement signal", () => {
  it("counts Refinement rounds from round marker comments", async () => {
    const { exec } = fakeExec({
      api: {
        [SUB_ISSUES]: [[issue({ number: 5 })]],
        [comments(5)]: [[]],
        [comments(50)]: [
          [
            {
              body: REFINEMENT_ROUND_MARKER,
              created_at: "2026-07-20T10:00:00Z",
            },
            {
              body: REFINEMENT_ROUND_MARKER,
              created_at: "2026-07-21T10:00:00Z",
            },
          ],
        ],
        [pullComments(50)]: [[]],
        [pullReviews(50)]: [[]],
        [CLOSED_PULLS]: [[]],
      },
      prList: [prItem({ number: 50 })],
    });

    const world = await readScope({ kind: "parent", parent: 1 }, exec);

    expect(world.openAgentPrs[0]?.refinement).toEqual({
      rounds: 2,
      triggerDue: false,
      givenUp: false,
    });
  });

  it("is due when a foreign comment lands after the latest round", async () => {
    const { exec } = fakeExec({
      api: {
        [SUB_ISSUES]: [[issue({ number: 5 })]],
        [comments(5)]: [[]],
        [comments(50)]: [
          [
            {
              body: REFINEMENT_ROUND_MARKER,
              created_at: "2026-07-20T10:00:00Z",
            },
            {
              body: "please also fix the typo",
              created_at: "2026-07-21T10:00:00Z",
            },
          ],
        ],
        [pullComments(50)]: [[]],
        [pullReviews(50)]: [[]],
        [CLOSED_PULLS]: [[]],
      },
      prList: [prItem({ number: 50 })],
    });

    const world = await readScope({ kind: "parent", parent: 1 }, exec);

    expect(world.openAgentPrs[0]?.refinement).toEqual({
      rounds: 1,
      triggerDue: true,
      givenUp: false,
    });
  });

  it("is not due when the only foreign comment predates the latest round", async () => {
    const { exec } = fakeExec({
      api: {
        [SUB_ISSUES]: [[issue({ number: 5 })]],
        [comments(5)]: [[]],
        [comments(50)]: [
          [
            { body: "please fix the typo", created_at: "2026-07-19T10:00:00Z" },
            {
              body: REFINEMENT_ROUND_MARKER,
              created_at: "2026-07-20T10:00:00Z",
            },
          ],
        ],
        [pullComments(50)]: [[]],
        [pullReviews(50)]: [[]],
        [CLOSED_PULLS]: [[]],
      },
      prList: [prItem({ number: 50 })],
    });

    const world = await readScope({ kind: "parent", parent: 1 }, exec);

    expect(world.openAgentPrs[0]?.refinement.triggerDue).toBe(false);
  });

  it("is due when an inline review comment lands after the latest round (GitHub's Review flow, not the Conversation tab)", async () => {
    const { exec } = fakeExec({
      api: {
        [SUB_ISSUES]: [[issue({ number: 5 })]],
        [comments(5)]: [[]],
        [comments(50)]: [
          [
            {
              body: REFINEMENT_ROUND_MARKER,
              created_at: "2026-07-20T10:00:00Z",
            },
          ],
        ],
        [pullComments(50)]: [[{ created_at: "2026-07-21T10:00:00Z" }]],
        [pullReviews(50)]: [[]],
        [CLOSED_PULLS]: [[]],
      },
      prList: [prItem({ number: 50 })],
    });

    const world = await readScope({ kind: "parent", parent: 1 }, exec);

    expect(world.openAgentPrs[0]?.refinement).toEqual({
      rounds: 1,
      triggerDue: true,
      givenUp: false,
    });
  });

  it("is due on a Request-changes review with no body, and on a Comment review with one", async () => {
    const { exec } = fakeExec({
      api: {
        [SUB_ISSUES]: [[issue({ number: 5 })]],
        [comments(5)]: [[]],
        [comments(50)]: [[]],
        [pullComments(50)]: [[]],
        [pullReviews(50)]: [
          [
            {
              state: "CHANGES_REQUESTED",
              body: "",
              submitted_at: "2026-07-19T10:00:00Z",
            },
          ],
        ],
        [CLOSED_PULLS]: [[]],
      },
      prList: [prItem({ number: 50 })],
    });

    const world = await readScope({ kind: "parent", parent: 1 }, exec);

    expect(world.openAgentPrs[0]?.refinement.triggerDue).toBe(true);
  });

  it("ignores an approving review with no comment — not feedback needing a fix", async () => {
    const { exec } = fakeExec({
      api: {
        [SUB_ISSUES]: [[issue({ number: 5 })]],
        [comments(5)]: [[]],
        [comments(50)]: [[]],
        [pullComments(50)]: [[]],
        [pullReviews(50)]: [
          [
            {
              state: "APPROVED",
              body: "",
              submitted_at: "2026-07-19T10:00:00Z",
            },
          ],
        ],
        [CLOSED_PULLS]: [[]],
      },
      prList: [prItem({ number: 50 })],
    });

    const world = await readScope({ kind: "parent", parent: 1 }, exec);

    expect(world.openAgentPrs[0]?.refinement.triggerDue).toBe(false);
  });

  it("never reads formal review activity for a conflicted PR — the read would be dead weight", async () => {
    const { exec, calls } = fakeExec({
      api: {
        [SUB_ISSUES]: [[issue({ number: 5 })]],
        [comments(5)]: [[]],
        [comments(50)]: [[]],
        [CLOSED_PULLS]: [[]],
      },
      prList: [prItem({ number: 50, mergeable: "CONFLICTING" })],
    });

    await readScope({ kind: "parent", parent: 1 }, exec);

    expect(calls.map(op)).not.toContain(pullComments(50));
    expect(calls.map(op)).not.toContain(pullReviews(50));
  });

  it("is due on a fresh PR the moment a foreign comment lands, with no round yet", async () => {
    const { exec } = fakeExec({
      api: {
        [SUB_ISSUES]: [[issue({ number: 5 })]],
        [comments(5)]: [[]],
        [comments(50)]: [
          [{ body: "please fix the typo", created_at: "2026-07-19T10:00:00Z" }],
        ],
        [pullComments(50)]: [[]],
        [pullReviews(50)]: [[]],
        [CLOSED_PULLS]: [[]],
      },
      prList: [prItem({ number: 50, createdAt: "2026-07-18T10:00:00Z" })],
    });

    const world = await readScope({ kind: "parent", parent: 1 }, exec);

    expect(world.openAgentPrs[0]?.refinement).toEqual({
      rounds: 0,
      triggerDue: true,
      givenUp: false,
    });
  });

  it("is due on a failing check regardless of comments, without reading formal review activity", async () => {
    const { exec, calls } = fakeExec({
      api: {
        [SUB_ISSUES]: [[issue({ number: 5 })]],
        [comments(5)]: [[]],
        [comments(50)]: [[]],
        [CLOSED_PULLS]: [[]],
      },
      prList: [
        prItem({
          number: 50,
          statusCheckRollup: [{ status: "COMPLETED", conclusion: "FAILURE" }],
        }),
      ],
    });

    const world = await readScope({ kind: "parent", parent: 1 }, exec);

    expect(world.openAgentPrs[0]?.refinement.triggerDue).toBe(true);
    // A failing check already settles the verdict — the extra reads would be dead weight.
    expect(calls.map(op)).not.toContain(pullComments(50));
    expect(calls.map(op)).not.toContain(pullReviews(50));
  });

  it("never triggers once the give-up marker has posted, even on a failing check", async () => {
    const { exec } = fakeExec({
      api: {
        [SUB_ISSUES]: [[issue({ number: 5 })]],
        [comments(5)]: [[]],
        [comments(50)]: [[{ body: REFINEMENT_GIVE_UP_MARKER }]],
        [CLOSED_PULLS]: [[]],
      },
      prList: [
        prItem({
          number: 50,
          statusCheckRollup: [{ status: "COMPLETED", conclusion: "FAILURE" }],
        }),
      ],
    });

    const world = await readScope({ kind: "parent", parent: 1 }, exec);

    expect(world.openAgentPrs[0]?.refinement).toEqual({
      rounds: 0,
      triggerDue: false,
      givenUp: true,
    });
  });

  it("reads the operator-steered label and forces triggerDue false, without hiding the round count", async () => {
    const { exec } = fakeExec({
      api: {
        [SUB_ISSUES]: [[issue({ number: 5 })]],
        [comments(5)]: [[]],
        [comments(50)]: [
          [
            {
              body: REFINEMENT_ROUND_MARKER,
              created_at: "2026-07-20T10:00:00Z",
            },
          ],
        ],
        [CLOSED_PULLS]: [[]],
      },
      prList: [
        prItem({
          number: 50,
          labels: [{ name: "operator-steered" }],
          statusCheckRollup: [{ status: "COMPLETED", conclusion: "FAILURE" }],
        }),
      ],
    });

    const world = await readScope({ kind: "parent", parent: 1 }, exec);

    expect(world.openAgentPrs[0]?.operatorSteered).toBe(true);
    expect(world.openAgentPrs[0]?.refinement).toEqual({
      rounds: 1,
      triggerDue: false,
      givenUp: false,
    });
  });
});

/** Record every subprocess call; writes need no stdout. */
function recordingExec(): { exec: Exec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: Exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    return "";
  };
  return { exec, calls };
}

describe("claimTicket", () => {
  it("adds the claim label first, then posts the claim marker comment", async () => {
    const { exec, calls } = recordingExec();

    await claimTicket(5, exec);

    expect(calls).toEqual([
      ["gh", "issue", "edit", "5", "--add-label", CLAIM_LABEL],
      [
        "gh",
        "issue",
        "comment",
        "5",
        "--body",
        expect.stringContaining(CLAIM_MARKER),
      ],
    ]);
  });
});

describe("releaseTicket", () => {
  it("removes the claim label first, then posts the release marker comment", async () => {
    const { exec, calls } = recordingExec();

    await releaseTicket(5, exec);

    expect(calls).toEqual([
      ["gh", "issue", "edit", "5", "--remove-label", CLAIM_LABEL],
      [
        "gh",
        "issue",
        "comment",
        "5",
        "--body",
        expect.stringContaining(RELEASE_MARKER),
      ],
    ]);
  });
});

describe("closeTicket", () => {
  it("closes the ticket with a comment linking the merged PR", async () => {
    const { exec, calls } = recordingExec();

    await closeTicket(6, "https://github.com/o/r/pull/60", exec);

    expect(calls).toEqual([
      [
        "gh",
        "issue",
        "close",
        "6",
        "--comment",
        expect.stringContaining("https://github.com/o/r/pull/60"),
      ],
    ]);
  });
});

describe("createDraftPr", () => {
  it("opens a draft PR from the head branch and resolves with the trimmed URL", async () => {
    const calls: string[][] = [];
    const exec: Exec = async (cmd, args) => {
      calls.push([cmd, ...args]);
      return "https://github.com/o/r/pull/9\n";
    };

    const url = await createDraftPr(
      {
        head: "border-collie/ticket-5",
        title: "PR opening",
        body: "A body.\n\nCloses #5",
      },
      exec,
    );

    expect(url).toBe("https://github.com/o/r/pull/9");
    expect(calls).toEqual([
      [
        "gh",
        "pr",
        "create",
        "--draft",
        "--head",
        "border-collie/ticket-5",
        "--title",
        "PR opening",
        "--body",
        "A body.\n\nCloses #5",
      ],
    ]);
  });
});

describe("releaseFailedTicket", () => {
  it("removes the claim label first, then posts a release comment carrying the attempt record and forensics", async () => {
    const { exec, calls } = recordingExec();

    await releaseFailedTicket(
      5,
      FAILURE,
      "**Result:** forensic evidence",
      exec,
    );

    expect(calls).toEqual([
      ["gh", "issue", "edit", "5", "--remove-label", CLAIM_LABEL],
      [
        "gh",
        "issue",
        "comment",
        "5",
        "--body",
        expect.stringContaining(RELEASE_MARKER),
      ],
    ]);
    const body = calls[1]?.[5] ?? "";
    expect(body).toContain(attemptMarker(FAILURE));
    expect(body).toContain("no output events");
    expect(body).toContain(FAILURE.transcript);
    expect(body).toContain("**Result:** forensic evidence");
  });
});

describe("voidAttempt", () => {
  it("posts only the void comment: no unassign, no release marker — the claim stays held", async () => {
    const { exec, calls } = recordingExec();

    await voidAttempt(
      5,
      {
        attempt: 1,
        reason: "usage-limit",
        model: "sonnet",
        transcript: ".border-collie/transcripts/ticket-5-attempt-1.jsonl",
      },
      exec,
    );

    expect(calls).toEqual([
      [
        "gh",
        "issue",
        "comment",
        "5",
        "--body",
        expect.stringContaining(VOID_MARKER),
      ],
    ]);
    const body = calls[0]?.[5] ?? "";
    expect(body).not.toContain(RELEASE_MARKER);
    expect(body).toContain("usage limit");
    expect(body).toContain("burns nothing");
    expect(body).toContain(
      ".border-collie/transcripts/ticket-5-attempt-1.jsonl",
    );
  });
});

describe("escalateTicket", () => {
  it("posts the forensic comment first, then swaps ready-for-agent for ready-for-human", async () => {
    const { exec, calls } = recordingExec();
    const second: AttemptFailure = {
      ...FAILURE,
      attempt: 2,
      reason: "timeout",
      model: "opus",
      transcript: ".border-collie/transcripts/ticket-5-2.jsonl",
    };

    await escalateTicket(5, [FAILURE, second], exec);

    expect(calls).toEqual([
      [
        "gh",
        "issue",
        "comment",
        "5",
        "--body",
        expect.stringContaining("Escalated"),
      ],
      [
        "gh",
        "issue",
        "edit",
        "5",
        "--remove-label",
        "ready-for-agent",
        "--add-label",
        "ready-for-human",
      ],
    ]);
    const body = calls[0]?.[5] ?? "";
    expect(body).toContain("Attempt 1 (sonnet)");
    expect(body).toContain("no output events");
    expect(body).toContain("Attempt 2 (opus)");
    expect(body).toContain("wall-clock timeout");
    expect(body).toContain(FAILURE.transcript);
    expect(body).toContain(second.transcript);
    expect(body).toContain(FAILURE.branch);
  });

  it("still escalates with no attempt records, noting the missing forensics", async () => {
    const { exec, calls } = recordingExec();

    await escalateTicket(5, [], exec);

    const body = calls[0]?.[5] ?? "";
    expect(body).toContain("no attempt records");
  });
});

describe("updatePrBranch", () => {
  it("mechanically rebases the PR onto its base via gh pr update-branch", async () => {
    const { exec, calls } = recordingExec();

    await updatePrBranch(30, exec);

    expect(calls).toEqual([["gh", "pr", "update-branch", "30", "--rebase"]]);
  });
});

describe("markPrReady", () => {
  it("flips a draft PR to ready for review", async () => {
    const { exec, calls } = recordingExec();

    await markPrReady(30, exec);

    expect(calls).toEqual([["gh", "pr", "ready", "30"]]);
  });
});

describe("commentConflictUnresolved", () => {
  it("comments the human-resolution ask carrying the unresolved marker", async () => {
    const { exec, calls } = recordingExec();

    await commentConflictUnresolved(30, exec);

    expect(calls).toEqual([
      [
        "gh",
        "pr",
        "comment",
        "30",
        "--body",
        expect.stringContaining(CONFLICT_UNRESOLVED_MARKER),
      ],
    ]);
  });
});

describe("readTicketTitle", () => {
  it("reads a single ticket's title directly, outside of Scope", async () => {
    const { exec, calls } = fakeExec({
      api: { "repos/{owner}/{repo}/issues/7": { title: "Walking skeleton" } },
    });

    const title = await readTicketTitle(7, exec);

    expect(title).toBe("Walking skeleton");
    expect(calls).toEqual([["gh", "api", "repos/{owner}/{repo}/issues/7"]]);
  });

  it("falls back to a generic title when the issue carries none", async () => {
    const { exec } = fakeExec({
      api: { "repos/{owner}/{repo}/issues/7": {} },
    });

    const title = await readTicketTitle(7, exec);

    expect(title).toBe("Ticket #7");
  });
});

describe("workerRunName", () => {
  it("names a run by ticket and attempt", () => {
    expect(workerRunName(5, 1)).toBe("border-collie worker #5 attempt 1");
  });
});

describe("liveWorkerTickets", () => {
  it("reads the Worker workflow's own run list", async () => {
    const { exec, calls } = fakeExec({ runList: [] });

    await liveWorkerTickets(exec);

    expect(calls).toEqual([
      [
        "gh",
        "run",
        "list",
        "--workflow",
        WORKER_WORKFLOW_FILE,
        "--json",
        "status,displayTitle",
        "--limit",
        "100",
      ],
    ]);
  });

  it("collects tickets whose job GitHub has not marked completed", async () => {
    const { exec } = fakeExec({
      runList: [
        { status: "in_progress", displayTitle: workerRunName(5, 1) },
        { status: "queued", displayTitle: workerRunName(9, 2) },
        { status: "completed", displayTitle: workerRunName(4, 1) },
      ],
    });

    expect(await liveWorkerTickets(exec)).toEqual(new Set([5, 9]));
  });

  it("ignores a run whose display title does not match the Worker naming convention", async () => {
    const { exec } = fakeExec({
      runList: [{ status: "in_progress", displayTitle: "some other workflow" }],
    });

    expect(await liveWorkerTickets(exec)).toEqual(new Set());
  });
});

describe("startRefinementRound", () => {
  it("comments the round marker, naming the round", async () => {
    const { exec, calls } = recordingExec();

    await startRefinementRound(30, 2, exec);

    expect(calls).toEqual([
      [
        "gh",
        "pr",
        "comment",
        "30",
        "--body",
        expect.stringContaining(REFINEMENT_ROUND_MARKER),
      ],
    ]);
    const body = calls[0]?.[5] ?? "";
    expect(body).toContain("round 2");
  });
});

describe("giveUpOnPr", () => {
  it("comments the Ticket and swaps its labels first, then marks the PR given up last", async () => {
    const { exec, calls } = recordingExec();

    await giveUpOnPr(30, 5, 3, exec);

    expect(calls).toEqual([
      [
        "gh",
        "issue",
        "comment",
        "5",
        "--body",
        expect.stringContaining("Refinement give-up"),
      ],
      [
        "gh",
        "issue",
        "edit",
        "5",
        "--remove-label",
        READY_FOR_AGENT,
        "--add-label",
        READY_FOR_HUMAN,
      ],
      [
        "gh",
        "pr",
        "comment",
        "30",
        "--body",
        expect.stringContaining(REFINEMENT_GIVE_UP_MARKER),
      ],
    ]);
    const ticketBody = calls[0]?.[5] ?? "";
    expect(ticketBody).toContain("#30");
    expect(ticketBody).toContain("3 rounds");
    const prBody = calls[2]?.[5] ?? "";
    expect(prBody).toContain("3 rounds");
  });
});

function recordingLog(): { log: Log; events: LogEvent[] } {
  const events: LogEvent[] = [];
  const log = ((event: LogEvent) => {
    events.push(event);
  }) as Log;
  log.child = () => log;
  return { log, events };
}

describe("withDebugLogging", () => {
  it("logs the command and a 0 exit code at debug on success, without altering the result", async () => {
    const exec: Exec = async () => "stdout output";
    const { log, events } = recordingLog();

    const result = await withDebugLogging(exec, log)("gh", [
      "issue",
      "view",
      "5",
    ]);

    expect(result).toBe("stdout output");
    expect(events).toEqual([
      {
        kind: "tracker-command",
        level: "debug",
        msg: "gh issue view 5 (exit 0)",
        cmd: "gh",
        args: ["issue", "view", "5"],
        exitCode: 0,
      },
    ]);
  });

  it("logs the command and its exit code at debug on failure, then rethrows", async () => {
    const error = Object.assign(new Error("exit status 1"), { code: 1 });
    const exec: Exec = async () => {
      throw error;
    };
    const { log, events } = recordingLog();

    await expect(
      withDebugLogging(exec, log)("gh", ["issue", "edit", "5"]),
    ).rejects.toBe(error);

    expect(events).toEqual([
      {
        kind: "tracker-command",
        level: "debug",
        msg: "gh issue edit 5 (exit 1)",
        cmd: "gh",
        args: ["issue", "edit", "5"],
        exitCode: 1,
      },
    ]);
  });

  it("logs an unknown exit code when the failure carries none (e.g. the process never spawned)", async () => {
    const exec: Exec = async () => {
      throw new Error("spawn gh ENOENT");
    };
    const { log, events } = recordingLog();

    await expect(
      withDebugLogging(exec, log)("gh", ["issue", "view", "5"]),
    ).rejects.toThrow("ENOENT");

    expect(events[0]).toMatchObject({ exitCode: null });
    expect(events[0]?.msg).toContain("exit unknown");
  });

  it("scrubs credential-shaped content out of the captured command log", async () => {
    const token = `ghp_${"A".repeat(36)}`;
    const secretUrl = `https://x-access-token:${token}@github.com/o/r.git`;
    const exec: Exec = async (_cmd, actualArgs) => {
      // The real subprocess call must still see the unscrubbed URL: scrubbing
      // is a logging concern only, never a behavior change.
      expect(actualArgs).toContain(secretUrl);
      return "";
    };
    const { log, events } = recordingLog();

    await withDebugLogging(exec, log)("git", ["push", secretUrl]);

    const event = events[0];
    expect(event?.msg).not.toContain(token);
    expect(event).toMatchObject({
      args: ["push", "https://<redacted>@github.com/o/r.git"],
    });
  });
});
