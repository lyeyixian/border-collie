/**
 * Domain types for the observe → plan → act Tick architecture.
 * Vocabulary follows CONTEXT.md.
 */

export const READY_FOR_AGENT = "ready-for-agent";
export const READY_FOR_HUMAN = "ready-for-human";

/**
 * The label a Claim writes (CONTEXT.md "Claim"): border-collie's own
 * namespace, never applied by a human, so its presence alone is agent-claim
 * evidence independent of assignees.
 */
export const CLAIM_LABEL = "claimed";

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
export type FailureReason =
  | "nonzero-exit"
  | "no-commits"
  | "timeout"
  | "stall"
  | "budget";

export const FAILURE_DESCRIPTIONS: Record<FailureReason, string> = {
  "nonzero-exit": "the Worker process exited non-zero",
  "no-commits": "the Worker exited cleanly but committed nothing",
  timeout: "the Worker hit the wall-clock timeout",
  stall: "the Worker produced no output events for the stall window",
  budget:
    "the Worker hit the turn-cap budget backstop and was halted mid-flight",
};

/**
 * The infrastructure-failure classes (CONTEXT.md "Infrastructure failure"):
 * environment problems that void the Attempt and trip the circuit breaker
 * instead of burning Attempts. `correlated` is the same-way-same-Tick
 * heuristic: several Workers dying identically is an environment problem,
 * not a coincidence of tickets.
 */
export type InfraReason =
  | "usage-limit"
  | "rate-limit"
  | "auth"
  | "network"
  | "correlated";

export const INFRA_DESCRIPTIONS: Record<InfraReason, string> = {
  "usage-limit": "the account usage limit was reached",
  "rate-limit": "the API rate-limited requests",
  auth: "authentication with the API failed",
  network: "the network was unreachable",
  correlated: "several Workers failed the same way within one Tick",
};

/** One finished Attempt, as observed by the Orchestrator. */
export interface WorkerOutcome {
  ticket: number;
  /** Attempt number the dispatch ran as, echoed from the config. */
  attempt: number;
  /** Agent-prefixed branch the Worker committed to; retained after cleanup. */
  branch: string;
  /** Commit the branch was cut from; `base..branch` is the Attempt's work. */
  base: string;
  /** Transcript file path, for post-mortems. */
  transcript: string;
  /** Model the attempt ran on, echoed into the attempt record on failure. */
  model: string;
  exitCode: number | null;
  /** Commits on the branch beyond the base it was cut from. */
  newCommits: number;
  /**
   * Which ticket-failure trigger fired, or undefined when none did (success,
   * or an infrastructure failure): nonzero-exit, no-commits, timeout, stall,
   * budget. Mutually exclusive with `infra`.
   */
  failure: FailureReason | undefined;
  /**
   * The infrastructure class a failed Worker's output evidenced, or
   * undefined. An infra death voids the Attempt instead of burning it
   * (CONTEXT.md "Infrastructure failure").
   */
  infra: InfraReason | undefined;
  /** Attempt spend in USD, from the transcript's result event when one survived. */
  costUsd: number | undefined;
  /** Agentic turns taken, from the transcript's result event when one survived. */
  turns: number | undefined;
  /** Wall-clock duration of the whole session in ms, from the transcript's result event when one survived. */
  durationMs: number | undefined;
  /** How the session's result event says it ended ("success", "error_max_turns", ...), from the transcript's result event when one survived. */
  subtype: string | undefined;
  /**
   * The Attempt spent past the cost cap. An alarm, not a failure: a finished
   * Attempt keeps its work and its PR — the overrun is surfaced so an
   * oversized ticket reaches the operator's eye, not the bin.
   */
  costOverrun: boolean;
  /** The success predicate: no failure trigger fired, ticket or infrastructure. */
  ok: boolean;
}

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
 * A Conflict Worker gave up on a PR and asked for a human: the marker that
 * makes the ask structural, so the next Tick never re-dispatches a second
 * Worker against a conflict a human now owns (the PR-level analogue of
 * Escalation — see CONTEXT.md "Conflict Worker"). One failed Worker per
 * conflict episode; a resolution that lands leaves no marker, so a PR the base
 * later re-conflicts is eligible again.
 *
 * Posted only after a Worker completes and fails — deliberately not before
 * dispatch. A pre-dispatch marker would guarantee at most one Worker even
 * across an Orchestrator crash, but at the cost of silently stranding a PR
 * whose Worker never ran (marker present, no human told, never retried). The
 * post-failure marker instead lets a crash-voided session re-dispatch next
 * Tick — the same stateless re-run recovery the Orchestrator uses everywhere
 * (ADR 0001) — bounded because a session that actually ran and failed always
 * lays the marker down.
 */
export const CONFLICT_UNRESOLVED_MARKER =
  "<!-- border-collie:conflict-unresolved -->";

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
  /**
   * Assignee logins — human claims only, now that an agent Claim writes the
   * claim label instead (CONTEXT.md "Claim"). Any assignee at all makes the
   * ticket non-dispatchable.
   */
  assignees: string[];
  /** Label names. */
  labels: string[];
  /** Count of open blocking issues (GitHub native issue dependencies). */
  openBlockers: number;
  /**
   * Issue numbers of the open blockers, fetched for open blocked tickets so
   * the Stuck report can name exactly what a ticket is stuck on. Empty when
   * unblocked (and for closed tickets, where the list is never read).
   */
  blockedBy: number[];
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
  /**
   * Timestamp (ms) of the ticket's most recent void marker, when it is still
   * the latest border-collie marker on the ticket — an infrastructure
   * failure voided the claim and it has not yet been reclaimed or released.
   * Undefined once superseded by a later claim or release, or when the
   * ticket was never voided. The circuit breaker derives its state from
   * these across in-Scope tickets (CONTEXT.md "Infrastructure failure").
   */
  voidedAtMs: number | undefined;
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

/**
 * Mergeability of an open agent PR against its base, as GitHub computes it.
 * `unknown` is GitHub still working it out (or masked by the draft flag) — the
 * planner leaves such a PR alone and re-reads it next Tick.
 */
export type Mergeability = "mergeable" | "conflicted" | "unknown";

/**
 * CI standing for a PR's head commit, from its check-run rollup. `none` means
 * no checks at all — which the draft→ready gate reads as "no CI configured",
 * so a repo without CI readies a PR immediately (the acceptance criterion).
 */
export type CiState = "none" | "pending" | "passing" | "failing";

/**
 * An open agent PR observed for a ticket, carrying the PR-upkeep signals: a
 * merge into the base leaves clean siblings behind (mechanical update), some
 * conflicted (a one-shot conflict Worker), and a green draft ready to surface
 * to the reviewer. Read repo-wide, not per Scope — every agent PR is
 * border-collie's, and keeping them current is a global concern (same reason
 * the max_open_prs headroom counts them repo-wide).
 */
export interface OpenAgentPr {
  /** PR number, the handle every upkeep write targets. */
  number: number;
  /** Ticket the PR implements, decoded from its agent branch. */
  ticket: number;
  /** Head branch — the agent branch; the conflict Worker checks it out and pushes it back. */
  headRef: string;
  /** GitHub draft flag: a draft is invisible to the reviewer until flipped ready. */
  draft: boolean;
  mergeable: Mergeability;
  /** True when the head is behind its base and a mechanical update would advance it. */
  behind: boolean;
  ci: CiState;
  /**
   * True when a conflict-resolution Worker already asked for human help on
   * this PR (the unresolved marker is present) — vetoes dispatching another.
   */
  conflictWorkerAsked: boolean;
}

/** Everything the planner knows about the world, recomputed each Tick. */
export interface WorldSnapshot {
  tickets: Ticket[];
  /** Open agent PRs (head branch carries the agent prefix), read repo-wide. */
  openAgentPrs: OpenAgentPr[];
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
  /**
   * True while now falls within the operator's configured working hours
   * (CONTEXT.md "Working hours"): claims, spawns, and Conflict Workers are
   * suppressed so the fleet doesn't compete for the quota the operator is
   * using interactively. Closures, releases, Escalations, mechanical
   * rebases, and the draft-to-ready flip still run. Independent of
   * `dispatchPaused` — the circuit breaker's pause means the environment is
   * broken, not that the operator is awake, and either or both may apply.
   * Omitted means outside the window (dispatch flows), including when no
   * window is configured at all.
   */
  withinWorkingHours?: boolean;
}

/**
 * One intended write, produced by the pure plan phase.
 * A discriminated union. `escalate` carries the observed attempt records so
 * the act phase needs no second look at the world. `spawn` carries the
 * attempt number; the caller binds it to a model (the retry ladder). The
 * three PR-upkeep actions carry the PR number plus the ticket (for the
 * human-readable rendering) and, for the conflict Worker, the head branch it
 * works in and pushes back.
 */
export type Action =
  | { type: "claim"; ticket: number }
  | { type: "release"; ticket: number }
  | { type: "spawn"; ticket: number; attempt: number }
  | { type: "escalate"; ticket: number; failures: AttemptFailure[] }
  | { type: "close"; ticket: number; prUrl: string }
  | { type: "update-branch"; pr: number; ticket: number }
  | { type: "conflict-worker"; pr: number; ticket: number; headRef: string }
  | { type: "mark-ready"; pr: number; ticket: number };
