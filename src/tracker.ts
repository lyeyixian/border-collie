import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  CLAIM_MARKER,
  READY_FOR_AGENT,
  RELEASE_MARKER,
  ticketFromAgentBranch,
  type Ticket,
  type WorldSnapshot,
} from "./types.js";
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
    hasAgentClaim: false,
  };
}

async function readPages<T>(endpoint: string, exec: Exec): Promise<T[]> {
  const stdout = await exec("gh", ["api", endpoint, "--paginate", "--slurp"]);
  const pages = JSON.parse(stdout) as T[][];
  return pages.flat();
}

/**
 * The latest border-collie marker comment decides claim ownership: a claim
 * marker after any release marker means the assignment is agent-held. Both
 * are append-only, so history stays auditable.
 */
async function ticketHasAgentClaim(ticket: number, exec: Exec): Promise<boolean> {
  const comments = await readPages<{ body?: string }>(
    `repos/{owner}/{repo}/issues/${ticket}/comments?per_page=100`,
    exec,
  );
  let claimed = false;
  for (const comment of comments) {
    if (comment.body?.includes(CLAIM_MARKER)) claimed = true;
    else if (comment.body?.includes(RELEASE_MARKER)) claimed = false;
  }
  return claimed;
}

/** Ticket numbers of open PRs whose head branch carries the agent prefix. */
async function listOpenAgentPrTickets(exec: Exec): Promise<number[]> {
  const pulls = await readPages<{ head?: { ref?: string } }>(
    "repos/{owner}/{repo}/pulls?state=open&per_page=100",
    exec,
  );
  return pulls
    .map((pr) => ticketFromAgentBranch(pr.head?.ref ?? ""))
    .filter((n): n is number => n !== undefined);
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

  const issues = await readPages<GithubIssue>(endpoint, exec);
  const tickets = issues
    .filter((issue) => issue.pull_request === undefined)
    .map(toTicket);

  for (const ticket of tickets) {
    if (ticket.state === "open" && ticket.assignees.length > 0) {
      ticket.hasAgentClaim = await ticketHasAgentClaim(ticket.number, exec);
    }
  }

  // Open agent PRs matter only to orphan detection, which needs an agent
  // claim to exist — skip the read otherwise.
  const openAgentPrTickets = tickets.some((t) => t.hasAgentClaim)
    ? await listOpenAgentPrTickets(exec)
    : [];

  return { tickets, openAgentPrTickets };
}

const CLAIM_COMMENT = `${CLAIM_MARKER}\n🐕 Claimed by border-collie: a Worker will be dispatched against this ticket. This assignment is agent-held — see CONTEXT.md "Claim".`;

const RELEASE_COMMENT = `${RELEASE_MARKER}\n🐕 border-collie released an orphaned claim (no live Worker, no open agent PR). The ticket is dispatchable again.`;

/**
 * Act phase: claim a ticket — assign the working identity, then post the
 * marker comment, as the first writes against the ticket. Assignment goes
 * first (the wayfinder protocol border-collie inherits); a crash in between
 * leaves the ticket looking human-claimed, which fails safe: hands off.
 */
export async function claimTicket(ticket: number, exec: Exec = realExec): Promise<void> {
  await exec("gh", ["issue", "edit", String(ticket), "--add-assignee", "@me"]);
  await exec("gh", ["issue", "comment", String(ticket), "--body", CLAIM_COMMENT]);
}

/**
 * Act phase: release an orphaned claim back to unassigned. Unassign first —
 * a crash in between leaves the ticket unassigned with a stale claim marker,
 * which the next Tick claims afresh (self-healing). The release marker then
 * neutralizes the claim marker so a later human assignment is never misread
 * as agent-held.
 */
export async function releaseTicket(
  ticket: number,
  assignees: string[],
  exec: Exec = realExec,
): Promise<void> {
  await exec("gh", ["issue", "edit", String(ticket), "--remove-assignee", assignees.join(",")]);
  await exec("gh", ["issue", "comment", String(ticket), "--body", RELEASE_COMMENT]);
}

/**
 * Act phase: open a draft PR from an already-pushed head branch against the
 * repo's default base. Resolves with the PR URL `gh` prints.
 */
export async function createDraftPr(
  request: { head: string; title: string; body: string },
  exec: Exec = realExec,
): Promise<string> {
  const stdout = await exec("gh", [
    "pr",
    "create",
    "--draft",
    "--head",
    request.head,
    "--title",
    request.title,
    "--body",
    request.body,
  ]);
  return stdout.trim();
}
