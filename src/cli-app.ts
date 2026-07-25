import {
  buildApplication,
  buildRouteMap,
  run as runStricli,
} from "@stricli/core";
import type { Context } from "./cli-context.js";
import { runCommand } from "./cli-run-command.js";
import { tickCommand } from "./cli-tick-command.js";

const routeMap = buildRouteMap({
  routes: { tick: tickCommand, run: runCommand },
  docs: {
    brief:
      "an orchestration loop that herds a ticket DAG to Done with a fleet of Claude Code agents",
    fullDescription: `Config: border-collie.json at the target repo root,
e.g. {"parent": 1, "max_workers": 3, "max_open_prs": 5, "poll_seconds": 30,
"worker_model": "sonnet", "retry_model": "opus",
"worker_timeout_minutes": 45, "worker_stall_minutes": 10,
"worker_max_turns": 200, "worker_max_cost_usd": 20}`,
  },
});

export const app = buildApplication(routeMap, {
  name: "border-collie",
  scanner: { caseStyle: "allow-kebab-for-camel" },
});

/**
 * stricli reports usage/parsing failures (unknown command, bad flag values)
 * with its own negative internal exit codes; Node truncates a negative
 * `process.exitCode` into the 200s on exit instead of leaving it at the
 * documented 1, so those codes are remapped here. A missing subcommand is
 * also remapped: stricli treats bare invocation as an implicit `--help` and
 * exits 0, but a mistake should read as non-zero even though the same
 * generated usage text is still the right thing to print.
 */
export async function runCli(
  argv: readonly string[],
  context: Context,
): Promise<void> {
  await runStricli(app, argv, context);
  if (argv.length === 0) {
    context.process.exitCode = 1;
  } else if (
    typeof context.process.exitCode === "number" &&
    context.process.exitCode < 0
  ) {
    context.process.exitCode = 1;
  }
}
