import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  attemptMarker,
  CLAIM_MARKER,
  FAILURE_DESCRIPTIONS,
  INFRA_DESCRIPTIONS,
  MAX_ATTEMPTS,
  parseAttemptMarker,
  READY_FOR_AGENT,
  READY_FOR_HUMAN,
  RELEASE_MARKER,
  ticketFromAgentBranch,
  VOID_MARKER,
  type AttemptFailure,
  type InfraReason,
  type MergedAgentPr,
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
    agentClaimCount: 0,
    attemptFailures: [],
  };
}

async function readPages<T>(endpoint: string, exec: Exec): Promise<T[]> {
  const stdout = await exec("gh", ["api", endpoint, "--paginate", "--slurp"]);
  const pages = JSON.parse(stdout) as T[][];
  return pages.flat();
}

interface ClaimHistory {
  hasAgentClaim: boolean;
  agentClaimCount: number;
  attemptFailures: AttemptFailure[];
}

/**
 * One pass over a ticket's comments, oldest first. The latest border-collie
 * marker comment decides claim ownership: a claim marker after any release
 * marker means the assignment is agent-held. The claim markers ever posted
 * count Attempts (each Attempt is preceded by exactly one claim), a void
 * marker uncounts the claim it follows (an infrastructure death burns
 * nothing) while leaving the claim held, and release comments carry the
 * failed attempts' forensic records. All append-only, so history stays
 * auditable and attempt state needs no local store.
 */
async function readClaimHistory(ticket: number, exec: Exec): Promise<ClaimHistory> {
  const comments = await readPages<{ body?: string }>(
    `repos/{owner}/{repo}/issues/${ticket}/comments?per_page=100`,
    exec,
  );
  const history: ClaimHistory = { hasAgentClaim: false, agentClaimCount: 0, attemptFailures: [] };
  for (const comment of comments) {
    if (comment.body?.includes(CLAIM_MARKER)) {
      history.hasAgentClaim = true;
      history.agentClaimCount += 1;
    } else if (comment.body?.includes(VOID_MARKER)) {
      history.agentClaimCount = Math.max(0, history.agentClaimCount - 1);
    } else if (comment.body?.includes(RELEASE_MARKER)) {
      history.hasAgentClaim = false;
      const failure = parseAttemptMarker(comment.body);
      if (failure) history.attemptFailures.push(failure);
    }
  }
  return history;
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
 * Merged agent PRs, one per ticket (first seen in the listing, which is
 * newest-created-first). Reads the full closed-PR listing — fine at v1's
 * repo sizes — and drops closed-without-merge PRs: only a merge means the
 * work landed (CONTEXT.md "Done").
 */
async function listMergedAgentPrs(exec: Exec): Promise<MergedAgentPr[]> {
  const pulls = await readPages<{
    head?: { ref?: string };
    merged_at?: string | null;
    html_url?: string;
  }>("repos/{owner}/{repo}/pulls?state=closed&per_page=100", exec);
  const merged = new Map<number, MergedAgentPr>();
  for (const pr of pulls) {
    if (!pr.merged_at) continue;
    const ticket = ticketFromAgentBranch(pr.head?.ref ?? "");
    if (ticket === undefined || merged.has(ticket)) continue;
    merged.set(ticket, { ticket, url: pr.html_url ?? "" });
  }
  return [...merged.values()];
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

  // Claim history is read where it can matter: assigned tickets (claim
  // ownership) and unassigned dispatch candidates (the Attempt counter that
  // picks the retry rung or triggers Escalation).
  for (const ticket of tickets) {
    const isDispatchCandidate =
      ticket.labels.includes(READY_FOR_AGENT) && ticket.openBlockers === 0;
    if (ticket.state === "open" && (ticket.assignees.length > 0 || isDispatchCandidate)) {
      const history = await readClaimHistory(ticket.number, exec);
      ticket.hasAgentClaim = history.hasAgentClaim;
      ticket.agentClaimCount = history.agentClaimCount;
      ticket.attemptFailures = history.attemptFailures;
    }
  }

  // Agent PRs matter only while open tickets exist: orphan detection, the
  // escalation veto, and the max_open_prs throttle read the open ones,
  // closure verification the merged ones. A fully closed Scope needs
  // neither read.
  const hasOpenTickets = tickets.some((t) => t.state === "open");
  const inScope = new Set(tickets.map((t) => t.number));
  const openAgentPrTickets = hasOpenTickets ? await listOpenAgentPrTickets(exec) : [];
  const mergedAgentPrs = hasOpenTickets
    ? (await listMergedAgentPrs(exec)).filter((pr) => inScope.has(pr.ticket))
    : [];

  return { tickets, openAgentPrTickets, mergedAgentPrs };
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
 * The shared release shape: unassign first — a crash in between leaves the
 * ticket unassigned with a stale claim marker, which the next Tick claims
 * afresh (self-healing). The release marker then neutralizes the claim
 * marker so a later human assignment is never misread as agent-held.
 */
async function release(ticket: number, assignees: string, body: string, exec: Exec): Promise<void> {
  await exec("gh", ["issue", "edit", String(ticket), "--remove-assignee", assignees]);
  await exec("gh", ["issue", "comment", String(ticket), "--body", body]);
}

/** Act phase: release an orphaned claim back to unassigned. */
export async function releaseTicket(
  ticket: number,
  assignees: string[],
  exec: Exec = realExec,
): Promise<void> {
  await release(ticket, assignees.join(","), RELEASE_COMMENT, exec);
}

const closeComment = (prUrl: string) =>
  `🐕 border-collie closure verification: ${prUrl} merged, but this ticket was still open — closing it so its dependents unblock.`;

/**
 * Act phase: close a ticket whose agent PR merged without closing it (a
 * mangled close keyword must never silently freeze the DAG), commenting the
 * merged PR's URL as evidence.
 */
export async function closeTicket(
  ticket: number,
  prUrl: string,
  exec: Exec = realExec,
): Promise<void> {
  await exec("gh", ["issue", "close", String(ticket), "--comment", closeComment(prUrl)]);
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

/**
 * Act phase: release a ticket whose Attempt just failed, embedding the
 * attempt's forensic record in the release comment — the tracker is the only
 * state store, so this comment IS the attempt history that the next Tick's
 * retry ladder and a later Escalation read back.
 */
export async function releaseFailedTicket(
  ticket: number,
  failure: AttemptFailure,
  exec: Exec = realExec,
): Promise<void> {
  const body = [
    RELEASE_MARKER,
    attemptMarker(failure),
    `🐕 Attempt ${failure.attempt} failed: ${FAILURE_DESCRIPTIONS[failure.reason]} (model ${failure.model}).`,
    `Worktree torn down; branch \`${failure.branch}\` abandoned; transcript at \`${failure.transcript}\`.`,
  ].join("\n");
  await release(ticket, "@me", body, exec);
}

/** What a voided Attempt leaves behind, cited in the void comment for humans. */
export interface VoidedAttempt {
  attempt: number;
  reason: InfraReason;
  model: string;
  transcript: string;
}

/**
 * Act phase: void an Attempt that died to the environment. A comment only —
 * no unassign, no release marker: the claim stays held while the circuit
 * breaker waits out the outage, and the void marker uncounts the claim so
 * the Attempt burns nothing. (The next dispatch reuses the attempt number,
 * so the cited branch and transcript may be superseded — voided attempts
 * need no preserved evidence, they never reach Escalation.)
 */
export async function voidAttempt(
  ticket: number,
  voided: VoidedAttempt,
  exec: Exec = realExec,
): Promise<void> {
  const body = [
    VOID_MARKER,
    `🐕 Attempt ${voided.attempt} voided: ${INFRA_DESCRIPTIONS[voided.reason]} (model ${voided.model}) — an infrastructure failure, not a ticket failure, so it burns nothing.`,
    `Claim held; dispatch pauses until the environment recovers. Transcript at \`${voided.transcript}\`.`,
  ].join("\n");
  await exec("gh", ["issue", "comment", String(ticket), "--body", body]);
}

/**
 * Act phase: Escalate a ticket whose Attempts are exhausted — the forensic
 * comment first, then the label swap that removes it from the dispatchable
 * set for good. A crash in between re-escalates next Tick (worst case a
 * duplicate comment); the swap first would strand the forensics unwritten
 * with no trigger left to write them. The glossary's "unassign" is already
 * done: only unassigned tickets escalate (every failure or orphan release
 * unassigns first), so no assignee write belongs here.
 */
export async function escalateTicket(
  ticket: number,
  failures: AttemptFailure[],
  exec: Exec = realExec,
): Promise<void> {
  const evidence =
    failures.length === 0
      ? ["(no attempt records found — the claims were likely released as orphans after crashes)"]
      : failures.map(
          (f) =>
            `- Attempt ${f.attempt} (${f.model}): ${FAILURE_DESCRIPTIONS[f.reason]} — transcript \`${f.transcript}\`, abandoned branch \`${f.branch}\``,
        );
  const body = [
    `🐕 Escalated by border-collie: ${MAX_ATTEMPTS} Attempts exhausted, handing this ticket to a human.`,
    "",
    ...evidence,
  ].join("\n");
  await exec("gh", ["issue", "comment", String(ticket), "--body", body]);
  await exec("gh", [
    "issue",
    "edit",
    String(ticket),
    "--remove-label",
    READY_FOR_AGENT,
    "--add-label",
    READY_FOR_HUMAN,
  ]);
}
