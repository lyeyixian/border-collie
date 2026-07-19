/**
 * Domain types for the observe → plan → act Tick architecture.
 * Vocabulary follows CONTEXT.md.
 */

export const READY_FOR_AGENT = "ready-for-agent";

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
}

/** Everything the planner knows about the world, recomputed each Tick. */
export interface WorldSnapshot {
  tickets: Ticket[];
}

export interface PlanConfig {
  maxWorkers: number;
}

/**
 * One intended write, produced by the pure plan phase.
 * A discriminated union that later tickets extend (spawn worker, open PR,
 * escalate, ...); the walking skeleton only plans Claims.
 */
export type Action = { type: "claim"; ticket: number };
