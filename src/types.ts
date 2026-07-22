/**
 * Domain types for the observe → plan → act Tick architecture.
 * Vocabulary follows CONTEXT.md.
 */

export const READY_FOR_AGENT = "ready-for-agent";
export const READY_FOR_HUMAN = "ready-for-human";

/** A Ticket gets at most this many Attempts before Escalation (CONTEXT.md). */
export const MAX_ATTEMPTS = 2;

/**
 * Hidden HTML markers that make a claim structurally border-collie's
 * (CONTEXT.md "Claim"): the latest marker comment on a ticket decides.
 * Claims and releases are append-only — no comment is ever deleted.
 */
export const CLAIM_MARKER = "<!-- border-collie:claim -->";
export const RELEASE_MARKER = "<!-- border-collie:release -->";

/**
 * The ticket-failure triggers (CONTEXT.md "Ticket failure"): every way a
 * Worker can die that counts against the ticket's Attempts.
 */
export type FailureReason = "nonzero-exit" | "no-commits" | "timeout" | "stall" | "budget";

export const FAILURE_DESCRIPTIONS: Record<FailureReason, string> = {
  "nonzero-exit": "the Worker process exited non-zero",
  "no-commits": "the Worker exited cleanly but committed nothing",
  timeout: "the Worker hit the wall-clock timeout",
  stall: "the Worker produced no output events for the stall window",
  budget: "the Worker breached a budget backstop (turn or cost cap)",
};

/**
 * The infrastructure-failure classes (CONTEXT.md "Infrastructure failure"):
 * environment problems that void the Attempt and trip the circuit breaker
 * instead of burning Attempts. `correlated` is the same-way-same-Tick
 * heuristic: several Workers dying identically is an environment problem,
 * not a coincidence of tickets.
 */
export type InfraReason = "usage-limit" | "rate-limit" | "auth" | "network" | "correlated";

export const INFRA_DESCRIPTIONS: Record<InfraReason, string> = {
  "usage-limit": "the account usage limit was reached",
  "rate-limit": "the API rate-limited requests",
  auth: "authentication with the API failed",
  network: "the network was unreachable",
  correlated: "several Workers failed the same way within one Tick",
};

/**
 * Hidden HTML marker on a comment that voids the preceding claim: the
 * Attempt died to the environment, so it counts as nothing. Unlike a release
 * marker it does NOT surrender the claim — the ticket stays agent-held while
 * the circuit breaker waits out the outage.
 */
export const VOID_MARKER = "<!-- border-collie:void -->";

/**
 * One failed Attempt's forensics, embedded in its release comment so attempt
 * history lives on the tracker (the only state store) and Escalation can cite
 * evidence without any local record.
 */
export interface AttemptFailure {
  attempt: number;
  reason: FailureReason;
  /** Model the attempt ran on. */
  model: string;
  /** Abandoned agent branch the attempt committed to (worktree torn down). */
  branch: string;
  /** Transcript file path at the target repo root, for post-mortems. */
  transcript: string;
}

const ATTEMPT_MARKER_OPEN = "<!-- border-collie:attempt ";
const ATTEMPT_MARKER_CLOSE = " -->";

/** Hidden HTML marker carrying one attempt's forensics as JSON. */
export function attemptMarker(failure: AttemptFailure): string {
  return `${ATTEMPT_MARKER_OPEN}${JSON.stringify(failure)}${ATTEMPT_MARKER_CLOSE}`;
}

/**
 * The attempt record in a comment body, or undefined when absent or mangled.
 * Shape-checked: comment bodies are world input, edited or truncated by
 * anyone with tracker access.
 */
export function parseAttemptMarker(body: string): AttemptFailure | undefined {
  const start = body.indexOf(ATTEMPT_MARKER_OPEN);
  if (start === -1) return undefined;
  const rest = body.slice(start + ATTEMPT_MARKER_OPEN.length);
  const end = rest.indexOf(ATTEMPT_MARKER_CLOSE);
  if (end === -1) return undefined;
  try {
    const parsed = JSON.parse(rest.slice(0, end)) as Partial<AttemptFailure>;
    const wellFormed =
      typeof parsed.attempt === "number" &&
      typeof parsed.reason === "string" &&
      parsed.reason in FAILURE_DESCRIPTIONS &&
      typeof parsed.model === "string" &&
      typeof parsed.branch === "string" &&
      typeof parsed.transcript === "string";
    return wellFormed ? (parsed as AttemptFailure) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Branch naming that makes a PR structurally an agent PR. Workers land with
 * a later ticket; the convention is fixed here because orphan detection
 * already reads it.
 */
export const AGENT_BRANCH_PREFIX = "border-collie/ticket-";

/**
 * Ticket number encoded in an agent branch name, or undefined for other
 * branches. Deliberately tolerates a suffix after the number
 * (`border-collie/ticket-8-slug`) so Workers may append one later.
 */
export function ticketFromAgentBranch(headRef: string): number | undefined {
  if (!headRef.startsWith(AGENT_BRANCH_PREFIX)) return undefined;
  const match = /^\d+/.exec(headRef.slice(AGENT_BRANCH_PREFIX.length));
  return match ? Number(match[0]) : undefined;
}

/** A tracker issue in Scope, as observed on GitHub at the start of a Tick. */
export interface Ticket {
  number: number;
  title: string;
  state: "open" | "closed";
  /** Assignee logins. Any assignee at all makes the ticket non-dispatchable. */
  assignees: string[];
  /** Label names. */
  labels: string[];
  /** Count of open blocking issues (GitHub native issue dependencies). */
  openBlockers: number;
  /**
   * True when the ticket's latest border-collie marker comment is a claim
   * marker. An assignee without it is a human claim — hands off (CONTEXT.md
   * "Claim").
   */
  hasAgentClaim: boolean;
  /**
   * Count of claim marker comments ever posted, minus voided ones — the
   * stateless Attempt counter: each Attempt is preceded by exactly one claim,
   * and an infrastructure-voided Attempt counts as nothing.
   */
  agentClaimCount: number;
  /** Attempt records parsed from release comments, in comment order. */
  attemptFailures: AttemptFailure[];
}

/**
 * A merged agent PR observed for a ticket in Scope. Input to closure
 * verification: a merge whose close keyword failed to fire leaves the ticket
 * open, and an open ticket freezes its dependents (CONTEXT.md "Done").
 */
export interface MergedAgentPr {
  ticket: number;
  url: string;
}

/** Everything the planner knows about the world, recomputed each Tick. */
export interface WorldSnapshot {
  tickets: Ticket[];
  /** Ticket numbers with an open agent PR (head branch carries the agent prefix). */
  openAgentPrTickets: number[];
  /** Merged agent PRs whose ticket is in Scope, latest per ticket. */
  mergedAgentPrs: MergedAgentPr[];
}

export interface PlanConfig {
  maxWorkers: number;
  /** Open agent PRs at or above this cap pause dispatch (review bandwidth). */
  maxOpenPrs: number;
  /**
   * True while the circuit breaker is open: the environment is failing, so
   * the plan pauses dispatch and keeps claims held — only closure
   * verification (pure bookkeeping of already-merged work) still runs.
   * Omitted means closed (dispatch flows).
   */
  dispatchPaused?: boolean;
}

/**
 * One intended write, produced by the pure plan phase.
 * A discriminated union that later tickets extend (open PR, ...). `release`
 * carries the observed assignee logins and `escalate` the observed attempt
 * records so the act phase needs no second look at the world. `spawn` carries
 * the attempt number; the caller binds it to a model (the retry ladder).
 */
export type Action =
  | { type: "claim"; ticket: number }
  | { type: "release"; ticket: number; assignees: string[] }
  | { type: "spawn"; ticket: number; attempt: number }
  | { type: "escalate"; ticket: number; failures: AttemptFailure[] }
  | { type: "close"; ticket: number; prUrl: string };
