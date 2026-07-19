import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { READY_FOR_AGENT, type Ticket, type WorldSnapshot } from "./types.js";
import type { Scope } from "./config.js";

/**
 * The Tracker seam (ADR 0002): every tracker operation lives here, with the
 * `gh` invocations hidden inside. `gh` resolves the {owner}/{repo}
 * placeholders from the git remote of the working directory.
 */

/** Subprocess boundary, injectable for tests. Resolves with stdout. */
export type Exec = (cmd: string, args: string[]) => Promise<string>;

const execFileAsync = promisify(execFile);

export const realExec: Exec = async (cmd, args) => {
  const { stdout } = await execFileAsync(cmd, args, {
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
};

interface GithubIssue {
  number: number;
  title: string;
  state: string;
  assignees?: { login: string }[];
  labels?: { name: string }[];
  issue_dependencies_summary?: { blocked_by: number };
  pull_request?: unknown;
}

function toTicket(issue: GithubIssue): Ticket {
  return {
    number: issue.number,
    title: issue.title,
    state: issue.state === "open" ? "open" : "closed",
    assignees: (issue.assignees ?? []).map((a) => a.login),
    labels: (issue.labels ?? []).map((l) => l.name),
    openBlockers: issue.issue_dependencies_summary?.blocked_by ?? 0,
  };
}

/**
 * Observe phase: read the Scope from GitHub. Parent scope lists the parent's
 * sub-issues (open and closed — the planner needs closed ones to reason about
 * later); repo-wide scope lists open agent-ready issues, excluding PRs
 * (GitHub's issues listing includes them).
 */
export async function readScope(scope: Scope, exec: Exec = realExec): Promise<WorldSnapshot> {
  const endpoint =
    scope.kind === "parent"
      ? `repos/{owner}/{repo}/issues/${scope.parent}/sub_issues?per_page=100`
      : `repos/{owner}/{repo}/issues?labels=${READY_FOR_AGENT}&state=open&per_page=100`;

  const stdout = await exec("gh", ["api", endpoint, "--paginate", "--slurp"]);
  const pages = JSON.parse(stdout) as GithubIssue[][];
  const tickets = pages
    .flat()
    .filter((issue) => issue.pull_request === undefined)
    .map(toTicket);
  return { tickets };
}
