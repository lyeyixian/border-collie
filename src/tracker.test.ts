import { describe, expect, it } from "vitest";
import { readScope, type Exec } from "./tracker.js";

const issue = (overrides: Record<string, unknown>) => ({
  number: 2,
  title: "Walking skeleton",
  state: "open",
  assignees: [],
  labels: [{ name: "ready-for-agent" }],
  issue_dependencies_summary: { blocked_by: 0 },
  ...overrides,
});

function fakeExec(pages: unknown[]): { exec: Exec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: Exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    return JSON.stringify(pages);
  };
  return { exec, calls };
}

describe("readScope", () => {
  it("reads a parent's sub-issues via gh api with pagination", async () => {
    const { exec, calls } = fakeExec([[issue({})]]);

    await readScope({ kind: "parent", parent: 1 }, exec);

    expect(calls).toEqual([
      [
        "gh",
        "api",
        "repos/{owner}/{repo}/issues/1/sub_issues?per_page=100",
        "--paginate",
        "--slurp",
      ],
    ]);
  });

  it("reads repo-wide agent-ready issues when scope is all", async () => {
    const { exec, calls } = fakeExec([[issue({})]]);

    await readScope({ kind: "all" }, exec);

    expect(calls).toEqual([
      [
        "gh",
        "api",
        "repos/{owner}/{repo}/issues?labels=ready-for-agent&state=open&per_page=100",
        "--paginate",
        "--slurp",
      ],
    ]);
  });

  it("maps issues to Tickets and flattens pages", async () => {
    const { exec } = fakeExec([
      [
        issue({
          number: 3,
          state: "closed",
          assignees: [{ login: "someone" }],
          issue_dependencies_summary: { blocked_by: 2 },
        }),
      ],
      [issue({ number: 4, title: "Second page" })],
    ]);

    const world = await readScope({ kind: "parent", parent: 1 }, exec);

    expect(world.tickets).toEqual([
      {
        number: 3,
        title: "Walking skeleton",
        state: "closed",
        assignees: ["someone"],
        labels: ["ready-for-agent"],
        openBlockers: 2,
      },
      {
        number: 4,
        title: "Second page",
        state: "open",
        assignees: [],
        labels: ["ready-for-agent"],
        openBlockers: 0,
      },
    ]);
  });

  it("drops pull requests from a repo-wide listing", async () => {
    const { exec } = fakeExec([
      [issue({ number: 5 }), issue({ number: 6, pull_request: { url: "x" } })],
    ]);

    const world = await readScope({ kind: "all" }, exec);

    expect(world.tickets.map((t) => t.number)).toEqual([5]);
  });

  it("treats a missing dependency summary as zero open blockers", async () => {
    const { exec } = fakeExec([
      [issue({ number: 7, issue_dependencies_summary: undefined })],
    ]);

    const world = await readScope({ kind: "parent", parent: 1 }, exec);

    expect(world.tickets[0]?.openBlockers).toBe(0);
  });
});
