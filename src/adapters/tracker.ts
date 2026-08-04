import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Scope } from "../core/config.js";
import { type Log, scrubCredentials } from "../core/log.js";
import {
  type AttemptFailure,
  attemptMarker,
  type CiState,
  CLAIM_LABEL,
  CLAIM_MARKER,
  CONFLICT_UNRESOLVED_MARKER,
  FAILURE_DESCRIPTIONS,
  type FailureReason,
  INFRA_DESCRIPTIONS,
  type InfraReason,
  MAX_ATTEMPTS,
  MAX_REFINEMENT_ROUNDS,
  type Mergeability,
  type MergedAgentPr,
  OPERATOR_STEERED_LABEL,
  type OpenAgentPr,
  parseAttemptMarker,
  READY_FOR_AGENT,
  READY_FOR_HUMAN,
  REFINEMENT_GIVE_UP_MARKER,
  REFINEMENT_ROUND_MARKER,
  RELEASE_MARKER,
  type RefinementSignal,
  type Ticket,
  ticketFromAgentBranch,
  VOID_MARKER,
  type WorldSnapshot,
} from "../core/types.js";

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

/** The numeric exit code on a failed `execFile`, or null when the process never reported one (e.g. it never spawned). */
function exitCodeOf(error: unknown): number | null {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code: unknown }).code === "number"
  ) {
    return (error as { code: number }).code;
  }
  return null;
}

/**
 * Decorates an `Exec` with a `debug` event per call, carrying the command and
 * its exit code — detail that does not exist today, so an operator can see
 * every `gh`/`git` command the Orchestrator actually issued, and how it
 * exited, without reproducing the run. `gh` and `git` read auth from the
 * environment, never argv, so `cmd`/`args` never carry a credential in
 * practice — but the logged form is scrubbed defensively anyway (see
 * `scrubCredentials`, verified by the "withDebugLogging" tests below) rather
 * than resting on that as an unverified claim. The real `exec` call below
 * still receives the unscrubbed `args`, so scrubbing never changes what
 * actually runs.
 */
export function withDebugLogging(exec: Exec, log: Log): Exec {
  return async (cmd, args) => {
    const safeArgs = args.map(scrubCredentials);
    try {
      const stdout = await exec(cmd, args);
      log({
        kind: "tracker-command",
        level: "debug",
        msg: `${cmd} ${safeArgs.join(" ")} (exit 0)`,
        cmd,
        args: safeArgs,
        exitCode: 0,
      });
      return stdout;
    } catch (error) {
      const exitCode = exitCodeOf(error);
      log({
        kind: "tracker-command",
        level: "debug",
        msg: `${cmd} ${safeArgs.join(" ")} (exit ${exitCode ?? "unknown"})`,
        cmd,
        args: safeArgs,
        exitCode,
      });
      throw error;
    }
  };
}

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
    voidedAtMs: undefined,
    lastFailureAtMs: undefined,
    lastFailureReason: undefined,
    hasLiveWorker: false,
  };
}

/** A comment's `created_at`, parsed to epoch ms — undefined when absent or unparseable. */
function commentTimestamp(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? undefined : ms;
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
  voidedAtMs: number | undefined;
  lastFailureAtMs: number | undefined;
  lastFailureReason: FailureReason | undefined;
}

/**
 * One pass over a ticket's comments, oldest first. The latest border-collie
 * marker comment decides claim ownership: a claim marker after any release
 * marker means the assignment is agent-held. The claim markers ever posted
 * count Attempts (each Attempt is preceded by exactly one claim), a void
 * marker uncounts the claim it follows (an infrastructure death burns
 * nothing) while leaving the claim held, and release comments carry the
 * failed attempts' forensic records. All append-only, so history stays
 * auditable and attempt state needs no local store. `voidedAtMs` tracks
 * whether a void marker is still the latest one — a later claim or release
 * resolves it — so the circuit breaker can be derived from it fresh each Tick
 * (CONTEXT.md "Infrastructure failure"). `lastFailureAtMs`/`lastFailureReason`
 * track the same thing for a Ticket-failure release instead of a void — reset
 * by a later claim exactly like `voidedAtMs`, and left undefined by a release
 * carrying no attempt record (an orphan release) — feeding the correlation
 * heuristic recomputed at Tick time (issue #73; `classify.ts`'s
 * `correlatedFailureTimestampsMs`).
 */
async function readClaimHistory(
  ticket: number,
  exec: Exec,
): Promise<ClaimHistory> {
  const comments = await readPages<{ body?: string; created_at?: string }>(
    `repos/{owner}/{repo}/issues/${ticket}/comments?per_page=100`,
    exec,
  );
  const history: ClaimHistory = {
    hasAgentClaim: false,
    agentClaimCount: 0,
    attemptFailures: [],
    voidedAtMs: undefined,
    lastFailureAtMs: undefined,
    lastFailureReason: undefined,
  };
  for (const comment of comments) {
    if (comment.body?.includes(CLAIM_MARKER)) {
      history.hasAgentClaim = true;
      history.agentClaimCount += 1;
      history.voidedAtMs = undefined;
      history.lastFailureAtMs = undefined;
      history.lastFailureReason = undefined;
    } else if (comment.body?.includes(VOID_MARKER)) {
      history.agentClaimCount = Math.max(0, history.agentClaimCount - 1);
      history.voidedAtMs = commentTimestamp(comment.created_at);
    } else if (comment.body?.includes(RELEASE_MARKER)) {
      history.hasAgentClaim = false;
      history.voidedAtMs = undefined;
      const failure = parseAttemptMarker(comment.body);
      if (failure) {
        history.attemptFailures.push(failure);
        history.lastFailureAtMs = commentTimestamp(comment.created_at);
        history.lastFailureReason = failure.reason;
      } else {
        history.lastFailureAtMs = undefined;
        history.lastFailureReason = undefined;
      }
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
  labels?: { name: string }[];
  createdAt?: string;
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

/** What one pass over a PR's issue-comment thread decides for PR upkeep. */
interface PrCommentSignals {
  conflictWorkerAsked: boolean;
  refinement: RefinementSignal;
}

/** The more recent of two possibly-absent timestamps. */
function maxDefined(
  a: number | undefined,
  b: number | undefined,
): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.max(a, b);
}

/**
 * The latest formal PR-review activity — GitHub's Review flow, a distinct API
 * surface from the Conversation-tab comments read below: inline review
 * comments (`pulls/{pr}/comments`) and review submissions (`pulls/{pr}/reviews`)
 * that either request changes or carry a body (an approval with no comment is
 * not feedback needing a fix). Only called when it could still change the
 * Refinement trigger verdict — `readPrCommentSignals` skips it otherwise, so
 * this never runs for a conflicted, operator-steered, already-given-up, or
 * already-failing-check PR.
 */
async function readPrReviewActivity(
  pr: number,
  exec: Exec,
): Promise<number | undefined> {
  const [reviewComments, reviews] = await Promise.all([
    readPages<{ created_at?: string }>(
      `repos/{owner}/{repo}/pulls/${pr}/comments?per_page=100`,
      exec,
    ),
    readPages<{ state?: string; submitted_at?: string; body?: string | null }>(
      `repos/{owner}/{repo}/pulls/${pr}/reviews?per_page=100`,
      exec,
    ),
  ]);
  const timestamps = [
    ...reviewComments.map((c) => commentTimestamp(c.created_at)),
    ...reviews
      .filter(
        (r) => r.state === "CHANGES_REQUESTED" || (r.body ?? "").trim() !== "",
      )
      .map((r) => commentTimestamp(r.submitted_at)),
  ].filter((ms): ms is number => ms !== undefined);
  return timestamps.length > 0 ? Math.max(...timestamps) : undefined;
}

/**
 * One read of a PR's issue-comment thread, serving every PR-upkeep marker
 * check that lives in its comments: whether a conflict Worker already asked
 * for a human (CONTEXT.md "Conflict Worker"), and the Refinement round state
 * (CONTEXT.md "Refinement round") — the round count, whether give-up already
 * fired, and whether a fresh trigger warrants another round. A trigger is a
 * failing check (independent of comments — passed in already computed), a
 * formal PR review (`readPrReviewActivity`), or a foreign comment — one
 * carrying none of border-collie's own markers — posted after the latest
 * round comment, or after the PR opened when there has been none.
 * `checkRefinementTrigger` is false for a conflicted PR (plan.ts's conflict
 * handling is exclusive, so the verdict is never consulted) or an
 * operator-steered one (CONTEXT.md "Operator-steered") — the round-marker
 * scan still runs either way, since a conflicted PR's conflict-unresolved
 * marker lives in the same thread and an operator-steered PR's round count
 * must survive the label being lifted later, but the extra review-activity
 * reads are skipped as dead weight.
 */
async function readPrCommentSignals(
  pr: number,
  createdAtMs: number,
  ci: CiState,
  checkRefinementTrigger: boolean,
  exec: Exec,
): Promise<PrCommentSignals> {
  const comments = await readPages<{ body?: string; created_at?: string }>(
    `repos/{owner}/{repo}/issues/${pr}/comments?per_page=100`,
    exec,
  );
  let conflictWorkerAsked = false;
  let rounds = 0;
  let givenUp = false;
  let latestRoundAtMs = createdAtMs;
  let latestForeignCommentAtMs: number | undefined;
  for (const comment of comments) {
    const body = comment.body ?? "";
    if (body.includes(CONFLICT_UNRESOLVED_MARKER)) {
      conflictWorkerAsked = true;
    } else if (body.includes(REFINEMENT_ROUND_MARKER)) {
      rounds += 1;
      latestRoundAtMs = commentTimestamp(comment.created_at) ?? latestRoundAtMs;
    } else if (body.includes(REFINEMENT_GIVE_UP_MARKER)) {
      givenUp = true;
    } else {
      latestForeignCommentAtMs =
        commentTimestamp(comment.created_at) ?? latestForeignCommentAtMs;
    }
  }
  if (!checkRefinementTrigger || givenUp) {
    return {
      conflictWorkerAsked,
      refinement: { rounds, triggerDue: false, givenUp },
    };
  }
  const latestReviewAtMs =
    ci === "failing" ? undefined : await readPrReviewActivity(pr, exec);
  const latestTriggerAtMs = maxDefined(
    latestForeignCommentAtMs,
    latestReviewAtMs,
  );
  const triggerDue =
    ci === "failing" ||
    (latestTriggerAtMs !== undefined && latestTriggerAtMs > latestRoundAtMs);
  return {
    conflictWorkerAsked,
    refinement: { rounds, triggerDue, givenUp: false },
  };
}

/**
 * Open agent PRs with the upkeep signals GitHub computes lazily (mergeability,
 * CI rollup), read in one `gh pr list` call — capped at 100, far above the
 * max_open_prs the fleet throttles itself to. Non-agent branches are dropped.
 * Behind-ness is then read per cleanly-mergeable PR (a conflicted one is
 * handled before any update, an unknown one left for the next Tick), and
 * every PR's comment thread once for the conflict and Refinement marker
 * signals together (`readPrCommentSignals`).
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
    "number,headRefName,baseRefName,isDraft,mergeable,statusCheckRollup,labels,createdAt",
  ]);
  const items = JSON.parse(stdout) as GhPrListItem[];
  const prs: OpenAgentPr[] = [];
  for (const item of items) {
    const headRef = item.headRefName ?? "";
    const ticket = ticketFromAgentBranch(headRef);
    if (ticket === undefined) continue;
    const mergeable = mergeabilityOf(item.mergeable);
    const base = item.baseRefName ?? "";
    const ci = ciFromRollup(item.statusCheckRollup ?? []);
    const operatorSteered = (item.labels ?? []).some(
      (label) => label.name === OPERATOR_STEERED_LABEL,
    );
    const createdAtMs = commentTimestamp(item.createdAt) ?? 0;
    const signals = await readPrCommentSignals(
      item.number,
      createdAtMs,
      ci,
      !operatorSteered && mergeable !== "conflicted",
      exec,
    );
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
      ci,
      conflictWorkerAsked: signals.conflictWorkerAsked,
      operatorSteered,
      refinement: signals.refinement,
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
 * The GitHub Actions workflow file a Worker job runs from (issue #75),
 * dispatched with the Ticket and Attempt as explicit workflow_dispatch
 * inputs — never inferred from a label or an assignee event, since the
 * Orchestrator already knows which Ticket it decided to dispatch.
 */
export const WORKER_WORKFLOW_FILE = "border-collie-worker.yml";

const WORKER_RUN_NAME_PREFIX = "border-collie worker #";

/**
 * The `run-name:` the Worker workflow (issue #75) must set from its ticket
 * and attempt inputs, so a running job's ticket is readable from the run
 * list below without decoding workflow_dispatch inputs — the REST API never
 * echoes those back on the run itself.
 */
export function workerRunName(ticket: number, attempt: number): string {
  return `${WORKER_RUN_NAME_PREFIX}${ticket} attempt ${attempt}`;
}

function ticketFromWorkerRunName(displayTitle: string): number | undefined {
  if (!displayTitle.startsWith(WORKER_RUN_NAME_PREFIX)) return undefined;
  const match = /^\d+/.exec(displayTitle.slice(WORKER_RUN_NAME_PREFIX.length));
  return match ? Number(match[0]) : undefined;
}

interface GhWorkflowRun {
  status?: string;
  displayTitle?: string;
}

/**
 * Ticket numbers with a Worker job GitHub has not yet marked `completed` —
 * queued, in progress, or otherwise still running. Worker liveness read from
 * GitHub itself (issue #64, #73) rather than a promise held in the
 * Orchestrator's memory: a restarted Orchestrator reaches the same verdict,
 * and a job GitHub itself already finished (whether it settled cleanly or
 * was killed by its own wall-clock ceiling) is never mistaken for one still
 * live, so the orphan check can release its Claim.
 */
export async function liveWorkerTickets(
  exec: Exec = realExec,
): Promise<Set<number>> {
  const stdout = await exec("gh", [
    "run",
    "list",
    "--workflow",
    WORKER_WORKFLOW_FILE,
    "--json",
    "status,displayTitle",
    "--limit",
    "100",
  ]);
  const runs = JSON.parse(stdout) as GhWorkflowRun[];
  const live = new Set<number>();
  for (const run of runs) {
    if (run.status === "completed") continue;
    const ticket = ticketFromWorkerRunName(run.displayTitle ?? "");
    if (ticket !== undefined) live.add(ticket);
  }
  return live;
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

  // Claim history is read where it can matter: claim-labelled tickets (claim
  // ownership, even a blocked one) and unassigned dispatch candidates (the
  // Attempt counter that picks the retry rung or triggers Escalation).
  // Blocker lists are read for open blocked tickets — the Stuck report names
  // them.
  for (const ticket of tickets) {
    if (ticket.state !== "open") continue;
    const isDispatchCandidate =
      ticket.labels.includes(READY_FOR_AGENT) && ticket.openBlockers === 0;
    if (ticket.labels.includes(CLAIM_LABEL) || isDispatchCandidate) {
      const history = await readClaimHistory(ticket.number, exec);
      ticket.hasAgentClaim = history.hasAgentClaim;
      ticket.agentClaimCount = history.agentClaimCount;
      ticket.attemptFailures = history.attemptFailures;
      ticket.voidedAtMs = history.voidedAtMs;
      ticket.lastFailureAtMs = history.lastFailureAtMs;
      ticket.lastFailureReason = history.lastFailureReason;
    }
    if (ticket.openBlockers > 0) {
      ticket.blockedBy = await readOpenBlockers(ticket.number, exec);
    }
  }

  // Worker liveness matters only for a ticket the orphan check could
  // otherwise mistake for abandoned: open, claim-labelled, no PR yet because
  // its Worker (local or remote) has not finished. Read once, repo-wide, and
  // fanned back onto every such ticket — cheaper than one call per ticket,
  // and the same shape as the PR listings below.
  const claimedOpenTickets = tickets.filter(
    (t) => t.state === "open" && t.labels.includes(CLAIM_LABEL),
  );
  if (claimedOpenTickets.length > 0) {
    const live = await liveWorkerTickets(exec);
    for (const ticket of claimedOpenTickets) {
      ticket.hasLiveWorker = live.has(ticket.number);
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

/**
 * A single ticket's title, read directly rather than through `readScope`: the
 * Worker entrypoint (issue #71) has no world snapshot of its own — just the
 * ticket and Attempt it was told to run — so it fetches the one field its PR
 * title needs.
 */
export async function readTicketTitle(
  ticket: number,
  exec: Exec = realExec,
): Promise<string> {
  const stdout = await exec("gh", [
    "api",
    `repos/{owner}/{repo}/issues/${ticket}`,
  ]);
  const issue = JSON.parse(stdout) as { title?: string };
  return issue.title ?? `Ticket #${ticket}`;
}

const CLAIM_COMMENT = `${CLAIM_MARKER}\n🐕 Claimed by border-collie: a Worker will be dispatched against this ticket. This claim is agent-held — see CONTEXT.md "Claim".`;

const RELEASE_COMMENT = `${RELEASE_MARKER}\n🐕 border-collie released an orphaned claim (no live Worker, no open agent PR). The ticket is dispatchable again.`;

/**
 * Act phase: claim a ticket — add the claim label, then post the marker
 * comment, as the first writes against the ticket. The label goes first (an
 * App identity can still hold a label even though it cannot be an issue
 * assignee); a crash in between leaves the ticket labelled with no marker,
 * which fails safe: not dispatchable, but not recognized as an orphan either
 * (CONTEXT.md "Claim" — the marker is what proves the label agent-held), so
 * it is parked for a human to notice rather than silently released.
 */
export async function claimTicket(
  ticket: number,
  exec: Exec = realExec,
): Promise<void> {
  await exec("gh", [
    "issue",
    "edit",
    String(ticket),
    "--add-label",
    CLAIM_LABEL,
  ]);
  await exec("gh", [
    "issue",
    "comment",
    String(ticket),
    "--body",
    CLAIM_COMMENT,
  ]);
}

/**
 * The shared release shape: remove the claim label first — a crash in
 * between leaves the ticket unlabelled with a stale claim marker, which the
 * next Tick claims afresh (self-healing). The release marker then
 * neutralizes the claim marker so a later human assignment is never misread
 * as agent-held.
 */
async function release(
  ticket: number,
  body: string,
  exec: Exec,
): Promise<void> {
  await exec("gh", [
    "issue",
    "edit",
    String(ticket),
    "--remove-label",
    CLAIM_LABEL,
  ]);
  await exec("gh", ["issue", "comment", String(ticket), "--body", body]);
}

/** Act phase: release an orphaned claim back to unclaimed. */
export async function releaseTicket(
  ticket: number,
  exec: Exec = realExec,
): Promise<void> {
  await release(ticket, RELEASE_COMMENT, exec);
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
 * retry ladder and a later Escalation read back. `forensics` (the rendered
 * result facts, tool histogram, and final turns — see `renderForensicReport`)
 * is appended so the comment is triageable on its own, without the transcript
 * path a runner may have already discarded.
 */
export async function releaseFailedTicket(
  ticket: number,
  failure: AttemptFailure,
  forensics: string,
  exec: Exec = realExec,
): Promise<void> {
  const body = [
    RELEASE_MARKER,
    attemptMarker(failure),
    `🐕 Attempt ${failure.attempt} failed: ${FAILURE_DESCRIPTIONS[failure.reason]} (model ${failure.model}).`,
    `Worktree torn down; branch \`${failure.branch}\` abandoned; transcript at \`${failure.transcript}\`.`,
    "",
    forensics,
  ].join("\n");
  await release(ticket, body, exec);
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
 * with no trigger left to write them. The claim label is already off: only
 * unclaimed, unassigned tickets escalate (every failure or orphan release
 * removes the claim label first), so no claim-label write belongs here.
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

/**
 * Act phase: convert a PR back to draft, so it cannot be merged until someone
 * looks at it again (ADR 0007). A draft is GitHub's own merge veto, which is
 * why nothing here needs to know the target repository's toolchain: the
 * verifier is that repository's CI, read through the standing the world
 * snapshot already models, and the existing draft→ready flip lifts the veto
 * once it comes back green. The inverse of `markPrReady` and issued the same
 * way — a single unconditional write, with no read of the PR's current draft
 * state first: `gh pr ready --undo` warns and exits clean against a PR that is
 * already a draft, so re-drafting one changes nothing.
 */
export async function markPrDraft(
  pr: number,
  exec: Exec = realExec,
): Promise<void> {
  await exec("gh", ["pr", "ready", String(pr), "--undo"]);
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

const refinementRoundComment = (round: number) =>
  `${REFINEMENT_ROUND_MARKER}\n🐕 Refinement round ${round} of ${MAX_REFINEMENT_ROUNDS}: a failing check or review feedback needs a fix — dispatching a Worker to investigate and commit one.`;

/**
 * Act phase: start a Refinement round (CONTEXT.md "Refinement round") — the
 * marker comment first, before the round's Worker ever dispatches, so a
 * crashed Worker still charges the round it was given rather than letting a
 * retry-on-crash exceed MAX_REFINEMENT_ROUNDS uncounted (the same
 * charge-before-spend shape as `claimTicket`'s Attempt count).
 */
export async function startRefinementRound(
  pr: number,
  round: number,
  exec: Exec = realExec,
): Promise<void> {
  await exec("gh", [
    "pr",
    "comment",
    String(pr),
    "--body",
    refinementRoundComment(round),
  ]);
}

const refinementGiveUpTicketComment = (pr: number, rounds: number) =>
  `🐕 Refinement give-up: pull request #${pr} exhausted ${rounds} round${rounds === 1 ? "" : "s"} of ${MAX_REFINEMENT_ROUNDS} without a clean check and review — this ticket needs a human. See #${pr} for the Refinement history.`;

const refinementGiveUpPrComment = (rounds: number) =>
  `${REFINEMENT_GIVE_UP_MARKER}\n🐕 border-collie gave up refining this pull request after ${rounds} round${rounds === 1 ? "" : "s"} of ${MAX_REFINEMENT_ROUNDS} — handing its ticket to a human. See the refinement-round comments above for what each round tried.`;

/**
 * Act phase: give up Refining a pull request whose rounds are exhausted but
 * still needs one (CONTEXT.md "Refinement give-up") — the PR-scoped analogue
 * of Escalation. The Ticket's forensic comment and label swap land first,
 * the PR's give-up marker last: that marker is the sole thing
 * `readPrCommentSignals` trusts to veto every further round, so posting it
 * only once the Ticket side is durable means a crash mid-way retries the
 * whole sequence next Tick (worst case a duplicate Ticket comment) rather
 * than stranding the Ticket `ready-for-agent` with no round left to spend.
 */
export async function giveUpOnPr(
  pr: number,
  ticket: number,
  rounds: number,
  exec: Exec = realExec,
): Promise<void> {
  await exec("gh", [
    "issue",
    "comment",
    String(ticket),
    "--body",
    refinementGiveUpTicketComment(pr, rounds),
  ]);
  await exec("gh", [
    "issue",
    "edit",
    String(ticket),
    "--remove-label",
    READY_FOR_AGENT,
    "--add-label",
    READY_FOR_HUMAN,
  ]);
  await exec("gh", [
    "pr",
    "comment",
    String(pr),
    "--body",
    refinementGiveUpPrComment(rounds),
  ]);
}
