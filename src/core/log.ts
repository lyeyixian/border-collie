import type { CompleteReport, PlanReport, StuckReport } from "./render.js";
import type { FailureReason, InfraReason, WorkerOutcome } from "./types.js";

/**
 * Level answers "does a human need to do something?", not "did something
 * fail?" — a Ticket failure that will be retried is `info`, not a warning
 * that reads as an alarm. Only these four are used; the console sink's
 * additional levels above and below are deliberately left unused.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

interface LogEventBase {
  level: LogLevel;
  /** Human sentence composed at the call site, where the domain meaning lives. */
  msg: string;
}

/**
 * One line the Orchestrator narrates, travelling through the single logging
 * function injected into the run loop and the act phase's effects executor.
 * The kind plus its per-kind fields exist so a sink can render or query the
 * event structurally. The console sink (wired in the composition root) reads
 * `level` and `msg` for narration; for the three report kinds it instead
 * renders `report` as the familiar unadorned block, dispatching on `kind`.
 * Worker-lifecycle kinds (`spawn` through `attempt-released`, and the
 * `conflict-*` kinds) omit the ticket/attempt/pr they'd otherwise repeat on
 * every call — a dispatched Worker's sub-logger binds those once; see
 * {@link Log.child}.
 */
export type LogEvent = LogEventBase &
  (
    | { kind: "claim"; ticket: number }
    | { kind: "release"; ticket: number }
    | { kind: "escalate"; ticket: number }
    | { kind: "close"; ticket: number; prUrl: string }
    | { kind: "update-branch"; pr: number }
    | { kind: "mark-ready"; pr: number }
    | { kind: "conflict-dispatch"; ticket: number }
    | { kind: "spawn" }
    | { kind: "worker-outcome"; outcome: WorkerOutcome }
    | { kind: "pr-opened"; prUrl: string }
    | { kind: "pr-open-failed" }
    | { kind: "cost-overrun"; costUsd: number }
    | { kind: "attempt-voided"; reason: InfraReason }
    | { kind: "attempt-released"; reason: FailureReason }
    | { kind: "conflict-outcome"; resolved: boolean }
    | { kind: "conflict-pushed" }
    | { kind: "conflict-unresolved" }
    | { kind: "breaker-closed" }
    | { kind: "breaker-still-open"; trips: number; nextProbeMs: number }
    | { kind: "breaker-open"; infraFailures: number; nextProbeMs: number }
    | { kind: "next-tick"; pollSeconds: number }
    | { kind: "plan-report"; report: PlanReport }
    | { kind: "stuck-report"; report: StuckReport }
    | { kind: "complete-report"; report: CompleteReport }
  );

/** Fields a Worker's (or Conflict Worker's) sub-logger binds onto every event it emits. */
export interface LogBindings {
  ticket?: number;
  attempt?: number;
  pr?: number;
}

/**
 * The single logging seam injected into the run loop and the act phase's
 * effects executor — a function type per ADR 0005, not a named interface,
 * with `child` attached for deriving a sub-logger scoped to one dispatched
 * Worker (bound by ticket and attempt) or Conflict Worker (bound by PR):
 * every event it emits carries those bindings, tagged in the console and
 * carried as structured fields, without the call site repeating them.
 * Bindings are inherited by further children.
 */
export type Log = ((event: LogEvent) => void) & {
  child(bindings: LogBindings): Log;
};
