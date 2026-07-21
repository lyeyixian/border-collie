import { describe, expect, it } from "vitest";
import {
  claimTicket,
  closeTicket,
  createDraftPr,
  escalateTicket,
  readScope,
  releaseFailedTicket,
  releaseTicket,
  type Exec,
} from "./tracker.js";
import {
  attemptMarker,
  CLAIM_MARKER,
  RELEASE_MARKER,
  type AttemptFailure,
} from "./types.js";

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

/**
 * Fake the subprocess seam: `gh api <endpoint> --paginate --slurp` calls are
 * answered from a map keyed by endpoint. An un-mapped endpoint throws, so a
 * test also asserts which reads do NOT happen.
 */
function fakeExec(responses: Record<string, unknown>): { exec: Exec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: Exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    const endpoint = args[1] ?? "";
    if (!(endpoint in responses)) {
      throw new Error(`unexpected gh call: ${[cmd, ...args].join(" ")}`);
    }
    return JSON.stringify(responses[endpoint]);
  };
  return { exec, calls };
}

const SUB_ISSUES = "repos/{owner}/{repo}/issues/1/sub_issues?per_page=100";
const ALL_ISSUES = "repos/{owner}/{repo}/issues?labels=ready-for-agent&state=open&per_page=100";
const comments = (n: number) => `repos/{owner}/{repo}/issues/${n}/comments?per_page=100`;
const OPEN_PULLS = "repos/{owner}/{repo}/pulls?state=open&per_page=100";
const CLOSED_PULLS = "repos/{owner}/{repo}/pulls?state=closed&per_page=100";
/** Both PR listings answered empty — the common backdrop for open tickets. */
const NO_PULLS = { [OPEN_PULLS]: [[]], [CLOSED_PULLS]: [[]] };

describe("readScope", () => {
  it("reads a parent's sub-issues via gh api with pagination, then comments and both PR listings", async () => {
    const { exec, calls } = fakeExec({
      [SUB_ISSUES]: [[issue({})]],
      [comments(2)]: [[]],
      ...NO_PULLS,
    });

    await readScope({ kind: "parent", parent: 1 }, exec);

    expect(calls.map((c) => c[2])).toEqual([SUB_ISSUES, comments(2), OPEN_PULLS, CLOSED_PULLS]);
    expect(calls[0]).toEqual(["gh", "api", SUB_ISSUES, "--paginate", "--slurp"]);
  });

  it("reads repo-wide agent-ready issues when scope is all", async () => {
    const { exec, calls } = fakeExec({
      [ALL_ISSUES]: [[issue({})]],
      [comments(2)]: [[]],
      ...NO_PULLS,
    });

    await readScope({ kind: "all" }, exec);

    expect(calls.map((c) => c[2])).toEqual([ALL_ISSUES, comments(2), OPEN_PULLS, CLOSED_PULLS]);
  });

  it("skips both PR reads when no ticket in Scope is open", async () => {
    const { exec, calls } = fakeExec({
      [SUB_ISSUES]: [[issue({ number: 3, state: "closed" })]],
      // Pull endpoints deliberately unmapped: fetching them would throw.
    });

    const world = await readScope({ kind: "parent", parent: 1 }, exec);

    expect(calls.map((c) => c[2])).toEqual([SUB_ISSUES]);
    expect(world.openAgentPrTickets).toEqual([]);
    expect(world.mergedAgentPrs).toEqual([]);
  });

  it("maps issues to Tickets and flattens pages", async () => {
    const { exec } = fakeExec({
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
      ...NO_PULLS,
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
        hasAgentClaim: false,
        agentClaimCount: 0,
        attemptFailures: [],
      },
      {
        number: 4,
        title: "Second page",
        state: "open",
        assignees: [],
        labels: ["ready-for-agent"],
        openBlockers: 0,
        hasAgentClaim: false,
        agentClaimCount: 0,
        attemptFailures: [],
      },
    ]);
  });

  it("drops pull requests from a repo-wide listing", async () => {
    const { exec } = fakeExec({
      [ALL_ISSUES]: [
        [issue({ number: 5 }), issue({ number: 6, pull_request: { url: "x" } })],
      ],
      [comments(5)]: [[]],
      ...NO_PULLS,
    });

    const world = await readScope({ kind: "all" }, exec);

    expect(world.tickets.map((t) => t.number)).toEqual([5]);
  });

  it("treats a missing dependency summary as zero open blockers", async () => {
    const { exec } = fakeExec({
      [SUB_ISSUES]: [[issue({ number: 7, issue_dependencies_summary: undefined })]],
      [comments(7)]: [[]],
      ...NO_PULLS,
    });

    const world = await readScope({ kind: "parent", parent: 1 }, exec);

    expect(world.tickets[0]?.openBlockers).toBe(0);
  });

  it("reads comments for assigned tickets and unassigned dispatch candidates, detecting the claim marker", async () => {
    const { exec, calls } = fakeExec({
      [SUB_ISSUES]: [
        [
          issue({ number: 5, assignees: [{ login: "operator" }] }),
          issue({ number: 6 }),
        ],
      ],
      [comments(5)]: [
        [{ body: "human chatter" }, { body: `${CLAIM_MARKER}\n🐕 claimed` }],
      ],
      [comments(6)]: [[]],
      ...NO_PULLS,
    });

    const world = await readScope({ kind: "parent", parent: 1 }, exec);

    expect(world.tickets.map((t) => [t.number, t.hasAgentClaim])).toEqual([
      [5, true],
      [6, false],
    ]);
    expect(calls.map((c) => c[2])).toContain(comments(5));
    expect(calls.map((c) => c[2])).toContain(comments(6));
  });

  it("skips comment reads for closed, blocked, and non-agent unassigned tickets", async () => {
    const { exec, calls } = fakeExec({
      [SUB_ISSUES]: [
        [
          issue({ number: 3, state: "closed" }),
          issue({ number: 4, issue_dependencies_summary: { blocked_by: 1 } }),
          issue({ number: 8, labels: [] }),
        ],
      ],
      ...NO_PULLS,
    });

    const world = await readScope({ kind: "parent", parent: 1 }, exec);

    expect(calls.map((c) => c[2])).toEqual([SUB_ISSUES, OPEN_PULLS, CLOSED_PULLS]);
    expect(world.tickets.map((t) => t.agentClaimCount)).toEqual([0, 0, 0]);
  });

  it("derives the Attempt counter and failure records from the comment history", async () => {
    const { exec } = fakeExec({
      [SUB_ISSUES]: [[issue({ number: 5 })]],
      [comments(5)]: [
        [
          { body: `${CLAIM_MARKER}\n🐕 claimed` },
          { body: `${RELEASE_MARKER}\n${attemptMarker(FAILURE)}\n🐕 Attempt 1 failed` },
          { body: `${CLAIM_MARKER}\n🐕 claimed again` },
          {
            body: `${RELEASE_MARKER}\n${attemptMarker({ ...FAILURE, attempt: 2, model: "opus" })}\n🐕 Attempt 2 failed`,
          },
        ],
      ],
      ...NO_PULLS,
    });

    const world = await readScope({ kind: "parent", parent: 1 }, exec);

    expect(world.tickets[0]).toMatchObject({
      hasAgentClaim: false,
      agentClaimCount: 2,
      attemptFailures: [FAILURE, { ...FAILURE, attempt: 2, model: "opus" }],
    });
  });

  it("reads open PRs when attempts are exhausted even with no live agent claim (the escalation veto)", async () => {
    const { exec } = fakeExec({
      [SUB_ISSUES]: [[issue({ number: 5 })]],
      [comments(5)]: [
        [
          { body: `${CLAIM_MARKER}\nclaimed` },
          { body: `${RELEASE_MARKER}\nreleased` },
          { body: `${CLAIM_MARKER}\nclaimed` },
          { body: `${RELEASE_MARKER}\nreleased` },
        ],
      ],
      [OPEN_PULLS]: [[{ head: { ref: "border-collie/ticket-5" } }]],
      [CLOSED_PULLS]: [[]],
    });

    const world = await readScope({ kind: "parent", parent: 1 }, exec);

    expect(world.openAgentPrTickets).toEqual([5]);
  });

  it("treats a release marker after the claim as no agent claim", async () => {
    const { exec } = fakeExec({
      [SUB_ISSUES]: [[issue({ number: 5, assignees: [{ login: "a-human" }] })]],
      [comments(5)]: [
        [{ body: `${CLAIM_MARKER}\nclaimed` }, { body: `${RELEASE_MARKER}\nreleased` }],
      ],
      ...NO_PULLS,
    });

    const world = await readScope({ kind: "parent", parent: 1 }, exec);

    expect(world.tickets[0]?.hasAgentClaim).toBe(false);
    expect(world.openAgentPrTickets).toEqual([]);
  });

  it("maps open agent-branch PRs to ticket numbers, ignoring other branches", async () => {
    const { exec } = fakeExec({
      [SUB_ISSUES]: [[issue({ number: 8, assignees: [{ login: "operator" }] })]],
      [comments(8)]: [[{ body: `${CLAIM_MARKER}\nclaimed` }]],
      [OPEN_PULLS]: [
        [
          { head: { ref: "border-collie/ticket-8" } },
          { head: { ref: "feature/unrelated" } },
        ],
      ],
      [CLOSED_PULLS]: [[]],
    });

    const world = await readScope({ kind: "parent", parent: 1 }, exec);

    expect(world.openAgentPrTickets).toEqual([8]);
  });

  it("surfaces merged agent PRs for tickets in Scope, ignoring closed-unmerged and foreign ones", async () => {
    const { exec } = fakeExec({
      [SUB_ISSUES]: [[issue({ number: 5 }), issue({ number: 6 })]],
      [comments(5)]: [[]],
      [comments(6)]: [[]],
      [OPEN_PULLS]: [[]],
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
    });

    const world = await readScope({ kind: "parent", parent: 1 }, exec);

    expect(world.mergedAgentPrs).toEqual([
      { ticket: 5, url: "https://github.com/o/r/pull/50" },
    ]);
  });

  it("keeps one merged PR per ticket: the first in the newest-created-first listing", async () => {
    const { exec } = fakeExec({
      [SUB_ISSUES]: [[issue({ number: 5 })]],
      [comments(5)]: [[]],
      [OPEN_PULLS]: [[]],
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
    });

    const world = await readScope({ kind: "parent", parent: 1 }, exec);

    expect(world.mergedAgentPrs).toEqual([
      { ticket: 5, url: "https://github.com/o/r/pull/52" },
    ]);
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
  it("assigns @me first, then posts the claim marker comment", async () => {
    const { exec, calls } = recordingExec();

    await claimTicket(5, exec);

    expect(calls).toEqual([
      ["gh", "issue", "edit", "5", "--add-assignee", "@me"],
      ["gh", "issue", "comment", "5", "--body", expect.stringContaining(CLAIM_MARKER)],
    ]);
  });
});

describe("releaseTicket", () => {
  it("unassigns the observed assignees first, then posts the release marker comment", async () => {
    const { exec, calls } = recordingExec();

    await releaseTicket(5, ["operator", "other"], exec);

    expect(calls).toEqual([
      ["gh", "issue", "edit", "5", "--remove-assignee", "operator,other"],
      ["gh", "issue", "comment", "5", "--body", expect.stringContaining(RELEASE_MARKER)],
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
      { head: "border-collie/ticket-5", title: "PR opening", body: "A body.\n\nCloses #5" },
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
  it("unassigns @me first, then posts a release comment carrying the attempt record", async () => {
    const { exec, calls } = recordingExec();

    await releaseFailedTicket(5, FAILURE, exec);

    expect(calls).toEqual([
      ["gh", "issue", "edit", "5", "--remove-assignee", "@me"],
      ["gh", "issue", "comment", "5", "--body", expect.stringContaining(RELEASE_MARKER)],
    ]);
    const body = calls[1]?.[5] ?? "";
    expect(body).toContain(attemptMarker(FAILURE));
    expect(body).toContain("no output events");
    expect(body).toContain(FAILURE.transcript);
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
      ["gh", "issue", "comment", "5", "--body", expect.stringContaining("Escalated")],
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
