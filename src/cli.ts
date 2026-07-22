#!/usr/bin/env node
import { parseArgs } from "node:util";
import { act } from "./act.js";
import {
  ConfigError,
  loadConfigFile,
  modelForAttempt,
  resolveConfig,
  type Flags,
  type ResolvedConfig,
} from "./config.js";
import { plan } from "./plan.js";
import { openPrForOutcome } from "./pr.js";
import { renderPlan } from "./render.js";
import { run } from "./run.js";
import { readScope } from "./tracker.js";
import { dispatchWorker, probeEnvironment } from "./worker.js";
import type { Action, WorldSnapshot } from "./types.js";

const USAGE = `Usage: border-collie <tick|run> [options]

tick runs one idempotent pass against the target repo in the current working
directory: close tickets whose agent PR merged without closing them, release
orphaned agent claims, claim dispatchable tickets (assign + marker comment),
then dispatch one Worker per claim — an isolated worktree on an agent branch,
running headless claude against exactly that ticket — and report each
Worker's outcome. A successful Worker's branch is pushed and opened as a
draft PR that closes its ticket on merge, its body taken from the Worker's
final message (mechanical fallback: ticket + commit subjects). Dispatch
pauses while open agent PRs sit at max_open_prs and resumes as merges land.

run repeats ticks at the poll interval until a terminal state: Complete
(every ticket in Scope closed, exit 0) or Stuck (open tickets remain but
every path forward runs through a human, exit 1). It keeps polling while
agent PRs await human merge.

Every way a Worker can die is noticed — non-zero exit, no commits, wall-clock
timeout, stall, turn-cap breach — and released with a forensic attempt
record. A finished Worker that spent past the cost cap keeps its work and
its PR; the overrun is flagged so oversized tickets surface. A once-failed ticket is retried fresh on the
stronger retry model; a twice-failed ticket is Escalated to ready-for-human
with the evidence. Environment deaths (usage limit, rate limit, auth,
network — or several Workers dying the same way in one tick) are
infrastructure failures instead: the attempt is voided, burning nothing, and
run's circuit breaker pauses dispatch with claims held, probing the
environment on a backoff until it recovers.

Options:
  --dry-run            print the dispatch plan without writing anything (tick only)
  --parent <n>         scope: sub-issues of parent issue #n (overrides config file)
  --all                scope: every agent-ready issue in the repo (explicit opt-in)
  --max-workers <n>    cap on planned claims (default 3, overrides config file)
  --max-open-prs <n>   open agent PRs that pause dispatch (default 5, overrides config file)
  --poll-seconds <n>   seconds between run's ticks (default 30, overrides config file)
  --model <name>       model Workers run on (default sonnet, overrides config file)
  --retry-model <name> model second attempts run on (default opus, overrides config file)
  -h, --help           show this help

Config: border-collie.json at the target repo root,
e.g. {"parent": 1, "max_workers": 3, "max_open_prs": 5, "poll_seconds": 30,
"worker_model": "sonnet", "retry_model": "opus",
"worker_timeout_minutes": 45, "worker_stall_minutes": 10,
"worker_max_turns": 200, "worker_max_cost_usd": 20}`;

function parseIntFlag(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) {
    throw new ConfigError(`${name} must be an integer, got "${value}"`);
  }
  return Number(value);
}

/** One full observe → plan → act pass — the single Tick both commands share. */
async function tickOnce(
  config: ResolvedConfig,
  dryRun: boolean,
  dispatchPaused = false,
): Promise<{ world: WorldSnapshot; actions: Action[]; infraFailures: number }> {
  const world = await readScope(config.scope);
  const actions = plan(world, {
    maxWorkers: config.maxWorkers,
    maxOpenPrs: config.maxOpenPrs,
    dispatchPaused,
  });
  console.log(renderPlan(config, world, actions, { dryRun, dispatchPaused }));
  let infraFailures = 0;
  if (!dryRun) {
    const titles = new Map(world.tickets.map((t) => [t.number, t.title]));
    const report = await act(
      actions,
      (ticket, attempt) =>
        dispatchWorker(ticket, {
          model: modelForAttempt(config, attempt),
          attempt,
          timeoutMs: config.timeoutMinutes * 60_000,
          stallMs: config.stallMinutes * 60_000,
          maxTurns: config.maxTurns,
          maxCostUsd: config.maxCostUsd,
        }),
      (outcome) => openPrForOutcome(outcome, titles.get(outcome.ticket) ?? `Ticket #${outcome.ticket}`),
    );
    infraFailures = report.infraFailures;
  }
  return { world, actions, infraFailures };
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
      "max-open-prs": { type: "string" },
      "poll-seconds": { type: "string" },
      model: { type: "string" },
      "retry-model": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  const command = positionals[0];
  if (positionals.length !== 1 || (command !== "tick" && command !== "run")) {
    console.error(USAGE);
    return 1;
  }
  const flags: Flags = {};
  const parent = parseIntFlag(values.parent, "--parent");
  if (parent !== undefined) flags.parent = parent;
  const maxWorkers = parseIntFlag(values["max-workers"], "--max-workers");
  if (maxWorkers !== undefined) flags.maxWorkers = maxWorkers;
  const maxOpenPrs = parseIntFlag(values["max-open-prs"], "--max-open-prs");
  if (maxOpenPrs !== undefined) flags.maxOpenPrs = maxOpenPrs;
  const pollSeconds = parseIntFlag(values["poll-seconds"], "--poll-seconds");
  if (pollSeconds !== undefined) flags.pollSeconds = pollSeconds;
  if (values.all) flags.all = true;
  if (values.model !== undefined) flags.model = values.model;
  if (values["retry-model"] !== undefined) flags.retryModel = values["retry-model"];

  const config = resolveConfig(loadConfigFile(process.cwd()), flags);

  const dryRun = values["dry-run"];
  if (command === "tick") {
    const { infraFailures } = await tickOnce(config, dryRun);
    if (infraFailures > 0) {
      // A standalone tick has no resident breaker to hold open; the voided
      // claims stay held on the tracker, so the operator just re-ticks later.
      console.log(
        "Infrastructure failure detected: attempts voided, claims held. Re-run tick when the environment recovers.",
      );
    }
    return 0;
  }

  if (dryRun) {
    throw new ConfigError("--dry-run only applies to tick: a dry run never progresses the loop");
  }
  const outcome = await run(config.pollSeconds, {
    tick: (dispatchPaused) => tickOnce(config, false, dispatchPaused),
    probe: () => probeEnvironment(config.model),
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log: console.log,
  });
  return outcome === "complete" ? 0 : 1;
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
