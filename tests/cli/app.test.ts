import { describe, expect, it } from "vitest";
import { runCli } from "../../src/cli/app.js";
import type { Context } from "../../src/cli/context.js";
import { VERSION } from "../../src/cli/version.js";
import {
  ConfigError,
  type Flags,
  type ResolvedConfig,
} from "../../src/core/config.js";
import type { LogEvent } from "../../src/core/log.js";
import type { Ticket, WorldSnapshot } from "../../src/core/types.js";

function ticket(overrides: Partial<Ticket> & { number: number }): Ticket {
  return {
    title: `Ticket #${overrides.number}`,
    state: "open",
    assignees: [],
    labels: ["ready-for-agent"],
    openBlockers: 0,
    blockedBy: [],
    hasAgentClaim: false,
    agentClaimCount: 0,
    attemptFailures: [],
    ...overrides,
  };
}

function world(tickets: Ticket[]): WorldSnapshot {
  return { tickets, openAgentPrs: [], mergedAgentPrs: [] };
}

const CLOSED_WORLD = world([ticket({ number: 1, state: "closed" })]);
const STUCK_WORLD = world([ticket({ number: 1, labels: ["ready-for-human"] })]);

const FAKE_RESOLVED_CONFIG: ResolvedConfig = {
  scope: { kind: "parent", parent: 1 },
  maxWorkers: 3,
  maxOpenPrs: 5,
  pollSeconds: 30,
  model: "sonnet",
  retryModel: "opus",
  timeoutMinutes: 45,
  stallMinutes: 10,
  maxTurns: 200,
  maxCostUsd: 20,
};

interface FakeContext {
  context: Context;
  stdout: () => string;
  stderr: () => string;
  loadConfigCalls: Flags[];
  tickCalls: {
    config: ResolvedConfig;
    dryRun: boolean;
    dispatchPaused: boolean | undefined;
  }[];
  probeCalls: string[];
  events: LogEvent[];
}

function fakeContext(
  overrides: {
    loadConfig?: (flags: Flags) => ResolvedConfig;
    tickResults?: { world: WorldSnapshot; infraFailures?: number }[];
  } = {},
): FakeContext {
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const loadConfigCalls: Flags[] = [];
  const tickCalls: {
    config: ResolvedConfig;
    dryRun: boolean;
    dispatchPaused: boolean | undefined;
  }[] = [];
  const probeCalls: string[] = [];
  const events: LogEvent[] = [];
  const tickResults = overrides.tickResults ?? [{ world: CLOSED_WORLD }];

  const context: Context = {
    process: {
      stdout: { write: (str: string) => stdoutLines.push(str) },
      stderr: { write: (str: string) => stderrLines.push(str) },
      exitCode: null,
    },
    loadConfig: (flags) => {
      loadConfigCalls.push(flags);
      return overrides.loadConfig
        ? overrides.loadConfig(flags)
        : FAKE_RESOLVED_CONFIG;
    },
    tick: async (config, dryRun, dispatchPaused) => {
      tickCalls.push({ config, dryRun, dispatchPaused });
      const next = tickResults.shift();
      if (next === undefined)
        throw new Error("tick called past scripted results");
      return {
        world: next.world,
        actions: [],
        infraFailures: next.infraFailures ?? 0,
      };
    },
    probe: async (model) => {
      probeCalls.push(model);
      return true;
    },
    now: () => 0,
    sleep: async () => {},
    log: (event) => {
      events.push(event);
    },
  };

  return {
    context,
    stdout: () => stdoutLines.join(""),
    stderr: () => stderrLines.join(""),
    loadConfigCalls,
    tickCalls,
    probeCalls,
    events,
  };
}

describe("argv → flags mapping", () => {
  it.each([
    [["--parent", "5"], { parent: 5 }],
    [["--all"], { all: true }],
    [["--max-workers", "7"], { maxWorkers: 7 }],
    [["--max-open-prs", "9"], { maxOpenPrs: 9 }],
    [["--poll-seconds", "15"], { pollSeconds: 15 }],
    [["--model", "haiku"], { model: "haiku" }],
    [["--retry-model", "opus4"], { retryModel: "opus4" }],
  ] as const)("maps %s to config flags %o", async (flagArgs, expected) => {
    const fake = fakeContext();

    await runCli(["tick", ...flagArgs], fake.context);

    expect(fake.loadConfigCalls).toEqual([expected]);
  });

  it("drops --dry-run from the flags object handed to config resolution", async () => {
    const fake = fakeContext();

    await runCli(["tick", "--dry-run", "--parent", "1"], fake.context);

    expect(fake.loadConfigCalls[0]).not.toHaveProperty("dryRun");
  });

  it("omits unset flags entirely rather than passing them as undefined", async () => {
    const fake = fakeContext();

    await runCli(["tick"], fake.context);

    expect(fake.loadConfigCalls).toEqual([{}]);
  });
});

describe("integer flag rejection", () => {
  it.each([
    ["--max-workers", "abc"],
    ["--max-open-prs", "abc"],
    ["--poll-seconds", "abc"],
    ["--parent", "abc"],
  ])("rejects garbage for %s", async (flag, value) => {
    const fake = fakeContext();

    await runCli(["tick", flag, value], fake.context);

    expect(fake.context.process.exitCode).toBe(1);
    expect(fake.stderr()).toContain(flag.replace(/^--/, ""));
    expect(fake.stderr()).toContain(value);
    expect(fake.tickCalls).toHaveLength(0);
  });

  it("rejects a float", async () => {
    const fake = fakeContext();

    await runCli(["tick", "--max-workers", "1.5"], fake.context);

    expect(fake.context.process.exitCode).toBe(1);
    expect(fake.stderr()).toContain("1.5");
  });

  it("rejects a negative integer", async () => {
    const fake = fakeContext();

    await runCli(["tick", "--max-workers", "-1"], fake.context);

    expect(fake.context.process.exitCode).toBe(1);
    expect(fake.stderr()).toContain("-1");
  });
});

describe("command routing", () => {
  it("routes `tick` to a single tick pass", async () => {
    const fake = fakeContext();

    await runCli(["tick", "--parent", "1"], fake.context);

    expect(fake.tickCalls).toHaveLength(1);
    expect(fake.tickCalls[0]?.dryRun).toBe(false);
    expect(fake.context.process.exitCode).toBeFalsy();
  });

  it("routes `run` through the run loop, ticking until a terminal state", async () => {
    const fake = fakeContext({ tickResults: [{ world: CLOSED_WORLD }] });

    await runCli(["run", "--parent", "1"], fake.context);

    expect(fake.tickCalls).toHaveLength(1);
    expect(fake.context.process.exitCode).toBeFalsy();
  });

  it("accepts --dry-run on tick and forwards it to the tick pass", async () => {
    const fake = fakeContext();

    await runCli(["tick", "--dry-run", "--parent", "1"], fake.context);

    expect(fake.tickCalls[0]?.dryRun).toBe(true);
  });

  it("rejects --dry-run on run with a one-line error, exit 1, without ticking", async () => {
    const fake = fakeContext();

    await runCli(["run", "--dry-run", "--parent", "1"], fake.context);

    expect(fake.context.process.exitCode).toBe(1);
    expect(fake.stderr().trim().split("\n")).toHaveLength(1);
    expect(fake.stderr()).toContain("--dry-run only applies to tick");
    expect(fake.tickCalls).toHaveLength(0);
  });
});

describe("exit-code contract", () => {
  it("tick exits 0", async () => {
    const fake = fakeContext();

    await runCli(["tick", "--parent", "1"], fake.context);

    expect(fake.context.process.exitCode).toBeFalsy();
  });

  it("tick exits 0 even when an infra failure is reported, with a one-line notice", async () => {
    const fake = fakeContext({
      tickResults: [{ world: CLOSED_WORLD, infraFailures: 2 }],
    });

    await runCli(["tick", "--parent", "1"], fake.context);

    expect(fake.context.process.exitCode).toBeFalsy();
    expect(fake.stdout()).toContain("Infrastructure failure detected");
  });

  it("run exits 0 on Complete", async () => {
    const fake = fakeContext({ tickResults: [{ world: CLOSED_WORLD }] });

    await runCli(["run", "--parent", "1"], fake.context);

    expect(fake.context.process.exitCode).toBeFalsy();
  });

  it("run exits 1 on Stuck", async () => {
    const fake = fakeContext({ tickResults: [{ world: STUCK_WORLD }] });

    await runCli(["run", "--parent", "1"], fake.context);

    expect(fake.context.process.exitCode).toBe(1);
  });

  it("a config error prints a one-line message and exits 1", async () => {
    const fake = fakeContext({
      loadConfig: () => {
        throw new ConfigError("no scope: set parent or pass --all");
      },
    });

    await runCli(["tick"], fake.context);

    expect(fake.context.process.exitCode).toBe(1);
    expect(fake.stderr().trim()).toBe("no scope: set parent or pass --all");
    expect(fake.tickCalls).toHaveLength(0);
  });
});

describe("help", () => {
  it("prints generated help and exits 0 for --help", async () => {
    const fake = fakeContext();

    await runCli(["--help"], fake.context);

    expect(fake.context.process.exitCode).toBeFalsy();
    expect(fake.stdout()).toContain("USAGE");
    expect(fake.stdout()).toContain("tick");
    expect(fake.stdout()).toContain("run");
  });

  it("supports the -h alias", async () => {
    const fake = fakeContext();

    await runCli(["-h"], fake.context);

    expect(fake.context.process.exitCode).toBeFalsy();
    expect(fake.stdout()).toContain("USAGE");
  });

  it("carries the tick/run lifecycle prose into per-command help", async () => {
    const fake = fakeContext();

    await runCli(["tick", "--help"], fake.context);

    expect(fake.stdout()).toContain("idempotent pass");
    expect(fake.stdout()).toContain("--max-workers");
  });
});

describe("version", () => {
  it.each([["--version"], ["-v"]])(
    "prints package.json's version and exits 0 for %s",
    async (flag) => {
      const fake = fakeContext();

      await runCli([flag], fake.context);

      expect(fake.context.process.exitCode).toBeFalsy();
      expect(fake.stdout().trim()).toBe(VERSION);
      expect(fake.tickCalls).toHaveLength(0);
    },
  );

  it("lists --version in the root help text", async () => {
    const fake = fakeContext();

    await runCli(["--help"], fake.context);

    expect(fake.stdout()).toContain("--version");
  });
});

describe("unknown and missing commands", () => {
  it("rejects an unknown command with guidance and exit 1", async () => {
    const fake = fakeContext();

    await runCli(["bogus"], fake.context);

    expect(fake.context.process.exitCode).toBe(1);
    expect(fake.stderr()).toContain("bogus");
  });

  it("prints usage guidance and exits non-zero for a missing command", async () => {
    const fake = fakeContext();

    await runCli([], fake.context);

    expect(fake.context.process.exitCode).toBe(1);
    expect(fake.stdout()).toContain("USAGE");
  });
});
