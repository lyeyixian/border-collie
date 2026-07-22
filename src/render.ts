import { modelForAttempt, type ResolvedConfig } from "./config.js";
import { dispatchableSet } from "./plan.js";
import {
  READY_FOR_AGENT,
  READY_FOR_HUMAN,
  type Action,
  type Ticket,
  type WorldSnapshot,
} from "./types.js";

/** Render the dispatch plan as human-readable lines. Pure. */
export function renderPlan(
  config: ResolvedConfig,
  world: WorldSnapshot,
  actions: Action[],
  { dryRun }: { dryRun: boolean },
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
  if (dispatchable.length > 0 && world.openAgentPrTickets.length >= maxOpenPrs) {
    lines.push(
      `Dispatch paused: ${world.openAgentPrTickets.length} open agent PRs at max_open_prs (${maxOpenPrs})`,
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
      }
    }
  }

  if (dryRun) lines.push("Dry run: no writes performed.");
  return lines.join("\n");
}

/**
 * Why this open ticket cannot move without a human. Any assignee at a Stuck
 * exit is a human claim: agent claims are either orphans (released before the
 * exit) or backed by a PR (which keeps the run polling).
 */
function stuckReason(ticket: Ticket, inScope: Set<number>): string {
  const reasons: string[] = [];
  if (ticket.assignees.length > 0) {
    reasons.push(`claimed by ${ticket.assignees.join(", ")} — a human claim, hands off`);
  }
  if (ticket.labels.includes(READY_FOR_HUMAN)) {
    reasons.push(`labelled ${READY_FOR_HUMAN}`);
  } else if (!ticket.labels.includes(READY_FOR_AGENT)) {
    reasons.push(`not labelled ${READY_FOR_AGENT}`);
  }
  if (ticket.openBlockers > 0) {
    // Blockers outside Scope are flagged: their tickets get no line of their
    // own in this report. The count is the fallback for an unread list.
    reasons.push(
      ticket.blockedBy.length > 0
        ? `blocked by ${ticket.blockedBy
            .map((n) => (inScope.has(n) ? `#${n}` : `#${n} (outside Scope)`))
            .join(", ")}`
        : `${ticket.openBlockers} open blocker${ticket.openBlockers === 1 ? "" : "s"}`,
    );
  }
  return reasons.join("; ") || "no path forward found";
}

/** Render the Stuck exit report: each remaining open ticket and exactly what it is stuck on. Pure. */
export function renderStuck(world: WorldSnapshot): string {
  const inScope = new Set(world.tickets.map((t) => t.number));
  return [
    "Run Stuck: open tickets remain, but every path forward runs through a human.",
    ...world.tickets.filter((ticket) => ticket.state === "open").map(
      (ticket) => `  #${ticket.number} — ${ticket.title} (${stuckReason(ticket, inScope)})`,
    ),
  ].join("\n");
}

/**
 * Render the Complete exit report: every ticket in Scope, closed. A closed
 * ticket still labelled ready-for-human went through Escalation and was
 * finished by a human — worth naming, as those are the tickets the fleet
 * could not do alone. Pure.
 */
export function renderComplete(tickets: Ticket[]): string {
  const count = `${tickets.length} ticket${tickets.length === 1 ? "" : "s"}`;
  return [
    `Run Complete: every ticket in Scope is closed (${count}).`,
    ...tickets.map((ticket) => {
      const escalated = ticket.labels.includes(READY_FOR_HUMAN)
        ? " (closed by a human after Escalation)"
        : "";
      return `  #${ticket.number} — ${ticket.title}${escalated}`;
    }),
  ].join("\n");
}
