/**
 * Domain types for the observe → plan → act Tick architecture.
 * Vocabulary follows CONTEXT.md.
 */

export const READY_FOR_AGENT = "ready-for-agent";

/**
 * Hidden HTML markers that make a claim structurally border-collie's
 * (CONTEXT.md "Claim"): the latest marker comment on a ticket decides.
 * Claims and releases are append-only — no comment is ever deleted.
 */
export const CLAIM_MARKER = "<!-- border-collie:claim -->";
export const RELEASE_MARKER = "<!-- border-collie:release -->";

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
}

/** Everything the planner knows about the world, recomputed each Tick. */
export interface WorldSnapshot {
  tickets: Ticket[];
  /** Ticket numbers with an open agent PR (head branch carries the agent prefix). */
  openAgentPrTickets: number[];
}

export interface PlanConfig {
  maxWorkers: number;
}

/**
 * One intended write, produced by the pure plan phase.
 * A discriminated union that later tickets extend (spawn worker, open PR,
 * escalate, ...). `release` carries the observed assignee logins so the act
 * phase needs no second look at the world.
 */
export type Action =
  | { type: "claim"; ticket: number }
  | { type: "release"; ticket: number; assignees: string[] };
