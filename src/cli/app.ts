import {
  buildApplication,
  buildRouteMap,
  type PartialApplicationConfiguration,
  run as runStricli,
  version,
} from "@stricli/core";
import type { Context } from "./context.js";
import { initCommand } from "./init-command.js";
import { runCommand } from "./run-command.js";
import { tickCommand } from "./tick-command.js";
import { VERSION } from "./version.js";
import { workerCommand } from "./worker-command.js";

const routeMap = buildRouteMap({
  routes: {
    tick: tickCommand,
    run: runCommand,
    worker: workerCommand,
    init: initCommand,
  },
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

const appConfig: PartialApplicationConfiguration = {
  name: "border-collie",
  scanner: { caseStyle: "allow-kebab-for-camel" },
};

/**
 * stricli wires its default --help/--help-all integrations only when the
 * integrations argument is omitted, and --version has to be passed through
 * that same argument. So build once to let stricli resolve its own defaults
 * (integrations and the localized flag briefs), then rebuild with --version
 * added to them rather than hand-copying stricli's internal defaults here.
 */
const withDefaultIntegrations = buildApplication(routeMap, appConfig);

export const app = buildApplication(routeMap, appConfig, {
  ...withDefaultIntegrations.integrations,
  version: version({
    brief: withDefaultIntegrations.defaultText.briefs.version,
    info: { currentVersion: VERSION },
  }),
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
