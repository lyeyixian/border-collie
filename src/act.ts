import { claimTicket, realExec, releaseTicket, type Exec } from "./tracker.js";
import type { Action } from "./types.js";
import type { WorkerOutcome } from "./worker.js";

/** Dispatch one Worker against one claimed ticket; the model is bound by the caller. */
export type DispatchWorker = (ticket: number) => Promise<WorkerOutcome>;

function describeOutcome(outcome: WorkerOutcome): string {
  const commits = `${outcome.newCommits} new commit${outcome.newCommits === 1 ? "" : "s"}`;
  const where = `on ${outcome.branch} (transcript: ${outcome.transcript})`;
  return outcome.ok
    ? `Worker for #${outcome.ticket} succeeded: ${commits} ${where}`
    : `Worker for #${outcome.ticket} failed attempt: exit ${outcome.exitCode}, ${commits} ${where}`;
}

/**
 * Act phase: perform the planned writes in plan order (releases first), one
 * at a time, narrating each as it lands. Spawns are the exception: each
 * Worker starts as its action is reached but runs concurrently, and the Tick
 * waits for all of them before reporting outcomes. A tracker failure mid-way
 * throws — the stateless recovery story is re-running the Tick, which
 * recomputes the world and re-plans whatever is still due. An infrastructure
 * failure on the Worker side likewise throws (classification and the circuit
 * breaker land with later tickets), but only after every finished Worker's
 * outcome is reported.
 */
export async function act(
  actions: Action[],
  dispatch: DispatchWorker,
  exec: Exec = realExec,
  log: (line: string) => void = console.log,
): Promise<void> {
  const workers: Promise<WorkerOutcome>[] = [];
  for (const action of actions) {
    switch (action.type) {
      case "claim":
        await claimTicket(action.ticket, exec);
        log(`claimed #${action.ticket}`);
        break;
      case "release":
        await releaseTicket(action.ticket, action.assignees, exec);
        log(`released #${action.ticket} (orphaned claim)`);
        break;
      case "spawn":
        workers.push(dispatch(action.ticket));
        log(`spawned Worker for #${action.ticket}`);
        break;
    }
  }

  const settled = await Promise.allSettled(workers);
  for (const result of settled) {
    if (result.status === "fulfilled") log(describeOutcome(result.value));
  }
  const failure = settled.find((result) => result.status === "rejected");
  if (failure) throw failure.reason;
}
