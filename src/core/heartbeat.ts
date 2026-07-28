/**
 * The fleet heartbeat's pure arithmetic: how long a Worker has run, and how
 * long since it last produced output — the two signals that distinguish
 * slow from stuck (elapsed alone cannot).
 */

/** One in-flight Worker's activity clock, tracked by the act phase. */
export interface WorkerActivity {
  ticket: number;
  attempt: number;
  startedAtMs: number;
  /** Updated on every stdout chunk the Worker process emits. */
  lastActivityAtMs: number;
}

/** One Worker's heartbeat reading at a point in time. */
export interface WorkerHeartbeat {
  ticket: number;
  attempt: number;
  elapsedMs: number;
  sinceOutputMs: number;
}

/** Snapshot every in-flight Worker's heartbeat reading at `nowMs`. Pure. */
export function heartbeatSnapshot(
  workers: WorkerActivity[],
  nowMs: number,
): WorkerHeartbeat[] {
  return workers.map((worker) => ({
    ticket: worker.ticket,
    attempt: worker.attempt,
    elapsedMs: nowMs - worker.startedAtMs,
    sinceOutputMs: nowMs - worker.lastActivityAtMs,
  }));
}
