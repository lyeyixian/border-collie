import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Scope } from "./config.js";
import {
  type AttemptFailure,
  attemptMarker,
  type CiState,
  CLAIM_MARKER,
  CONFLICT_UNRESOLVED_MARKER,
  FAILURE_DESCRIPTIONS,
  INFRA_DESCRIPTIONS,
  type InfraReason,
  MAX_ATTEMPTS,
  type Mergeability,
  type MergedAgentPr,
  type OpenAgentPr,
  parseAttemptMarker,
  READY_FOR_AGENT,
  READY_FOR_HUMAN,
  RELEASE_MARKER,
  type Ticket,
  ticketFromAgentBranch,
  VOID_MARKER,
  type WorldSnapshot,
} from "./types.js";

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
    blockedBy: [],
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
async function readClaimHistory(
  ticket: number,
  exec: Exec,
): Promise<ClaimHistory> {
  const comments = await readPages<{ body?: string }>(
    `repos/{owner}/{repo}/issues/${ticket}/comments?per_page=100`,
    exec,
  );
  const history: ClaimHistory = {
    hasAgentClaim: false,
    agentClaimCount: 0,
    attemptFailures: [],
  };
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

/**
 * Issue numbers of a ticket's open blockers (the summary only counts them).
 * Read for open blocked tickets so the Stuck report can name exactly what a
 * ticket is stuck on; the endpoint lists closed blockers too, dropped here.
 */
async function readOpenBlockers(ticket: number, exec: Exec): Promise<number[]> {
  const blockers = await readPages<{ number: number; state?: string }>(
    `repos/{owner}/{repo}/issues/${ticket}/dependencies/blocked_by?per_page=100`,
    exec,
  );
  return blockers.filter((b) => b.state === "open").map((b) => b.number);
}

/** One check-run (status/conclusion) or legacy status context (state) in the rollup. */
interface RollupCheck {
  status?: string;
  conclusion?: string;
  state?: string;
}

interface GhPrListItem {
  number: number;
  headRefName?: string;
  baseRefName?: string;
  isDraft?: boolean;
  /** GraphQL mergeability: MERGEABLE | CONFLICTING | UNKNOWN. Independent of the draft flag. */
  mergeable?: string;
  statusCheckRollup?: RollupCheck[];
}

function mergeabilityOf(raw: string | undefined): Mergeability {
  if (raw === "MERGEABLE") return "mergeable";
  if (raw === "CONFLICTING") return "conflicted";
  return "unknown";
}

/**
 * True when the PR's head is behind its base — the base carries commits the
 * head lacks, so a mechanical update would advance it. Read from the compare
 * API's behind_by, deliberately NOT from the PR's mergeStateStatus: that field
 * reports DRAFT for a draft PR (masking BEHIND, and every agent PR opens as a
 * draft), and only surfaces BEHIND at all when "require branches up to date"
 * branch protection is on — otherwise a stale-but-clean PR reads CLEAN. The
 * compare is reliable under every configuration.
 */
async function prBehindBase(
  base: string,
  head: string,
  exec: Exec,
): Promise<boolean> {
  const stdout = await exec("gh", [
    "api",
    `repos/{owner}/{repo}/compare/${base}...${head}`,
  ]);
  const comparison = JSON.parse(stdout) as { behind_by?: number };
  return (comparison.behind_by ?? 0) > 0;
}

/**
 * The CI standing of a head commit from its check-run rollup. Empty is `none`
 * — no checks configured, which the draft→ready gate reads as green. Otherwise
 * any incomplete or unsuccessful check is decisive: one failure fails the
 * whole rollup, one still-running check holds it pending, and only an all-green
 * rollup passes. Handles both modern check-runs (status/conclusion) and legacy
 * commit-status contexts (state).
 */
function ciFromRollup(rollup: RollupCheck[]): CiState {
  if (rollup.length === 0) return "none";
  let pending = false;
  for (const check of rollup) {
    if (check.status !== undefined) {
      if (check.status !== "COMPLETED") {
        pending = true;
        continue;
      }
      if (
        check.conclusion === "SUCCESS" ||
        check.conclusion === "NEUTRAL" ||
        check.conclusion === "SKIPPED"
      ) {
        continue;
      }
      return "failing";
    }
    if (check.state === "SUCCESS") continue;
    if (check.state === "PENDING" || check.state === "EXPECTED") {
      pending = true;
      continue;
    }
    return "failing";
  }
  return pending ? "pending" : "passing";
}

/**
 * True when a conflict-resolution Worker already asked for human help on this
 * PR — the unresolved marker sits in its comment thread. Read only for
 * conflicted PRs, where it alone decides whether another Worker is dispatched.
 */
async function readConflictWorkerAsked(
  pr: number,
  exec: Exec,
): Promise<boolean> {
  const comments = await readPages<{ body?: string }>(
    `repos/{owner}/{repo}/issues/${pr}/comments?per_page=100`,
    exec,
  );
  return comments.some((comment) =>
    comment.body?.includes(CONFLICT_UNRESOLVED_MARKER),
  );
}

/**
 * Open agent PRs with the upkeep signals GitHub computes lazily (mergeability,
 * CI rollup), read in one `gh pr list` call — capped at 100, far above the
 * max_open_prs the fleet throttles itself to. Non-agent branches are dropped.
 * Behind-ness is then read per cleanly-mergeable PR (a conflicted one is
 * handled before any update, an unknown one left for the next Tick), and a
 * conflicted PR's comments for the unresolved marker.
 */
async function listOpenAgentPrs(exec: Exec): Promise<OpenAgentPr[]> {
  const stdout = await exec("gh", [
    "pr",
    "list",
    "--state",
    "open",
    "--limit",
    "100",
    "--json",
    "number,headRefName,baseRefName,isDraft,mergeable,statusCheckRollup",
  ]);
  const items = JSON.parse(stdout) as GhPrListItem[];
  const prs: OpenAgentPr[] = [];
  for (const item of items) {
    const headRef = item.headRefName ?? "";
    const ticket = ticketFromAgentBranch(headRef);
    if (ticket === undefined) continue;
    const mergeable = mergeabilityOf(item.mergeable);
    const base = item.baseRefName ?? "";
    prs.push({
      number: item.number,
      ticket,
      headRef,
      draft: item.isDraft ?? false,
      mergeable,
      behind:
        mergeable === "mergeable" && base !== ""
          ? await prBehindBase(base, headRef, exec)
          : false,
      ci: ciFromRollup(item.statusCheckRollup ?? []),
      conflictWorkerAsked:
        mergeable === "conflicted"
          ? await readConflictWorkerAsked(item.number, exec)
          : false,
    });
  }
  return prs;
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
export async function readScope(
  scope: Scope,
  exec: Exec = realExec,
): Promise<WorldSnapshot> {
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
  // picks the retry rung or triggers Escalation). Blocker lists are read for
  // open blocked tickets — the Stuck report names them.
  for (const ticket of tickets) {
    if (ticket.state !== "open") continue;
    const isDispatchCandidate =
      ticket.labels.includes(READY_FOR_AGENT) && ticket.openBlockers === 0;
    if (ticket.assignees.length > 0 || isDispatchCandidate) {
      const history = await readClaimHistory(ticket.number, exec);
      ticket.hasAgentClaim = history.hasAgentClaim;
      ticket.agentClaimCount = history.agentClaimCount;
      ticket.attemptFailures = history.attemptFailures;
    }
    if (ticket.openBlockers > 0) {
      ticket.blockedBy = await readOpenBlockers(ticket.number, exec);
    }
  }

  // Agent PRs matter only while open tickets exist: orphan detection, the
  // escalation veto, the max_open_prs throttle, and PR upkeep read the open
  // ones, closure verification the merged ones. A fully closed Scope needs
  // neither read.
  const hasOpenTickets = tickets.some((t) => t.state === "open");
  const inScope = new Set(tickets.map((t) => t.number));
  const openAgentPrs = hasOpenTickets ? await listOpenAgentPrs(exec) : [];
  const mergedAgentPrs = hasOpenTickets
    ? (await listMergedAgentPrs(exec)).filter((pr) => inScope.has(pr.ticket))
    : [];

  return { tickets, openAgentPrs, mergedAgentPrs };
}

const CLAIM_COMMENT = `${CLAIM_MARKER}\n🐕 Claimed by border-collie: a Worker will be dispatched against this ticket. This assignment is agent-held — see CONTEXT.md "Claim".`;

const RELEASE_COMMENT = `${RELEASE_MARKER}\n🐕 border-collie released an orphaned claim (no live Worker, no open agent PR). The ticket is dispatchable again.`;

/**
 * Act phase: claim a ticket — assign the working identity, then post the
 * marker comment, as the first writes against the ticket. Assignment goes
 * first (the wayfinder protocol border-collie inherits); a crash in between
 * leaves the ticket looking human-claimed, which fails safe: hands off.
 */
export async function claimTicket(
  ticket: number,
  exec: Exec = realExec,
): Promise<void> {
  await exec("gh", ["issue", "edit", String(ticket), "--add-assignee", "@me"]);
  await exec("gh", [
    "issue",
    "comment",
    String(ticket),
    "--body",
    CLAIM_COMMENT,
  ]);
}

/**
 * The shared release shape: unassign first — a crash in between leaves the
 * ticket unassigned with a stale claim marker, which the next Tick claims
 * afresh (self-healing). The release marker then neutralizes the claim
 * marker so a later human assignment is never misread as agent-held.
 */
async function release(
  ticket: number,
  assignees: string,
  body: string,
  exec: Exec,
): Promise<void> {
  await exec("gh", [
    "issue",
    "edit",
    String(ticket),
    "--remove-assignee",
    assignees,
  ]);
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
  await exec("gh", [
    "issue",
    "close",
    String(ticket),
    "--comment",
    closeComment(prUrl),
  ]);
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
      ? [
          "(no attempt records found — the claims were likely released as orphans after crashes)",
        ]
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

/**
 * Act phase: mechanically rebase a cleanly-mergeable PR that has fallen behind
 * onto its base. GitHub does the rebase server-side — no worktree, no judgment
 * — so a sibling stays current after every merge. Rebase, never a merge
 * commit: agent branches stay linear so the operator's "Rebase and merge"
 * strategy stays available (a merge-commit update would make GitHub refuse it
 * — replaying the branch's commits drops the merge commit and its resolutions,
 * so the original commits re-conflict).
 */
export async function updatePrBranch(
  pr: number,
  exec: Exec = realExec,
): Promise<void> {
  await exec("gh", ["pr", "update-branch", String(pr), "--rebase"]);
}

/** Act phase: flip a draft PR to ready-for-review, surfacing it to the reviewer. */
export async function markPrReady(
  pr: number,
  exec: Exec = realExec,
): Promise<void> {
  await exec("gh", ["pr", "ready", String(pr)]);
}

const CONFLICT_UNRESOLVED_COMMENT = `${CONFLICT_UNRESOLVED_MARKER}\n🐕 border-collie ran a conflict-resolution Worker here, but it could not complete the rebase onto the base branch. This PR needs a human to resolve the conflicts — border-collie will not dispatch another Worker for it.`;

/**
 * Act phase: mark a PR's conflict as human-owned after the conflict Worker
 * gave up. The marker in this comment is what stops the next Tick dispatching
 * a second Worker against a conflict a human now holds — the PR-level analogue
 * of Escalation's forensic comment.
 */
export async function commentConflictUnresolved(
  pr: number,
  exec: Exec = realExec,
): Promise<void> {
  await exec("gh", [
    "pr",
    "comment",
    String(pr),
    "--body",
    CONFLICT_UNRESOLVED_COMMENT,
  ]);
}
