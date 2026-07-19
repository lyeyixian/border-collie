#!/usr/bin/env node
import { parseArgs } from "node:util";
import { ConfigError, loadConfigFile, resolveConfig, type Flags } from "./config.js";
import { plan } from "./plan.js";
import { renderPlan } from "./render.js";
import { readScope } from "./tracker.js";

const USAGE = `Usage: border-collie tick --dry-run [options]

Runs one Tick against the target repo in the current working directory.

Options:
  --dry-run            print the dispatch plan without writing anything (required for now)
  --parent <n>         scope: sub-issues of parent issue #n (overrides config file)
  --all                scope: every agent-ready issue in the repo (explicit opt-in)
  --max-workers <n>    cap on planned claims (default 3, overrides config file)
  -h, --help           show this help

Config: border-collie.json at the target repo root, e.g. {"parent": 1, "max_workers": 3}`;

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
  if (!values["dry-run"]) {
    console.error(
      "tick without --dry-run is not implemented yet (claiming lands with issue #3). Re-run with --dry-run.",
    );
    return 1;
  }

  const flags: Flags = {};
  const parent = parseIntFlag(values.parent, "--parent");
  if (parent !== undefined) flags.parent = parent;
  const maxWorkers = parseIntFlag(values["max-workers"], "--max-workers");
  if (maxWorkers !== undefined) flags.maxWorkers = maxWorkers;
  if (values.all) flags.all = true;

  const config = resolveConfig(loadConfigFile(process.cwd()), flags);

  const world = await readScope(config.scope);
  const actions = plan(world, { maxWorkers: config.maxWorkers });
  console.log(renderPlan(config, world, actions));
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
