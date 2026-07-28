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
 */
export type LogEvent = LogEventBase &
  (
    | { kind: "claim"; ticket: number }
    | { kind: "release"; ticket: number }
    | { kind: "escalate"; ticket: number }
    | { kind: "close"; ticket: number; prUrl: string }
    | { kind: "update-branch"; pr: number }
    | { kind: "mark-ready"; pr: number }
    | { kind: "conflict-dispatch"; pr: number; ticket: number }
    | { kind: "spawn"; ticket: number; attempt: number }
    | { kind: "worker-outcome"; outcome: WorkerOutcome }
    | { kind: "pr-opened"; ticket: number; prUrl: string }
    | { kind: "pr-open-failed"; ticket: number }
    | { kind: "cost-overrun"; ticket: number; attempt: number; costUsd: number }
    | {
        kind: "attempt-voided";
        ticket: number;
        attempt: number;
        reason: InfraReason;
      }
    | {
        kind: "attempt-released";
        ticket: number;
        attempt: number;
        reason: FailureReason;
      }
    | { kind: "conflict-outcome"; pr: number; resolved: boolean }
    | { kind: "conflict-pushed"; pr: number }
    | { kind: "conflict-unresolved"; pr: number }
    | { kind: "breaker-closed" }
    | { kind: "breaker-still-open"; trips: number; nextProbeMs: number }
    | { kind: "breaker-open"; infraFailures: number; nextProbeMs: number }
    | { kind: "next-tick"; pollSeconds: number }
    | { kind: "plan-report"; report: PlanReport }
    | { kind: "stuck-report"; report: StuckReport }
    | { kind: "complete-report"; report: CompleteReport }
  );

/** The single logging seam injected into the run loop and the act phase's effects executor. */
export type Log = (event: LogEvent) => void;
