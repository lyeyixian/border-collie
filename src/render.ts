import type { ResolvedConfig } from "./config.js";
import { dispatchableSet } from "./plan.js";
import type { Action, WorldSnapshot } from "./types.js";

/** Render the dispatch plan as human-readable lines. Pure. */
export function renderPlan(
  { scope, maxWorkers }: ResolvedConfig,
  world: WorldSnapshot,
  actions: Action[],
  { dryRun }: { dryRun: boolean },
): string {
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

  const titles = new Map(world.tickets.map((t) => [t.number, t.title]));
  if (actions.length === 0) {
    lines.push(`Plan (max_workers=${maxWorkers}): nothing to do`);
  } else {
    lines.push(`Plan (max_workers=${maxWorkers}):`);
    for (const action of actions) {
      const title = titles.get(action.ticket) ?? "";
      switch (action.type) {
        case "claim":
          lines.push(`  claim #${action.ticket} — ${title}`);
          break;
        case "release":
          lines.push(`  release #${action.ticket} — ${title} (orphaned agent claim)`);
          break;
      }
    }
  }

  if (dryRun) lines.push("Dry run: no writes performed.");
  return lines.join("\n");
}
