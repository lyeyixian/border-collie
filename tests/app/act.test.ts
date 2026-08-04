import { describe, expect, it } from "vitest";
import type { Exec } from "../../src/adapters/tracker.js";
import type {
  ConflictOutcome,
  RefinementOutcome,
} from "../../src/adapters/worker.js";
import {
  act,
  type DispatchConflictWorker,
  type DispatchRefinementWorker,
  type DispatchWorker,
  type IntervalScheduler,
  type OpenPr,
} from "../../src/app/act.js";
import type { Log, LogBindings, LogEvent } from "../../src/core/log.js";
import {
  type AttemptFailure,
  CLAIM_LABEL,
  CLAIM_MARKER,
  CONFLICT_UNRESOLVED_MARKER,
  READY_FOR_AGENT,
  READY_FOR_HUMAN,
  REFINEMENT_GIVE_UP_MARKER,
  REFINEMENT_ROUND_MARKER,
  RELEASE_MARKER,
  VOID_MARKER,
  type WorkerOutcome,
} from "../../src/core/types.js";

function recordingExec(): { exec: Exec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: Exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    return "";
  };
  return { exec, calls };
}

/**
 * Records emitted events, merging each sub-logger's bindings onto every
 * event it forwards — exactly what a real sink sees, so assertions can
 * check the bound ticket/attempt/pr fields directly instead of scraping
 * rendered text. `msgs()` mirrors the old narration-line assertions.
 */
function recordingLog(): { log: Log; events: LogEvent[] } {
  const events: LogEvent[] = [];
  function make(bindings: LogBindings): Log {
    const fn = ((event: LogEvent) => {
      events.push({ ...bindings, ...event } as LogEvent);
    }) as Log;
    fn.child = (childBindings) => make({ ...bindings, ...childBindings });
    return fn;
  }
  return { log: make({}), events };
}

/** A `Log` that discards everything, for tests uninterested in narration. */
function noopLog(): Log {
  const fn = ((_event: LogEvent) => {}) as Log;
  fn.child = () => fn;
  return fn;
}

function msgs(events: LogEvent[]): string[] {
  return events.map((e) => e.msg);
}

/** A fixed clock and a scheduler that never fires, for tests unconcerned with the heartbeat. */
const now = () => 0;
const scheduleInterval: IntervalScheduler = () => () => {};

/** Records every (ms, callback) the heartbeat scheduled, letting a test fire ticks manually. */
function fakeScheduler(): {
  scheduleInterval: IntervalScheduler;
  starts: { ms: number; callback: () => void }[];
  cancelCount: () => number;
} {
  const starts: { ms: number; callback: () => void }[] = [];
  let cancelled = 0;
  const scheduleInterval: IntervalScheduler = (ms, callback) => {
    starts.push({ ms, callback });
    return () => {
      cancelled += 1;
    };
  };
  return { scheduleInterval, starts, cancelCount: () => cancelled };
}

const noDispatch: DispatchWorker = async (ticket) => {
  throw new Error(`unexpected dispatch of #${ticket}`);
};

const noConflict: DispatchConflictWorker = async (pr) => {
  throw new Error(`unexpected conflict dispatch of PR #${pr}`);
};

const noRefinement: DispatchRefinementWorker = async (pr) => {
  throw new Error(`unexpected Refinement dispatch of PR #${pr}`);
};

/** Records which outcomes reach PR opening; answers with a predictable URL. */
function recordingOpenPr(): { openPr: OpenPr; opened: number[] } {
  const opened: number[] = [];
  const openPr: OpenPr = async (outcome) => {
    opened.push(outcome.ticket);
    return `https://github.com/o/r/pull/${outcome.ticket}0`;
  };
  return { openPr, opened };
}

function outcome(
  ticket: number,
  overrides: Partial<WorkerOutcome> = {},
): WorkerOutcome {
  return {
    ticket,
    attempt: 1,
    branch: `border-collie/ticket-${ticket}`,
    base: "base-sha",
    transcript: `.border-collie/transcripts/ticket-${ticket}.jsonl`,
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

function conflictOutcome(
  pr: number,
  overrides: Partial<ConflictOutcome> = {},
): ConflictOutcome {
  return {
    pr,
    ticket: pr,
    headRef: `border-collie/ticket-${pr}-attempt-1`,
    transcript: `.border-collie/transcripts/pr-${pr}-conflict.jsonl`,
    exitCode: 0,
    resolved: true,
    ...overrides,
  };
}

function refinementOutcome(
  pr: number,
  overrides: Partial<RefinementOutcome> = {},
): RefinementOutcome {
  return {
    pr,
    ticket: pr,
    headRef: `border-collie/ticket-${pr}-attempt-1`,
    transcript: `.border-collie/transcripts/pr-${pr}-refinement-round-1.jsonl`,
    exitCode: 0,
    newCommits: 1,
    ...overrides,
  };
}

describe("act", () => {
  it("executes releases and claims in plan order via the tracker", async () => {
    const { exec, calls } = recordingExec();
    const { openPr } = recordingOpenPr();
    const { log, events } = recordingLog();

    await act(
      [
        { type: "release", ticket: 4 },
        { type: "claim", ticket: 9 },
      ],
      {
        dispatch: noDispatch,
        openPr,
        dispatchConflict: noConflict,
        dispatchRefinement: noRefinement,
        exec,
        now,
        scheduleInterval,
        log,
      },
    );

    expect(calls).toEqual([
      ["gh", "issue", "edit", "4", "--remove-label", CLAIM_LABEL],
      [
        "gh",
        "issue",
        "comment",
        "4",
        "--body",
        expect.stringContaining(RELEASE_MARKER),
      ],
      ["gh", "issue", "edit", "9", "--add-label", CLAIM_LABEL],
      [
        "gh",
        "issue",
        "comment",
        "9",
        "--body",
        expect.stringContaining(CLAIM_MARKER),
      ],
    ]);
    expect(events.map((e) => e.kind)).toEqual(["release", "claim"]);
    expect(events.every((e) => e.level === "info")).toBe(true);
    expect(msgs(events)).toEqual([
      "released #4 (orphaned claim)",
      "claimed #9",
    ]);
  });

  it("closes a merged-but-open ticket via the tracker, linking the PR", async () => {
    const { exec, calls } = recordingExec();
    const { openPr } = recordingOpenPr();
    const { log, events } = recordingLog();

    await act(
      [{ type: "close", ticket: 6, prUrl: "https://github.com/o/r/pull/60" }],
      {
        dispatch: noDispatch,
        openPr,
        dispatchConflict: noConflict,
        dispatchRefinement: noRefinement,
        exec,
        now,
        scheduleInterval,
        log,
      },
    );

    expect(calls).toEqual([
      [
        "gh",
        "issue",
        "close",
        "6",
        "--comment",
        expect.stringContaining("https://github.com/o/r/pull/60"),
      ],
    ]);
    expect(events).toEqual([
      {
        kind: "close",
        level: "info",
        msg: "closed #6 (merged: https://github.com/o/r/pull/60)",
        ticket: 6,
        prUrl: "https://github.com/o/r/pull/60",
      },
    ]);
  });

  it("performs no writes for an empty plan", async () => {
    const { exec, calls } = recordingExec();
    const { openPr } = recordingOpenPr();

    await act([], {
      dispatch: noDispatch,
      openPr,
      dispatchConflict: noConflict,
      dispatchRefinement: noRefinement,
      exec,
      now,
      scheduleInterval,
      log: noopLog(),
    });

    expect(calls).toEqual([]);
  });

  it("runs spawned Workers concurrently, opens a PR per success, and reports each outcome", async () => {
    const { exec, calls } = recordingExec();
    const { openPr, opened } = recordingOpenPr();
    const { log, events } = recordingLog();
    const dispatched: number[] = [];
    let bothInFlight!: () => void;
    const gate = new Promise<void>((resolve) => {
      bothInFlight = resolve;
    });
    // Resolves only once both Workers are in flight: serial dispatch would hang.
    const dispatch: DispatchWorker = async (ticket) => {
      dispatched.push(ticket);
      if (dispatched.length === 2) bothInFlight();
      await gate;
      return ticket === 2
        ? outcome(2, { newCommits: 3 })
        : outcome(4, {
            exitCode: 1,
            newCommits: 0,
            failure: "nonzero-exit",
            ok: false,
          });
    };

    await act(
      [
        { type: "claim", ticket: 2 },
        { type: "spawn", ticket: 2, attempt: 1 },
        { type: "claim", ticket: 4 },
        { type: "spawn", ticket: 4, attempt: 1 },
      ],
      {
        dispatch,
        openPr,
        dispatchConflict: noConflict,
        dispatchRefinement: noRefinement,
        exec,
        now,
        scheduleInterval,
        log,
      },
    );

    expect(dispatched).toEqual([2, 4]);
    expect(opened).toEqual([2]); // only the success becomes a PR
    // Wiring check: act() reaches the tracker through settleAttempt with the
    // right ticket per outcome — a success writes nothing beyond its claim,
    // a Ticket failure is released with its forensic record. Exact write
    // content is settleAttempt's own tests' job.
    expect(calls).toEqual([
      ["gh", "issue", "edit", "2", "--add-label", CLAIM_LABEL],
      [
        "gh",
        "issue",
        "comment",
        "2",
        "--body",
        expect.stringContaining(CLAIM_MARKER),
      ],
      ["gh", "issue", "edit", "4", "--add-label", CLAIM_LABEL],
      [
        "gh",
        "issue",
        "comment",
        "4",
        "--body",
        expect.stringContaining(CLAIM_MARKER),
      ],
      ["gh", "issue", "edit", "4", "--remove-label", CLAIM_LABEL],
      [
        "gh",
        "issue",
        "comment",
        "4",
        "--body",
        expect.stringContaining(RELEASE_MARKER),
      ],
    ]);
    expect(events.map((e) => e.kind)).toEqual([
      "claim",
      "spawn",
      "claim",
      "spawn",
      "worker-outcome",
      "pr-opened",
      "worker-outcome",
      "attempt-released",
    ]);
    // Success and a Ticket failure that will be retried are both info — the
    // retry ladder working as designed must not read as an alarm.
    expect(events.map((e) => e.level)).toEqual([
      "info",
      "info",
      "info",
      "info",
      "info",
      "info",
      "info",
      "info",
    ]);
    expect(msgs(events)).toEqual([
      "claimed #2",
      "spawned Worker (attempt 1)",
      "claimed #4",
      "spawned Worker (attempt 1)",
      "Worker succeeded: 3 new commits on border-collie/ticket-2 (transcript: .border-collie/transcripts/ticket-2.jsonl)",
      "opened draft PR: https://github.com/o/r/pull/20",
      "Worker failed attempt 1 (nonzero-exit): exit 1, 0 new commits on border-collie/ticket-4 (transcript: .border-collie/transcripts/ticket-4.jsonl)",
      "released with the attempt record (failed attempt 1)",
    ]);
    // Each Worker's own sub-logger binds its ticket and attempt onto every
    // line it emits — concurrent Workers stay tellable apart by field, not
    // by a "#N" buried in prose.
    const worker2Events = events.filter(
      (e) => e.kind !== "claim" && (e as { ticket?: number }).ticket === 2,
    );
    expect(worker2Events).toHaveLength(3); // spawn, worker-outcome, pr-opened
    expect(
      worker2Events.every((e) => (e as { attempt?: number }).attempt === 1),
    ).toBe(true);
    const worker4Events = events.filter(
      (e) => e.kind !== "claim" && (e as { ticket?: number }).ticket === 4,
    );
    expect(worker4Events).toHaveLength(3); // spawn, worker-outcome, attempt-released
  });

  it("dispatches with the planned attempt number (the retry ladder rung)", async () => {
    const { exec } = recordingExec();
    const attempts: [number, number][] = [];
    const dispatch: DispatchWorker = async (ticket, attempt) => {
      attempts.push([ticket, attempt]);
      return outcome(ticket);
    };

    await act([{ type: "spawn", ticket: 7, attempt: 2 }], {
      dispatch,
      openPr: recordingOpenPr().openPr,
      dispatchConflict: noConflict,
      dispatchRefinement: noRefinement,
      exec,
      now,
      scheduleInterval,
      log: noopLog(),
    });

    expect(attempts).toEqual([[7, 2]]);
  });

  it("escalates: forensic comment, then the ready-for-agent → ready-for-human label swap, logged at warn", async () => {
    const { exec, calls } = recordingExec();
    const { log, events } = recordingLog();
    const failures: AttemptFailure[] = [
      {
        attempt: 1,
        reason: "timeout",
        model: "sonnet",
        branch: "border-collie/ticket-5",
        transcript: ".border-collie/transcripts/ticket-5.jsonl",
      },
    ];

    await act([{ type: "escalate", ticket: 5, failures }], {
      dispatch: noDispatch,
      openPr: recordingOpenPr().openPr,
      dispatchConflict: noConflict,
      dispatchRefinement: noRefinement,
      exec,
      now,
      scheduleInterval,
      log,
    });

    expect(calls).toEqual([
      [
        "gh",
        "issue",
        "comment",
        "5",
        "--body",
        expect.stringContaining("Escalated"),
      ],
      [
        "gh",
        "issue",
        "edit",
        "5",
        "--remove-label",
        "ready-for-agent",
        "--add-label",
        "ready-for-human",
      ],
    ]);
    expect(events).toEqual([
      {
        kind: "escalate",
        level: "warn",
        msg: "escalated #5 to ready-for-human (attempts exhausted)",
        ticket: 5,
      },
    ]);
  });

  it("still opens the PR for a cost-overrun Attempt (the write settleAttempt performs is unaffected)", async () => {
    const { exec, calls } = recordingExec();
    const { openPr, opened } = recordingOpenPr();
    const dispatch: DispatchWorker = async () =>
      outcome(7, { costUsd: 25.5, turns: 80, costOverrun: true });

    await act([{ type: "spawn", ticket: 7, attempt: 1 }], {
      dispatch,
      openPr,
      dispatchConflict: noConflict,
      dispatchRefinement: noRefinement,
      exec,
      now,
      scheduleInterval,
      log: noopLog(),
    });

    expect(opened).toEqual([7]); // the work is kept — discarding refunds nothing
    expect(calls).toEqual([]); // no tracker writes: not a failure
  });

  it("reaches the tracker for an infrastructure-voided attempt and counts it in the report", async () => {
    const { exec, calls } = recordingExec();
    const dispatch: DispatchWorker = async () =>
      outcome(7, {
        exitCode: 1,
        newCommits: 0,
        infra: "usage-limit",
        ok: false,
      });

    const report = await act([{ type: "spawn", ticket: 7, attempt: 1 }], {
      dispatch,
      openPr: recordingOpenPr().openPr,
      dispatchConflict: noConflict,
      dispatchRefinement: noRefinement,
      exec,
      now,
      scheduleInterval,
      log: noopLog(),
    });

    // Wiring check: act() reaches the tracker through settleAttempt for this
    // ticket. Exact write content is settleAttempt's own tests' job.
    expect(calls).toEqual([
      [
        "gh",
        "issue",
        "comment",
        "7",
        "--body",
        expect.stringContaining(VOID_MARKER),
      ],
    ]);
    expect(report).toEqual({ infraFailures: 1 });
  });

  it("reclassifies several Workers failing the same way in one Tick as correlated infrastructure", async () => {
    const { exec, calls } = recordingExec();
    const { log, events } = recordingLog();
    const dispatch: DispatchWorker = async (ticket) =>
      outcome(ticket, {
        exitCode: 1,
        newCommits: 0,
        failure: "nonzero-exit",
        ok: false,
      });

    const report = await act(
      [
        { type: "spawn", ticket: 2, attempt: 1 },
        { type: "spawn", ticket: 4, attempt: 1 },
      ],
      {
        dispatch,
        openPr: recordingOpenPr().openPr,
        dispatchConflict: noConflict,
        dispatchRefinement: noRefinement,
        exec,
        now,
        scheduleInterval,
        log,
      },
    );

    // Both attempts voided, none released: no claim label ever removed.
    expect(calls.map((c) => c.slice(0, 3))).toEqual([
      ["gh", "issue", "comment"],
      ["gh", "issue", "comment"],
    ]);
    expect(calls.every((c) => c[5]?.includes(VOID_MARKER))).toBe(true);
    expect(report).toEqual({ infraFailures: 2 });
    const workerOutcomes = events.filter((e) => e.kind === "worker-outcome");
    expect(workerOutcomes.every((e) => e.level === "warn")).toBe(true);
    expect(msgs(events).join("\n")).toContain("correlated");
  });

  it("reports zero infrastructure failures for a clean Tick", async () => {
    const { exec } = recordingExec();
    const dispatch: DispatchWorker = async (ticket) => outcome(ticket);

    const report = await act([{ type: "spawn", ticket: 2, attempt: 1 }], {
      dispatch,
      openPr: recordingOpenPr().openPr,
      dispatchConflict: noConflict,
      dispatchRefinement: noRefinement,
      exec,
      now,
      scheduleInterval,
      log: noopLog(),
    });

    expect(report).toEqual({ infraFailures: 0 });
  });

  it("completes without waiting for a Worker dispatched fire-and-forget (the remote implementation, issue #73)", async () => {
    const { exec, calls } = recordingExec();
    const { openPr, opened } = recordingOpenPr();
    const { log, events } = recordingLog();
    // The remote dispatch resolves once the job is merely triggered — never
    // once it finishes. Nothing here ever settles it, proving the Tick
    // itself never waited for that to happen.
    const dispatch: DispatchWorker = async () => undefined;

    const report = await act([{ type: "spawn", ticket: 7, attempt: 1 }], {
      dispatch,
      openPr,
      dispatchConflict: noConflict,
      dispatchRefinement: noRefinement,
      exec,
      now,
      scheduleInterval,
      log,
    });

    expect(opened).toEqual([]); // nothing to open a PR for yet
    expect(calls).toEqual([]); // nothing to write to the tracker yet
    expect(report).toEqual({ infraFailures: 0 });
    expect(events.map((e) => e.kind)).toEqual([
      "spawn",
      "worker-dispatched-async",
    ]);
  });

  it("settles only the Workers dispatch actually hands back an outcome for", async () => {
    const { exec, calls } = recordingExec();
    const { openPr, opened } = recordingOpenPr();
    const { log, events } = recordingLog();
    const dispatch: DispatchWorker = async (ticket) =>
      ticket === 2 ? undefined : outcome(4, { newCommits: 3 });

    const report = await act(
      [
        { type: "spawn", ticket: 2, attempt: 1 },
        { type: "spawn", ticket: 4, attempt: 1 },
      ],
      {
        dispatch,
        openPr,
        dispatchConflict: noConflict,
        dispatchRefinement: noRefinement,
        exec,
        now,
        scheduleInterval,
        log,
      },
    );

    expect(opened).toEqual([4]);
    expect(calls).toEqual([]); // a clean success writes nothing beyond its claim
    expect(report).toEqual({ infraFailures: 0 });
    const ticket2Events = events.filter(
      (e) => (e as { ticket?: number }).ticket === 2,
    );
    expect(ticket2Events.map((e) => e.kind)).toEqual([
      "spawn",
      "worker-dispatched-async",
    ]);
  });

  it("still reports finished Workers when a sibling dispatch throws, then rethrows", async () => {
    const { exec } = recordingExec();
    const { openPr } = recordingOpenPr();
    const { log, events } = recordingLog();
    const dispatch: DispatchWorker = async (ticket) => {
      if (ticket === 4) throw new Error("git exploded");
      return outcome(ticket);
    };

    await expect(
      act(
        [
          { type: "spawn", ticket: 2, attempt: 1 },
          { type: "spawn", ticket: 4, attempt: 1 },
        ],
        {
          dispatch,
          openPr,
          dispatchConflict: noConflict,
          dispatchRefinement: noRefinement,
          exec,
          now,
          scheduleInterval,
          log,
        },
      ),
    ).rejects.toThrow("git exploded");

    expect(msgs(events)).toContain(
      "Worker succeeded: 2 new commits on border-collie/ticket-2 (transcript: .border-collie/transcripts/ticket-2.jsonl)",
    );
  });

  it("still reports the Worker's outcome when PR opening fails, then rethrows, logging the failure at error", async () => {
    const { exec } = recordingExec();
    const { log, events } = recordingLog();
    const dispatch: DispatchWorker = async (ticket) => outcome(ticket);
    const openPr: OpenPr = async () => {
      throw new Error("gh pr create exploded");
    };

    await expect(
      act([{ type: "spawn", ticket: 2, attempt: 1 }], {
        dispatch,
        openPr,
        dispatchConflict: noConflict,
        dispatchRefinement: noRefinement,
        exec,
        now,
        scheduleInterval,
        log,
      }),
    ).rejects.toThrow("gh pr create exploded");

    expect(msgs(events)).toContain(
      "Worker succeeded: 2 new commits on border-collie/ticket-2 (transcript: .border-collie/transcripts/ticket-2.jsonl)",
    );
    const prOpenFailed = events.find((e) => e.kind === "pr-open-failed");
    expect(prOpenFailed?.level).toBe("error");
    expect(prOpenFailed?.msg).toBe(
      "PR opening failed after a successful Attempt: gh pr create exploded",
    );
    // Bound by the Worker's sub-logger, not repeated per call site.
    expect(prOpenFailed).toMatchObject({ ticket: 2, attempt: 1 });
  });
});

describe("act: heartbeat", () => {
  it("emits no heartbeat when no Worker is running", async () => {
    const { exec } = recordingExec();
    const { log, events } = recordingLog();
    const scheduler = fakeScheduler();

    await act([{ type: "release", ticket: 4 }], {
      dispatch: noDispatch,
      openPr: recordingOpenPr().openPr,
      dispatchConflict: noConflict,
      dispatchRefinement: noRefinement,
      exec,
      now,
      scheduleInterval: scheduler.scheduleInterval,
      log,
    });

    expect(scheduler.starts).toEqual([]);
    expect(events.some((e) => e.kind === "heartbeat")).toBe(false);
  });

  it("schedules the heartbeat once a minute, at info, and reports it stops once every Worker settles", async () => {
    const { exec } = recordingExec();
    const { log, events } = recordingLog();
    const scheduler = fakeScheduler();
    let releaseWorker!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseWorker = resolve;
    });
    const dispatch: DispatchWorker = async () => {
      await gate;
      return outcome(7);
    };

    const pending = act([{ type: "spawn", ticket: 7, attempt: 1 }], {
      dispatch,
      openPr: recordingOpenPr().openPr,
      dispatchConflict: noConflict,
      dispatchRefinement: noRefinement,
      exec,
      now,
      scheduleInterval: scheduler.scheduleInterval,
      log,
    });

    expect(scheduler.starts).toHaveLength(1);
    expect(scheduler.starts[0]?.ms).toBe(60_000);
    expect(scheduler.cancelCount()).toBe(0);

    scheduler.starts[0]?.callback();
    const heartbeat = events.find((e) => e.kind === "heartbeat");
    expect(heartbeat?.level).toBe("info");
    expect(heartbeat).toMatchObject({
      workers: [{ ticket: 7, attempt: 1, elapsedMs: 0, sinceOutputMs: 0 }],
    });

    releaseWorker();
    await pending;

    expect(scheduler.cancelCount()).toBe(1);
  });

  it("reports elapsed time and time since output independently, updated via the Worker's activity callback", async () => {
    const { exec } = recordingExec();
    const { log, events } = recordingLog();
    const scheduler = fakeScheduler();
    const clock = { ms: 0 };
    let activityCallback!: () => void;
    let releaseWorker!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseWorker = resolve;
    });
    const dispatch: DispatchWorker = async (ticket, _attempt, onActivity) => {
      activityCallback = onActivity;
      await gate;
      return outcome(ticket);
    };

    const pending = act([{ type: "spawn", ticket: 7, attempt: 1 }], {
      dispatch,
      openPr: recordingOpenPr().openPr,
      dispatchConflict: noConflict,
      dispatchRefinement: noRefinement,
      exec,
      now: () => clock.ms,
      scheduleInterval: scheduler.scheduleInterval,
      log,
    });

    clock.ms = 20_000;
    activityCallback(); // the Worker produced output at t=20s
    clock.ms = 90_000;
    scheduler.starts[0]?.callback(); // the heartbeat fires at t=90s

    const heartbeat = events.find((e) => e.kind === "heartbeat");
    expect(heartbeat).toMatchObject({
      workers: [
        { ticket: 7, attempt: 1, elapsedMs: 90_000, sinceOutputMs: 70_000 },
      ],
    });

    releaseWorker();
    await pending;
  });

  it("covers the whole fleet on one line and keeps running while any Worker is still in flight", async () => {
    const { exec } = recordingExec();
    const { log, events } = recordingLog();
    const scheduler = fakeScheduler();
    let releaseSlow!: () => void;
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    const dispatch: DispatchWorker = async (ticket) => {
      if (ticket === 4) return outcome(4);
      await slowGate;
      return outcome(ticket);
    };
    // openPr runs only after #4's dispatch promise has settled and its
    // activity entry cleared — awaiting it is a deterministic way to know
    // #4 dropped out of the fleet before the heartbeat is made to fire.
    let ticket4Settled!: () => void;
    const ticket4SettledPromise = new Promise<void>((resolve) => {
      ticket4Settled = resolve;
    });
    const openPr: OpenPr = async (settledOutcome) => {
      if (settledOutcome.ticket === 4) ticket4Settled();
      return `https://github.com/o/r/pull/${settledOutcome.ticket}0`;
    };

    const pending = act(
      [
        { type: "spawn", ticket: 2, attempt: 1 },
        { type: "spawn", ticket: 4, attempt: 1 },
      ],
      {
        dispatch,
        openPr,
        dispatchConflict: noConflict,
        dispatchRefinement: noRefinement,
        exec,
        now,
        scheduleInterval: scheduler.scheduleInterval,
        log,
      },
    );
    await ticket4SettledPromise;

    scheduler.starts[0]?.callback();
    const heartbeat = events.find((e) => e.kind === "heartbeat");
    expect(heartbeat).toMatchObject({
      workers: [{ ticket: 2, attempt: 1 }],
    });
    // Still one Worker in flight (#2): the scheduler is not cancelled yet.
    expect(scheduler.cancelCount()).toBe(0);

    releaseSlow();
    await pending;

    expect(scheduler.cancelCount()).toBe(1);
  });

  it("starts only one heartbeat scheduler for a Tick spawning several Workers", async () => {
    const { exec } = recordingExec();
    const dispatch: DispatchWorker = async (ticket) => outcome(ticket);
    const scheduler = fakeScheduler();

    await act(
      [
        { type: "spawn", ticket: 2, attempt: 1 },
        { type: "spawn", ticket: 4, attempt: 1 },
      ],
      {
        dispatch,
        openPr: recordingOpenPr().openPr,
        dispatchConflict: noConflict,
        dispatchRefinement: noRefinement,
        exec,
        now,
        scheduleInterval: scheduler.scheduleInterval,
        log: noopLog(),
      },
    );

    expect(scheduler.starts).toHaveLength(1);
  });
});

describe("act: PR upkeep", () => {
  it("mechanically updates a behind PR's branch via the tracker", async () => {
    const { exec, calls } = recordingExec();
    const { log, events } = recordingLog();

    await act([{ type: "update-branch", pr: 30, ticket: 3 }], {
      dispatch: noDispatch,
      openPr: recordingOpenPr().openPr,
      dispatchConflict: noConflict,
      dispatchRefinement: noRefinement,
      exec,
      now,
      scheduleInterval,
      log,
    });

    expect(calls).toEqual([["gh", "pr", "update-branch", "30", "--rebase"]]);
    expect(events).toEqual([
      {
        kind: "update-branch",
        level: "info",
        msg: "updated PR #30 branch (mechanical rebase onto the base)",
        pr: 30,
      },
    ]);
  });

  it("flips a green draft PR to ready for review via the tracker", async () => {
    const { exec, calls } = recordingExec();
    const { log, events } = recordingLog();

    await act([{ type: "mark-ready", pr: 30, ticket: 3 }], {
      dispatch: noDispatch,
      openPr: recordingOpenPr().openPr,
      dispatchConflict: noConflict,
      dispatchRefinement: noRefinement,
      exec,
      now,
      scheduleInterval,
      log,
    });

    expect(calls).toEqual([["gh", "pr", "ready", "30"]]);
    expect(events).toEqual([
      {
        kind: "mark-ready",
        level: "info",
        msg: "marked PR #30 ready for review",
        pr: 30,
      },
    ]);
  });

  it("pushes the branch and converts the PR to draft when the conflict Worker resolves the merge", async () => {
    const { exec, calls } = recordingExec();
    const { log, events } = recordingLog();
    const dispatchConflict: DispatchConflictWorker = async (
      pr,
      ticket,
      headRef,
    ) => conflictOutcome(pr, { ticket, headRef, resolved: true });

    await act(
      [
        {
          type: "conflict-worker",
          pr: 30,
          ticket: 3,
          headRef: "border-collie/ticket-3-attempt-1",
        },
      ],
      {
        dispatch: noDispatch,
        openPr: recordingOpenPr().openPr,
        dispatchConflict,
        dispatchRefinement: noRefinement,
        exec,
        now,
        scheduleInterval,
        log,
      },
    );

    // The draft conversion follows the push, and rides the same injected
    // command-execution dependency the rest of PR upkeep writes through.
    expect(calls).toEqual([
      ["git", "push", "--force", "origin", "border-collie/ticket-3-attempt-1"],
      ["gh", "pr", "ready", "30", "--undo"],
    ]);
    expect(events.map((e) => e.kind)).toEqual([
      "conflict-dispatch",
      "conflict-outcome",
      "conflict-pushed",
      "conflict-drafted",
    ]);
    expect(events.every((e) => e.level === "info")).toBe(true);
    expect(msgs(events)).toEqual([
      "dispatched conflict Worker (ticket #3)",
      "Conflict Worker resolved the conflicts on border-collie/ticket-3-attempt-1 (transcript: .border-collie/transcripts/pr-30-conflict.jsonl)",
      "pushed the resolved rebase",
      "converted the PR to draft for a re-read before it can merge",
    ]);
    // Bound by the Conflict Worker's sub-logger, not repeated per call site.
    expect(events.every((e) => (e as { pr?: number }).pr === 30)).toBe(true);
  });

  it("asks for human resolution when the conflict Worker gives up (no push), logged at warn", async () => {
    const { exec, calls } = recordingExec();
    const { log, events } = recordingLog();
    const dispatchConflict: DispatchConflictWorker = async (
      pr,
      ticket,
      headRef,
    ) => conflictOutcome(pr, { ticket, headRef, exitCode: 1, resolved: false });

    await act(
      [
        {
          type: "conflict-worker",
          pr: 30,
          ticket: 3,
          headRef: "border-collie/ticket-3-attempt-1",
        },
      ],
      {
        dispatch: noDispatch,
        openPr: recordingOpenPr().openPr,
        dispatchConflict,
        dispatchRefinement: noRefinement,
        exec,
        now,
        scheduleInterval,
        log,
      },
    );

    // The unresolved marker and nothing else: an unresolved conflict pushes
    // nothing, so there is no resolution to hold back from merging either.
    expect(calls).toEqual([
      [
        "gh",
        "pr",
        "comment",
        "30",
        "--body",
        expect.stringContaining(CONFLICT_UNRESOLVED_MARKER),
      ],
    ]);
    expect(events.map((e) => e.kind)).toEqual([
      "conflict-dispatch",
      "conflict-outcome",
      "conflict-unresolved",
    ]);
    expect(events.map((e) => e.level)).toEqual(["info", "warn", "warn"]);
    expect(msgs(events)).toEqual([
      "dispatched conflict Worker (ticket #3)",
      "Conflict Worker could not resolve the conflicts (exit 1) on border-collie/ticket-3-attempt-1 (transcript: .border-collie/transcripts/pr-30-conflict.jsonl)",
      "asked for human resolution",
    ]);
    // Bound by the Conflict Worker's sub-logger, not repeated per call site.
    expect(events.every((e) => (e as { pr?: number }).pr === 30)).toBe(true);
  });

  it("does not convert the PR to draft when pushing the resolution fails", async () => {
    const calls: string[][] = [];
    const exec: Exec = async (cmd, args) => {
      calls.push([cmd, ...args]);
      if (cmd === "git") throw new Error("push rejected");
      return "";
    };
    const dispatchConflict: DispatchConflictWorker = async (
      pr,
      ticket,
      headRef,
    ) => conflictOutcome(pr, { ticket, headRef, resolved: true });

    await expect(
      act(
        [
          {
            type: "conflict-worker",
            pr: 30,
            ticket: 3,
            headRef: "border-collie/ticket-3-attempt-1",
          },
        ],
        {
          dispatch: noDispatch,
          openPr: recordingOpenPr().openPr,
          dispatchConflict,
          dispatchRefinement: noRefinement,
          exec,
          now,
          scheduleInterval,
          log: noopLog(),
        },
      ),
    ).rejects.toThrow("push rejected");

    // Nothing reached the PR: an unpushed resolution leaves the PR exactly as
    // the operator last saw it, so drafting it would only obstruct them.
    expect(calls).toEqual([
      ["git", "push", "--force", "origin", "border-collie/ticket-3-attempt-1"],
    ]);
  });

  it("runs conflict Workers concurrently with dispatch Workers and reports both", async () => {
    const { exec } = recordingExec();
    const { log, events } = recordingLog();
    const inFlight: string[] = [];
    let bothInFlight!: () => void;
    const gate = new Promise<void>((resolve) => {
      bothInFlight = resolve;
    });
    const dispatch: DispatchWorker = async (ticket) => {
      inFlight.push(`worker-${ticket}`);
      if (inFlight.length === 2) bothInFlight();
      await gate;
      return outcome(ticket);
    };
    const dispatchConflict: DispatchConflictWorker = async (
      pr,
      ticket,
      headRef,
    ) => {
      inFlight.push(`conflict-${pr}`);
      if (inFlight.length === 2) bothInFlight();
      await gate;
      return conflictOutcome(pr, { ticket, headRef, resolved: true });
    };

    await act(
      [
        {
          type: "conflict-worker",
          pr: 40,
          ticket: 4,
          headRef: "border-collie/ticket-4-attempt-1",
        },
        { type: "spawn", ticket: 2, attempt: 1 },
      ],
      {
        dispatch,
        openPr: recordingOpenPr().openPr,
        dispatchConflict,
        dispatchRefinement: noRefinement,
        exec,
        now,
        scheduleInterval,
        log,
      },
    );

    expect(inFlight.sort()).toEqual(["conflict-40", "worker-2"]);
    expect(msgs(events)).toContain("pushed the resolved rebase");
    expect(msgs(events)).toContain(
      "Worker succeeded: 2 new commits on border-collie/ticket-2 (transcript: .border-collie/transcripts/ticket-2.jsonl)",
    );
  });

  it("reports settled Workers before rethrowing a conflict Worker's infrastructure failure", async () => {
    const { exec } = recordingExec();
    const { log, events } = recordingLog();
    const dispatch: DispatchWorker = async (ticket) => outcome(ticket);
    const dispatchConflict: DispatchConflictWorker = async () => {
      throw new Error("claude ENOENT");
    };

    await expect(
      act(
        [
          {
            type: "conflict-worker",
            pr: 40,
            ticket: 4,
            headRef: "border-collie/ticket-4-attempt-1",
          },
          { type: "spawn", ticket: 2, attempt: 1 },
        ],
        {
          dispatch,
          openPr: recordingOpenPr().openPr,
          dispatchConflict,
          dispatchRefinement: noRefinement,
          exec,
          now,
          scheduleInterval,
          log,
        },
      ),
    ).rejects.toThrow("claude ENOENT");

    expect(msgs(events)).toContain(
      "Worker succeeded: 2 new commits on border-collie/ticket-2 (transcript: .border-collie/transcripts/ticket-2.jsonl)",
    );
  });
});

describe("act: Refinement", () => {
  it("posts the round marker before dispatching the Refinement Worker", async () => {
    const { exec, calls } = recordingExec();
    const { log, events } = recordingLog();
    let commentedBeforeDispatch = false;
    const dispatchRefinement: DispatchRefinementWorker = async (
      pr,
      ticket,
      headRef,
    ) => {
      commentedBeforeDispatch = calls.length === 1;
      return refinementOutcome(pr, { ticket, headRef, newCommits: 0 });
    };

    await act(
      [
        {
          type: "refine-pr",
          pr: 30,
          ticket: 3,
          headRef: "border-collie/ticket-3-attempt-1",
          round: 1,
        },
      ],
      {
        dispatch: noDispatch,
        openPr: recordingOpenPr().openPr,
        dispatchConflict: noConflict,
        dispatchRefinement,
        exec,
        now,
        scheduleInterval,
        log,
      },
    );

    expect(commentedBeforeDispatch).toBe(true);
    expect(calls).toEqual([
      [
        "gh",
        "pr",
        "comment",
        "30",
        "--body",
        expect.stringContaining(REFINEMENT_ROUND_MARKER),
      ],
    ]);
    expect(events.map((e) => e.kind)).toEqual([
      "refinement-round-started",
      "refinement-outcome",
    ]);
    expect(msgs(events)).toEqual([
      "started Refinement round 1 for PR #30 (ticket #3)",
      "Refinement Worker finished: 0 new commits on border-collie/ticket-3-attempt-1 (transcript: .border-collie/transcripts/pr-30-refinement-round-1.jsonl)",
    ]);
  });

  it("pushes the branch when the Refinement round commits a fix", async () => {
    const { exec, calls } = recordingExec();
    const { log, events } = recordingLog();
    const dispatchRefinement: DispatchRefinementWorker = async (
      pr,
      ticket,
      headRef,
    ) => refinementOutcome(pr, { ticket, headRef, newCommits: 2 });

    await act(
      [
        {
          type: "refine-pr",
          pr: 30,
          ticket: 3,
          headRef: "border-collie/ticket-3-attempt-1",
          round: 1,
        },
      ],
      {
        dispatch: noDispatch,
        openPr: recordingOpenPr().openPr,
        dispatchConflict: noConflict,
        dispatchRefinement,
        exec,
        now,
        scheduleInterval,
        log,
      },
    );

    expect(calls.at(-1)).toEqual([
      "git",
      "push",
      "--force",
      "origin",
      "border-collie/ticket-3-attempt-1",
    ]);
    expect(events.map((e) => e.kind)).toEqual([
      "refinement-round-started",
      "refinement-outcome",
      "refinement-pushed",
    ]);
  });

  it("does not push when the Refinement round committed nothing", async () => {
    const { exec, calls } = recordingExec();
    const { log, events } = recordingLog();
    const dispatchRefinement: DispatchRefinementWorker = async (
      pr,
      ticket,
      headRef,
    ) => refinementOutcome(pr, { ticket, headRef, newCommits: 0 });

    await act(
      [
        {
          type: "refine-pr",
          pr: 30,
          ticket: 3,
          headRef: "border-collie/ticket-3-attempt-1",
          round: 1,
        },
      ],
      {
        dispatch: noDispatch,
        openPr: recordingOpenPr().openPr,
        dispatchConflict: noConflict,
        dispatchRefinement,
        exec,
        now,
        scheduleInterval,
        log,
      },
    );

    expect(calls.some((c) => c[1] === "push")).toBe(false);
    expect(events.map((e) => e.kind)).not.toContain("refinement-pushed");
  });

  it("gives up Refining via the tracker: Ticket comment, label swap, then the PR's give-up marker", async () => {
    const { exec, calls } = recordingExec();
    const { log, events } = recordingLog();

    await act([{ type: "refinement-give-up", pr: 30, ticket: 3, rounds: 3 }], {
      dispatch: noDispatch,
      openPr: recordingOpenPr().openPr,
      dispatchConflict: noConflict,
      dispatchRefinement: noRefinement,
      exec,
      now,
      scheduleInterval,
      log,
    });

    expect(calls).toEqual([
      [
        "gh",
        "issue",
        "comment",
        "3",
        "--body",
        expect.stringContaining("Refinement give-up"),
      ],
      [
        "gh",
        "issue",
        "edit",
        "3",
        "--remove-label",
        READY_FOR_AGENT,
        "--add-label",
        READY_FOR_HUMAN,
      ],
      [
        "gh",
        "pr",
        "comment",
        "30",
        "--body",
        expect.stringContaining(REFINEMENT_GIVE_UP_MARKER),
      ],
    ]);
    expect(events).toEqual([
      {
        kind: "refinement-give-up",
        level: "warn",
        msg: "gave up Refining PR #30 after 3 rounds (ticket #3 → ready-for-human)",
        pr: 30,
        ticket: 3,
        rounds: 3,
      },
    ]);
  });

  it("runs Refinement Workers concurrently with dispatch Workers and reports both", async () => {
    const { exec } = recordingExec();
    const { log, events } = recordingLog();
    const inFlight: string[] = [];
    let bothInFlight!: () => void;
    const gate = new Promise<void>((resolve) => {
      bothInFlight = resolve;
    });
    const dispatch: DispatchWorker = async (ticket) => {
      inFlight.push(`worker-${ticket}`);
      if (inFlight.length === 2) bothInFlight();
      await gate;
      return outcome(ticket);
    };
    const dispatchRefinement: DispatchRefinementWorker = async (
      pr,
      ticket,
      headRef,
    ) => {
      inFlight.push(`refine-${pr}`);
      if (inFlight.length === 2) bothInFlight();
      await gate;
      return refinementOutcome(pr, { ticket, headRef, newCommits: 1 });
    };

    await act(
      [
        {
          type: "refine-pr",
          pr: 40,
          ticket: 4,
          headRef: "border-collie/ticket-4-attempt-1",
          round: 1,
        },
        { type: "spawn", ticket: 2, attempt: 1 },
      ],
      {
        dispatch,
        openPr: recordingOpenPr().openPr,
        dispatchConflict: noConflict,
        dispatchRefinement,
        exec,
        now,
        scheduleInterval,
        log,
      },
    );

    expect(inFlight.sort()).toEqual(["refine-40", "worker-2"]);
    expect(msgs(events)).toContain("pushed the Refinement fix");
    expect(msgs(events)).toContain(
      "Worker succeeded: 2 new commits on border-collie/ticket-2 (transcript: .border-collie/transcripts/ticket-2.jsonl)",
    );
  });

  it("reports settled Workers before rethrowing a Refinement Worker's infrastructure failure", async () => {
    const { exec } = recordingExec();
    const { log, events } = recordingLog();
    const dispatch: DispatchWorker = async (ticket) => outcome(ticket);
    const dispatchRefinement: DispatchRefinementWorker = async () => {
      throw new Error("claude ENOENT");
    };

    await expect(
      act(
        [
          {
            type: "refine-pr",
            pr: 40,
            ticket: 4,
            headRef: "border-collie/ticket-4-attempt-1",
            round: 1,
          },
          { type: "spawn", ticket: 2, attempt: 1 },
        ],
        {
          dispatch,
          openPr: recordingOpenPr().openPr,
          dispatchConflict: noConflict,
          dispatchRefinement,
          exec,
          now,
          scheduleInterval,
          log,
        },
      ),
    ).rejects.toThrow("claude ENOENT");

    expect(msgs(events)).toContain(
      "Worker succeeded: 2 new commits on border-collie/ticket-2 (transcript: .border-collie/transcripts/ticket-2.jsonl)",
    );
  });
});
