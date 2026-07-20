import { describe, expect, it } from "vitest";
import { claimTicket, createDraftPr, readScope, releaseTicket, type Exec } from "./tracker.js";
import { CLAIM_MARKER, RELEASE_MARKER } from "./types.js";

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

describe("readScope", () => {
  it("reads a parent's sub-issues via gh api with pagination", async () => {
    const { exec, calls } = fakeExec({ [SUB_ISSUES]: [[issue({})]] });

    await readScope({ kind: "parent", parent: 1 }, exec);

    expect(calls).toEqual([
      ["gh", "api", SUB_ISSUES, "--paginate", "--slurp"],
    ]);
  });

  it("reads repo-wide agent-ready issues when scope is all", async () => {
    const { exec, calls } = fakeExec({ [ALL_ISSUES]: [[issue({})]] });

    await readScope({ kind: "all" }, exec);

    expect(calls).toEqual([
      ["gh", "api", ALL_ISSUES, "--paginate", "--slurp"],
    ]);
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
      },
      {
        number: 4,
        title: "Second page",
        state: "open",
        assignees: [],
        labels: ["ready-for-agent"],
        openBlockers: 0,
        hasAgentClaim: false,
      },
    ]);
  });

  it("drops pull requests from a repo-wide listing", async () => {
    const { exec } = fakeExec({
      [ALL_ISSUES]: [
        [issue({ number: 5 }), issue({ number: 6, pull_request: { url: "x" } })],
      ],
    });

    const world = await readScope({ kind: "all" }, exec);

    expect(world.tickets.map((t) => t.number)).toEqual([5]);
  });

  it("treats a missing dependency summary as zero open blockers", async () => {
    const { exec } = fakeExec({
      [SUB_ISSUES]: [[issue({ number: 7, issue_dependencies_summary: undefined })]],
    });

    const world = await readScope({ kind: "parent", parent: 1 }, exec);

    expect(world.tickets[0]?.openBlockers).toBe(0);
  });

  it("reads comments only for assigned open tickets and detects the claim marker", async () => {
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
      [OPEN_PULLS]: [[]],
    });

    const world = await readScope({ kind: "parent", parent: 1 }, exec);

    expect(world.tickets.map((t) => [t.number, t.hasAgentClaim])).toEqual([
      [5, true],
      [6, false],
    ]);
    expect(calls.map((c) => c[2])).toContain(comments(5));
    expect(calls.map((c) => c[2])).not.toContain(comments(6));
  });

  it("treats a release marker after the claim as no agent claim, and skips the PR read", async () => {
    const { exec, calls } = fakeExec({
      [SUB_ISSUES]: [[issue({ number: 5, assignees: [{ login: "a-human" }] })]],
      [comments(5)]: [
        [{ body: `${CLAIM_MARKER}\nclaimed` }, { body: `${RELEASE_MARKER}\nreleased` }],
      ],
      // OPEN_PULLS deliberately unmapped: fetching it would throw.
    });

    const world = await readScope({ kind: "parent", parent: 1 }, exec);

    expect(world.tickets[0]?.hasAgentClaim).toBe(false);
    expect(world.openAgentPrTickets).toEqual([]);
    expect(calls.map((c) => c[2])).not.toContain(OPEN_PULLS);
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
    });

    const world = await readScope({ kind: "parent", parent: 1 }, exec);

    expect(world.openAgentPrTickets).toEqual([8]);
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
