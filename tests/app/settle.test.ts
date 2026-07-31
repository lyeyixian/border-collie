import { describe, expect, it } from "vitest";
import type { Exec } from "../../src/adapters/tracker.js";
import { settleAttempt } from "../../src/app/settle.js";
import type { Log, LogBindings, LogEvent } from "../../src/core/log.js";
import {
  type AttemptFailure,
  attemptMarker,
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
 * Records emitted events, merging the sub-logger's bindings onto every event
 * it forwards — exactly what a real sink sees, mirroring the Worker
 * sub-logger `settleAttempt` is always called with.
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
  return { log: make({ ticket: 7, attempt: 1 }), events };
}

function msgs(events: LogEvent[]): string[] {
  return events.map((e) => e.msg);
}

function outcome(overrides: Partial<WorkerOutcome> = {}): WorkerOutcome {
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
    costOverrun: false,
    ok: true,
    ...overrides,
  };
}

describe("settleAttempt", () => {
  it("narrates a success and its PR, performing no tracker write", async () => {
    const { exec, calls } = recordingExec();
    const { log, events } = recordingLog();

    await settleAttempt(
      outcome({ newCommits: 3 }),
      "https://github.com/o/r/pull/70",
      log,
      exec,
    );

    expect(calls).toEqual([]);
    expect(events.map((e) => e.kind)).toEqual(["worker-outcome", "pr-opened"]);
    expect(events.every((e) => e.level === "info")).toBe(true);
    expect(msgs(events)).toEqual([
      "Worker succeeded: 3 new commits on border-collie/ticket-7 (transcript: .border-collie/transcripts/ticket-7.jsonl)",
      "opened draft PR: https://github.com/o/r/pull/70",
    ]);
    // Bound by the caller's sub-logger, not repeated per call site.
    expect(
      events.every(
        (e) =>
          (e as { ticket?: number }).ticket === 7 &&
          (e as { attempt?: number }).attempt === 1,
      ),
    ).toBe(true);
  });

  it("narrates a success with no PR logged when none was opened", async () => {
    const { log, events } = recordingLog();

    await settleAttempt(outcome(), undefined, log, recordingExec().exec);

    expect(events.map((e) => e.kind)).toEqual(["worker-outcome"]);
  });

  it("releases a failed attempt with its forensic record, logged at info", async () => {
    const { exec, calls } = recordingExec();
    const { log, events } = recordingLog();

    await settleAttempt(
      outcome({
        attempt: 2,
        exitCode: null,
        newCommits: 0,
        failure: "stall",
        ok: false,
      }),
      undefined,
      log,
      exec,
    );

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
    expect(events.map((e) => e.kind)).toEqual([
      "worker-outcome",
      "attempt-released",
    ]);
    expect(events.map((e) => e.level)).toEqual(["info", "info"]);
    expect(msgs(events)).toEqual([
      "Worker failed attempt 2 (stall): exit null, 0 new commits on border-collie/ticket-7 (transcript: .border-collie/transcripts/ticket-7.jsonl)",
      "released with the attempt record (failed attempt 2)",
    ]);
  });

  it("voids an infrastructure-classified attempt: comment only, claim held, logged at warn", async () => {
    const { exec, calls } = recordingExec();
    const { log, events } = recordingLog();

    await settleAttempt(
      outcome({ exitCode: 1, newCommits: 0, infra: "usage-limit", ok: false }),
      undefined,
      log,
      exec,
    );

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
    expect(events.map((e) => e.kind)).toEqual([
      "worker-outcome",
      "attempt-voided",
    ]);
    expect(events.map((e) => e.level)).toEqual(["warn", "warn"]);
    expect(msgs(events)).toEqual([
      "Worker hit an infrastructure failure (usage-limit): attempt 1 voided, exit 1 on border-collie/ticket-7 (transcript: .border-collie/transcripts/ticket-7.jsonl)",
      "voided attempt 1 (usage-limit); claim held",
    ]);
  });

  it("flags a cost overrun on a finished attempt while performing no tracker write, logged at warn", async () => {
    const { exec, calls } = recordingExec();
    const { log, events } = recordingLog();

    await settleAttempt(
      outcome({ costUsd: 25.5, turns: 80, costOverrun: true }),
      "https://github.com/o/r/pull/70",
      log,
      exec,
    );

    expect(calls).toEqual([]); // no tracker writes: not a failure
    expect(events.map((e) => e.kind)).toEqual([
      "worker-outcome",
      "pr-opened",
      "cost-overrun",
    ]);
    const costOverrun = events.find((e) => e.kind === "cost-overrun");
    expect(costOverrun?.level).toBe("warn");
    expect(costOverrun?.msg).toBe(
      "cost overrun: attempt 1 spent $25.50 — the ticket may be cut too big for one Worker",
    );
  });
});
