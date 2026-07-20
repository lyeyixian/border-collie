#!/usr/bin/env node
import { parseArgs } from "node:util";
import { act } from "./act.js";
import { ConfigError, loadConfigFile, resolveConfig, type Flags } from "./config.js";
import { plan } from "./plan.js";
import { openPrForOutcome } from "./pr.js";
import { renderPlan } from "./render.js";
import { readScope } from "./tracker.js";
import { dispatchWorker } from "./worker.js";

const USAGE = `Usage: border-collie tick [options]

Runs one Tick against the target repo in the current working directory:
release orphaned agent claims, claim dispatchable tickets (assign + marker
comment), then dispatch one Worker per claim — an isolated worktree on an
agent branch, running headless claude against exactly that ticket — and
report each Worker's outcome. A successful Worker's branch is pushed and
opened as a draft PR that closes its ticket on merge, its body taken from
the Worker's final message (mechanical fallback: ticket + commit subjects).

Every way a Worker can die is noticed — non-zero exit, no commits, wall-clock
timeout, stall — and released with a forensic attempt record. A once-failed
ticket is retried fresh on the stronger retry model; a twice-failed ticket is
Escalated to ready-for-human with the evidence.

Options:
  --dry-run            print the dispatch plan without writing anything
  --parent <n>         scope: sub-issues of parent issue #n (overrides config file)
  --all                scope: every agent-ready issue in the repo (explicit opt-in)
  --max-workers <n>    cap on planned claims (default 3, overrides config file)
  --model <name>       model Workers run on (default sonnet, overrides config file)
  --retry-model <name> model second attempts run on (default opus, overrides config file)
  -h, --help           show this help

Config: border-collie.json at the target repo root,
e.g. {"parent": 1, "max_workers": 3, "worker_model": "sonnet",
"retry_model": "opus", "worker_timeout_minutes": 45, "worker_stall_minutes": 10}`;

function parseIntFlag(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) {
    throw new ConfigError(`${name} must be an integer, got "${value}"`);
  }
  return Number(value);
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      "dry-run": { type: "boolean", default: false },
      parent: { type: "string" },
      all: { type: "boolean", default: false },
      "max-workers": { type: "string" },
      model: { type: "string" },
      "retry-model": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  if (positionals.length !== 1 || positionals[0] !== "tick") {
    console.error(USAGE);
    return 1;
  }
  const flags: Flags = {};
  const parent = parseIntFlag(values.parent, "--parent");
  if (parent !== undefined) flags.parent = parent;
  const maxWorkers = parseIntFlag(values["max-workers"], "--max-workers");
  if (maxWorkers !== undefined) flags.maxWorkers = maxWorkers;
  if (values.all) flags.all = true;
  if (values.model !== undefined) flags.model = values.model;
  if (values["retry-model"] !== undefined) flags.retryModel = values["retry-model"];

  const config = resolveConfig(loadConfigFile(process.cwd()), flags);

  const dryRun = values["dry-run"];
  const world = await readScope(config.scope);
  const actions = plan(world, { maxWorkers: config.maxWorkers });
  console.log(renderPlan(config, world, actions, { dryRun }));
  if (!dryRun) {
    const titles = new Map(world.tickets.map((t) => [t.number, t.title]));
    await act(
      actions,
      (ticket, attempt) =>
        dispatchWorker(ticket, {
          model: attempt >= 2 ? config.retryModel : config.model,
          timeoutMs: config.timeoutMinutes * 60_000,
          stallMs: config.stallMinutes * 60_000,
        }),
      (outcome) => openPrForOutcome(outcome, titles.get(outcome.ticket) ?? `Ticket #${outcome.ticket}`),
    );
  }
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof ConfigError ? error.message : error);
    process.exitCode = 1;
  },
);
