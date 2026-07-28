import { describe, expect, it } from "vitest";
import type { Exec } from "../../src/adapters/tracker.js";
import type { ConflictOutcome } from "../../src/adapters/worker.js";
import {
  act,
  type DispatchConflictWorker,
  type DispatchWorker,
  type OpenPr,
} from "../../src/app/act.js";
import type { Log, LogBindings, LogEvent } from "../../src/core/log.js";
import {
  type AttemptFailure,
  attemptMarker,
  CLAIM_MARKER,
  CONFLICT_UNRESOLVED_MARKER,
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

const noDispatch: DispatchWorker = async (ticket) => {
  throw new Error(`unexpected dispatch of #${ticket}`);
};

const noConflict: DispatchConflictWorker = async (pr) => {
  throw new Error(`unexpected conflict dispatch of PR #${pr}`);
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

describe("act", () => {
  it("executes releases and claims in plan order via the tracker", async () => {
    const { exec, calls } = recordingExec();
    const { openPr } = recordingOpenPr();
    const { log, events } = recordingLog();

    await act(
      [
        { type: "release", ticket: 4, assignees: ["operator"] },
        { type: "claim", ticket: 9 },
      ],
      {
        dispatch: noDispatch,
        openPr,
        dispatchConflict: noConflict,
        exec,
        log,
      },
    );

    expect(calls).toEqual([
      ["gh", "issue", "edit", "4", "--remove-assignee", "operator"],
      [
        "gh",
        "issue",
        "comment",
        "4",
        "--body",
        expect.stringContaining(RELEASE_MARKER),
      ],
      ["gh", "issue", "edit", "9", "--add-assignee", "@me"],
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
        exec,
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
      exec,
      log: noopLog(),
    });

    expect(calls).toEqual([]);
  });

  it("runs spawned Workers concurrently, opens a PR per success, and reports each outcome", async () => {
    const { exec } = recordingExec();
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
        exec,
        log,
      },
    );

    expect(dispatched).toEqual([2, 4]);
    expect(opened).toEqual([2]); // only the success becomes a PR
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
      exec,
      log: noopLog(),
    });

    expect(attempts).toEqual([[7, 2]]);
  });

  it("releases a failed attempt with its forensic record after Workers settle", async () => {
    const { exec, calls } = recordingExec();
    const dispatch: DispatchWorker = async () =>
      outcome(7, { attempt: 2, exitCode: null, failure: "stall", ok: false });

    await act([{ type: "spawn", ticket: 7, attempt: 2 }], {
      dispatch,
      openPr: recordingOpenPr().openPr,
      dispatchConflict: noConflict,
      exec,
      log: noopLog(),
    });

    const record: AttemptFailure = {
      attempt: 2,
      reason: "stall",
      model: "sonnet",
      branch: "border-collie/ticket-7",
      transcript: ".border-collie/transcripts/ticket-7.jsonl",
    };
    expect(calls).toEqual([
      ["gh", "issue", "edit", "7", "--remove-assignee", "@me"],
      [
        "gh",
        "issue",
        "comment",
        "7",
        "--body",
        expect.stringContaining(attemptMarker(record)),
      ],
    ]);
  });

  it("performs no tracker writes for a successful attempt", async () => {
    const { exec, calls } = recordingExec();
    const dispatch: DispatchWorker = async () => outcome(7);

    await act([{ type: "spawn", ticket: 7, attempt: 1 }], {
      dispatch,
      openPr: recordingOpenPr().openPr,
      dispatchConflict: noConflict,
      exec,
      log: noopLog(),
    });

    expect(calls).toEqual([]);
  });

  it("assigns worker-outcome levels per the level table: success and a retried Ticket failure are info, an infrastructure failure is warn", async () => {
    const cases: { outcome: WorkerOutcome; level: "info" | "warn" }[] = [
      { outcome: outcome(2), level: "info" },
      {
        outcome: outcome(4, {
          exitCode: 1,
          newCommits: 0,
          failure: "nonzero-exit",
          ok: false,
        }),
        level: "info",
      },
      {
        outcome: outcome(6, {
          exitCode: 1,
          newCommits: 0,
          infra: "network",
          ok: false,
        }),
        level: "warn",
      },
    ];

    for (const { outcome: scriptedOutcome, level } of cases) {
      const { exec } = recordingExec();
      const { log, events } = recordingLog();
      const dispatch: DispatchWorker = async () => scriptedOutcome;

      await act(
        [{ type: "spawn", ticket: scriptedOutcome.ticket, attempt: 1 }],
        {
          dispatch,
          openPr: recordingOpenPr().openPr,
          dispatchConflict: noConflict,
          exec,
          log,
        },
      );

      const workerOutcome = events.find((e) => e.kind === "worker-outcome");
      expect(workerOutcome?.level).toBe(level);
    }
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
      exec,
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

  it("flags a cost overrun on a finished attempt while still opening its PR, logged at warn", async () => {
    const { exec, calls } = recordingExec();
    const { openPr, opened } = recordingOpenPr();
    const { log, events } = recordingLog();
    const dispatch: DispatchWorker = async () =>
      outcome(7, { costUsd: 25.5, turns: 80, costOverrun: true });

    await act([{ type: "spawn", ticket: 7, attempt: 1 }], {
      dispatch,
      openPr,
      dispatchConflict: noConflict,
      exec,
      log,
    });

    expect(opened).toEqual([7]); // the work is kept — discarding refunds nothing
    expect(calls).toEqual([]); // no tracker writes: not a failure
    const costOverrun = events.find((e) => e.kind === "cost-overrun");
    expect(costOverrun?.level).toBe("warn");
    expect(costOverrun?.msg).toBe(
      "cost overrun: attempt 1 spent $25.50 — the ticket may be cut too big for one Worker",
    );
    // Bound by the Worker's sub-logger, not repeated per call site.
    expect(costOverrun).toMatchObject({ ticket: 7, attempt: 1 });
  });

  it("voids an infrastructure-classified attempt: comment only, claim held, counted in the report, logged at warn", async () => {
    const { exec, calls } = recordingExec();
    const { log, events } = recordingLog();
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
      exec,
      log,
    });

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
    const voided = events.find((e) => e.kind === "attempt-voided");
    expect(voided?.level).toBe("warn");
    expect(voided?.msg).toBe("voided attempt 1 (usage-limit); claim held");
    // Bound by the Worker's sub-logger, not repeated per call site.
    expect(voided).toMatchObject({ ticket: 7, attempt: 1 });
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
        exec,
        log,
      },
    );

    // Both attempts voided, none released: no assignee ever removed.
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
      exec,
      log: noopLog(),
    });

    expect(report).toEqual({ infraFailures: 0 });
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
          exec,
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
        exec,
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

describe("act: PR upkeep", () => {
  it("mechanically updates a behind PR's branch via the tracker", async () => {
    const { exec, calls } = recordingExec();
    const { log, events } = recordingLog();

    await act([{ type: "update-branch", pr: 30, ticket: 3 }], {
      dispatch: noDispatch,
      openPr: recordingOpenPr().openPr,
      dispatchConflict: noConflict,
      exec,
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
      exec,
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

  it("pushes the branch when the conflict Worker resolves the merge", async () => {
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
        exec,
        log,
      },
    );

    expect(calls).toEqual([
      ["git", "push", "--force", "origin", "border-collie/ticket-3-attempt-1"],
    ]);
    expect(events.map((e) => e.kind)).toEqual([
      "conflict-dispatch",
      "conflict-outcome",
      "conflict-pushed",
    ]);
    expect(events.every((e) => e.level === "info")).toBe(true);
    expect(msgs(events)).toEqual([
      "dispatched conflict Worker (ticket #3)",
      "Conflict Worker resolved the conflicts on border-collie/ticket-3-attempt-1 (transcript: .border-collie/transcripts/pr-30-conflict.jsonl)",
      "pushed the resolved rebase",
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
        exec,
        log,
      },
    );

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
        exec,
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
          exec,
          log,
        },
      ),
    ).rejects.toThrow("claude ENOENT");

    expect(msgs(events)).toContain(
      "Worker succeeded: 2 new commits on border-collie/ticket-2 (transcript: .border-collie/transcripts/ticket-2.jsonl)",
    );
  });
});
