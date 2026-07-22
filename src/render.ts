import { modelForAttempt, type ResolvedConfig } from "./config.js";
import { dispatchableSet } from "./plan.js";
import { READY_FOR_AGENT, type Action, type Ticket, type WorldSnapshot } from "./types.js";

/** Render the dispatch plan as human-readable lines. Pure. */
export function renderPlan(
  config: ResolvedConfig,
  world: WorldSnapshot,
  actions: Action[],
  { dryRun, dispatchPaused = false }: { dryRun: boolean; dispatchPaused?: boolean },
): string {
  const { scope, maxWorkers, maxOpenPrs } = config;
  const lines: string[] = [];
  const open = world.tickets.filter((t) => t.state === "open").length;
  const scopeLabel =
    scope.kind === "parent"
      ? `sub-issues of #${scope.parent}`
      : "repo-wide (--all)";
  lines.push(`Scope: ${scopeLabel} — ${world.tickets.length} tickets (${open} open)`);

  const dispatchable = dispatchableSet(world);
  if (dispatchable.length === 0) {
    lines.push("Dispatchable: none");
  } else {
    lines.push(`Dispatchable: ${dispatchable.map((t) => `#${t.number}`).join(", ")}`);
  }
  if (dispatchPaused) {
    lines.push("Dispatch paused: circuit breaker open (infrastructure failure), claims held");
  } else if (dispatchable.length > 0 && world.openAgentPrs.length >= maxOpenPrs) {
    lines.push(
      `Dispatch paused: ${world.openAgentPrs.length} open agent PRs at max_open_prs (${maxOpenPrs})`,
    );
  }

  const titles = new Map(world.tickets.map((t) => [t.number, t.title]));
  if (actions.length === 0) {
    lines.push(`Plan (max_workers=${maxWorkers}, max_open_prs=${maxOpenPrs}): nothing to do`);
  } else {
    lines.push(`Plan (max_workers=${maxWorkers}, max_open_prs=${maxOpenPrs}):`);
    for (const action of actions) {
      const title = titles.get(action.ticket) ?? "";
      switch (action.type) {
        case "claim":
          lines.push(`  claim #${action.ticket} — ${title}`);
          break;
        case "release":
          lines.push(`  release #${action.ticket} — ${title} (orphaned agent claim)`);
          break;
        case "spawn":
          lines.push(
            `  spawn Worker for #${action.ticket} — ${title} (model ${modelForAttempt(
              config,
              action.attempt,
            )}, attempt ${action.attempt})`,
          );
          break;
        case "escalate":
          lines.push(
            `  escalate #${action.ticket} — ${title} (attempts exhausted → ready-for-human)`,
          );
          break;
        case "close":
          lines.push(`  close #${action.ticket} — ${title} (merged: ${action.prUrl})`);
          break;
        case "update-branch":
          lines.push(`  update PR #${action.pr} — ${title} (behind base, mechanical merge)`);
          break;
        case "conflict-worker":
          lines.push(`  conflict Worker for PR #${action.pr} — ${title} (resolve merge conflicts)`);
          break;
        case "mark-ready":
          lines.push(`  mark PR #${action.pr} ready — ${title} (CI green)`);
          break;
      }
    }
  }

  if (dryRun) lines.push("Dry run: no writes performed.");
  return lines.join("\n");
}

/** Why this open ticket cannot move without a human, best effort. */
function stuckReason(ticket: Ticket): string {
  const reasons: string[] = [];
  if (ticket.assignees.length > 0) reasons.push(`claimed by ${ticket.assignees.join(", ")}`);
  if (!ticket.labels.includes(READY_FOR_AGENT)) reasons.push(`not labelled ${READY_FOR_AGENT}`);
  if (ticket.openBlockers > 0) {
    reasons.push(`${ticket.openBlockers} open blocker${ticket.openBlockers === 1 ? "" : "s"}`);
  }
  return reasons.join("; ") || "no path forward found";
}

/** Render the Stuck exit report: each remaining open ticket and why. Pure. */
export function renderStuck(open: Ticket[]): string {
  return [
    "Run Stuck: open tickets remain, but every path forward runs through a human.",
    ...open.map((ticket) => `  #${ticket.number} — ${ticket.title} (${stuckReason(ticket)})`),
  ].join("\n");
}
