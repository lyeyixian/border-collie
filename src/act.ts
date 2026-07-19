import { claimTicket, realExec, releaseTicket, type Exec } from "./tracker.js";
import type { Action } from "./types.js";

/**
 * Act phase: perform the planned writes in plan order (releases first), one
 * at a time, narrating each as it lands. A failure mid-way throws — the
 * stateless recovery story is re-running the Tick, which recomputes the
 * world and re-plans whatever is still due.
 */
export async function act(
  actions: Action[],
  exec: Exec = realExec,
  log: (line: string) => void = console.log,
): Promise<void> {
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
    }
  }
}
