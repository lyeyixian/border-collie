import { describe, expect, it } from "vitest";
import { runCli } from "../../src/cli/app.js";
import type { Context } from "../../src/cli/context.js";
import { VERSION } from "../../src/cli/version.js";
import {
  ConfigError,
  type Flags,
  type ResolvedConfig,
  type WorkerAttemptConfig,
} from "../../src/core/config.js";
import type { Log, LogEvent } from "../../src/core/log.js";
import type {
  Ticket,
  WorkerOutcome,
  WorldSnapshot,
} from "../../src/core/types.js";

/** A `Log` recording every event into `events`; this fake context never derives a sub-logger, but the type requires `child`. */
function recordingLog(events: LogEvent[]): Log {
  const fn = ((event: LogEvent) => {
    events.push(event);
  }) as Log;
  fn.child = () => recordingLog(events);
  return fn;
}

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
    voidedAtMs: undefined,
    lastFailureAtMs: undefined,
    lastFailureReason: undefined,
    hasLiveWorker: false,
    ...overrides,
  };
}

function world(tickets: Ticket[]): WorldSnapshot {
  return { tickets, openAgentPrs: [], mergedAgentPrs: [] };
}

const CLOSED_WORLD = world([ticket({ number: 1, state: "closed" })]);
const STUCK_WORLD = world([ticket({ number: 1, labels: ["ready-for-human"] })]);

function workerOutcome(overrides: Partial<WorkerOutcome> = {}): WorkerOutcome {
  return {
    ticket: 7,
    attempt: 1,
    branch: "border-collie/ticket-7",
    base: "base-sha",
    transcript: ".border-collie/transcripts/ticket-7.jsonl",
    model: "sonnet",
    exitCode: 0,
    newCommits: 2,
    failure: undefined,
    infra: undefined,
    costUsd: undefined,
    turns: undefined,
    durationMs: undefined,
    subtype: undefined,
    costOverrun: false,
    ok: true,
    ...overrides,
  };
}

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
  runWorkerCalls: {
    config: WorkerAttemptConfig;
    ticket: number;
    attempt: number;
  }[];
  probeCalls: string[];
  events: LogEvent[];
  verbosityCalls: boolean[];
}

function fakeContext(
  overrides: {
    loadConfig?: (flags: Flags) => ResolvedConfig;
    tickResults?: { world: WorldSnapshot; infraFailures?: number }[];
    runWorkerOutcome?: WorkerOutcome;
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
  const runWorkerCalls: {
    config: WorkerAttemptConfig;
    ticket: number;
    attempt: number;
  }[] = [];
  const probeCalls: string[] = [];
  const events: LogEvent[] = [];
  const verbosityCalls: boolean[] = [];
  const tickResults = overrides.tickResults ?? [{ world: CLOSED_WORLD }];
  const runWorkerOutcome = overrides.runWorkerOutcome ?? workerOutcome();

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
    // Same fake resolver as `loadConfig` (structurally a `ResolvedConfig`
    // satisfies `WorkerAttemptConfig` too) — the worker command's config
    // error test drives this through the same `overrides.loadConfig`.
    loadWorkerConfig: (flags) => {
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
        dispatchPaused: dispatchPaused ?? false,
      };
    },
    runWorker: async (config, ticket, attempt) => {
      runWorkerCalls.push({ config, ticket, attempt });
      return runWorkerOutcome;
    },
    probe: async (model) => {
      probeCalls.push(model);
      return true;
    },
    now: () => 0,
    sleep: async () => {},
    scheduleInterval: () => () => {},
    log: recordingLog(events),
    setVerbose: (verbose) => {
      verbosityCalls.push(verbose);
    },
  };

  return {
    context,
    stdout: () => stdoutLines.join(""),
    stderr: () => stderrLines.join(""),
    loadConfigCalls,
    tickCalls,
    runWorkerCalls,
    probeCalls,
    events,
    verbosityCalls,
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

  it("drops --verbose from the flags object handed to config resolution", async () => {
    const fake = fakeContext();

    await runCli(["tick", "--verbose", "--parent", "1"], fake.context);

    expect(fake.loadConfigCalls[0]).not.toHaveProperty("verbose");
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

describe("verbosity flag", () => {
  it("lowers the console's minimum level to debug for tick when --verbose is passed", async () => {
    const fake = fakeContext();

    await runCli(["tick", "--verbose", "--parent", "1"], fake.context);

    expect(fake.verbosityCalls).toEqual([true]);
  });

  it("leaves the console at its default level for tick when --verbose is omitted", async () => {
    const fake = fakeContext();

    await runCli(["tick", "--parent", "1"], fake.context);

    expect(fake.verbosityCalls).toEqual([false]);
  });

  it("lowers the console's minimum level to debug for run when --verbose is passed", async () => {
    const fake = fakeContext({ tickResults: [{ world: CLOSED_WORLD }] });

    await runCli(["run", "--verbose", "--parent", "1"], fake.context);

    expect(fake.verbosityCalls).toEqual([true]);
  });

  it("does not affect config resolution — only the console sink", async () => {
    const fake = fakeContext();

    await runCli(["tick", "--verbose", "--parent", "1"], fake.context);

    expect(fake.tickCalls).toHaveLength(1);
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

  it("routes `worker` with its ticket/attempt positional args to runWorker", async () => {
    const fake = fakeContext();

    await runCli(["worker", "7", "2"], fake.context);

    expect(fake.runWorkerCalls).toEqual([
      { config: FAKE_RESOLVED_CONFIG, ticket: 7, attempt: 2 },
    ]);
  });
});

describe("worker command", () => {
  it("forwards --model and --retry-model overrides to config resolution", async () => {
    const fake = fakeContext();

    await runCli(
      ["worker", "7", "1", "--model", "haiku", "--retry-model", "opus4"],
      fake.context,
    );

    expect(fake.loadConfigCalls).toEqual([
      { model: "haiku", retryModel: "opus4" },
    ]);
  });

  it("omits unset flags from config resolution", async () => {
    const fake = fakeContext();

    await runCli(["worker", "7", "1"], fake.context);

    expect(fake.loadConfigCalls).toEqual([{}]);
  });

  it("lowers the console's minimum level to debug when --verbose is passed", async () => {
    const fake = fakeContext();

    await runCli(["worker", "7", "1", "--verbose"], fake.context);

    expect(fake.verbosityCalls).toEqual([true]);
  });

  it("rejects a non-integer ticket without calling runWorker", async () => {
    const fake = fakeContext();

    await runCli(["worker", "abc", "1"], fake.context);

    expect(fake.context.process.exitCode).toBe(1);
    expect(fake.runWorkerCalls).toHaveLength(0);
  });

  it("rejects a non-integer attempt without calling runWorker", async () => {
    const fake = fakeContext();

    await runCli(["worker", "7", "abc"], fake.context);

    expect(fake.context.process.exitCode).toBe(1);
    expect(fake.runWorkerCalls).toHaveLength(0);
  });

  it("exits 0 when the Attempt succeeded", async () => {
    const fake = fakeContext({ runWorkerOutcome: workerOutcome({ ok: true }) });

    await runCli(["worker", "7", "1"], fake.context);

    expect(fake.context.process.exitCode).toBeFalsy();
  });

  it("exits non-zero when the Attempt failed on its ticket", async () => {
    const fake = fakeContext({
      runWorkerOutcome: workerOutcome({
        ok: false,
        failure: "nonzero-exit",
        exitCode: 1,
        newCommits: 0,
      }),
    });

    await runCli(["worker", "7", "1"], fake.context);

    expect(fake.context.process.exitCode).toBe(1);
  });

  it("exits non-zero when the Attempt was voided by an infrastructure failure", async () => {
    const fake = fakeContext({
      runWorkerOutcome: workerOutcome({
        ok: false,
        infra: "usage-limit",
        exitCode: 1,
        newCommits: 0,
      }),
    });

    await runCli(["worker", "7", "1"], fake.context);

    expect(fake.context.process.exitCode).toBe(1);
  });

  it("a config error prints a one-line message, exits 1, and never calls runWorker", async () => {
    const fake = fakeContext({
      loadConfig: () => {
        throw new ConfigError("worker_max_turns must be a positive integer");
      },
    });

    await runCli(["worker", "7", "1"], fake.context);

    expect(fake.context.process.exitCode).toBe(1);
    expect(fake.stderr().trim()).toBe(
      "worker_max_turns must be a positive integer",
    );
    expect(fake.runWorkerCalls).toHaveLength(0);
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

  it("run exits 0 on Complete, narrating it through the injected log", async () => {
    const fake = fakeContext({ tickResults: [{ world: CLOSED_WORLD }] });

    await runCli(["run", "--parent", "1"], fake.context);

    expect(fake.context.process.exitCode).toBeFalsy();
    expect(fake.events.some((e) => e.kind === "complete-report")).toBe(true);
  });

  it("run exits 1 on Stuck, narrating it through the injected log", async () => {
    const fake = fakeContext({ tickResults: [{ world: STUCK_WORLD }] });

    await runCli(["run", "--parent", "1"], fake.context);

    expect(fake.context.process.exitCode).toBe(1);
    expect(fake.events.some((e) => e.kind === "stuck-report")).toBe(true);
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
    expect(fake.stdout()).toContain("worker");
  });

  it("supports the -h alias", async () => {
    const fake = fakeContext();

    await runCli(["-h"], fake.context);

    expect(fake.context.process.exitCode).toBeFalsy();
    expect(fake.stdout()).toContain("USAGE");
  });

  it("documents --verbose alongside the other flags in per-command help", async () => {
    const fake = fakeContext();

    await runCli(["tick", "--help"], fake.context);

    expect(fake.stdout()).toContain("--verbose");
  });

  it("carries the tick/run lifecycle prose into per-command help", async () => {
    const fake = fakeContext();

    await runCli(["tick", "--help"], fake.context);

    expect(fake.stdout()).toContain("idempotent pass");
    expect(fake.stdout()).toContain("--max-workers");
  });

  it("documents --verbose and the shared worker-death prose in worker's per-command help", async () => {
    const fake = fakeContext();

    await runCli(["worker", "--help"], fake.context);

    expect(fake.stdout()).toContain("--verbose");
    expect(fake.stdout()).toContain("forensic attempt");
  });

  it("does not offer scope/concurrency flags on worker's per-command help", async () => {
    const fake = fakeContext();

    await runCli(["worker", "--help"], fake.context);

    expect(fake.stdout()).not.toContain("--max-workers");
    expect(fake.stdout()).not.toContain("--parent");
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
