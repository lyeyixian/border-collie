import { describe, expect, it } from "vitest";
import type { Exec } from "../../src/adapters/tracker.js";
import type { DispatchWorker, OpenPr } from "../../src/app/act.js";
import { runWorkerAttempt } from "../../src/app/worker.js";
import type { Log, LogBindings, LogEvent } from "../../src/core/log.js";
import {
  CLAIM_LABEL,
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

/** Merges the caller's sub-logger bindings onto every event, mirroring a real sink. */
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
    durationMs: undefined,
    subtype: undefined,
    costOverrun: false,
    ok: true,
    ...overrides,
  };
}

describe("runWorkerAttempt", () => {
  it("dispatches, opens a PR for a success, and settles through the shared unit", async () => {
    const { exec, calls } = recordingExec();
    const { log, events } = recordingLog();
    const dispatched: [number, number][] = [];
    const dispatch: DispatchWorker = async (ticket, attempt) => {
      dispatched.push([ticket, attempt]);
      return outcome({ newCommits: 3 });
    };
    const opened: number[] = [];
    const openPr: OpenPr = async (o) => {
      opened.push(o.ticket);
      return "https://github.com/o/r/pull/70";
    };

    const result = await runWorkerAttempt(7, 1, {
      dispatch,
      openPr,
      exec,
      log,
    });

    expect(dispatched).toEqual([[7, 1]]);
    expect(opened).toEqual([7]);
    expect(result.ok).toBe(true);
    expect(calls).toEqual([]); // a success writes nothing through the tracker
    expect(events.map((e) => e.kind)).toEqual(["worker-outcome", "pr-opened"]);
    expect(msgs(events)).toEqual([
      "Worker succeeded: 3 new commits on border-collie/ticket-7 (transcript: .border-collie/transcripts/ticket-7.jsonl)",
      "opened draft PR: https://github.com/o/r/pull/70",
    ]);
  });

  it("skips PR opening and releases a Ticket failure with its forensic record", async () => {
    const { exec, calls } = recordingExec();
    const { log, events } = recordingLog();
    let openPrCalled = false;
    const dispatch: DispatchWorker = async () =>
      outcome({
        exitCode: 1,
        newCommits: 0,
        failure: "nonzero-exit",
        ok: false,
      });
    const openPr: OpenPr = async () => {
      openPrCalled = true;
      return "unreachable";
    };

    const result = await runWorkerAttempt(7, 1, {
      dispatch,
      openPr,
      exec,
      log,
    });

    expect(openPrCalled).toBe(false);
    expect(result.ok).toBe(false);
    expect(calls).toEqual([
      ["gh", "issue", "edit", "7", "--remove-label", CLAIM_LABEL],
      expect.arrayContaining(["gh", "issue", "comment", "7"]),
    ]);
    expect(events.map((e) => e.kind)).toEqual([
      "worker-outcome",
      "attempt-released",
    ]);
  });

  it("skips PR opening and voids an Infrastructure failure, holding the Claim", async () => {
    const { exec, calls } = recordingExec();
    const { log, events } = recordingLog();
    let openPrCalled = false;
    const dispatch: DispatchWorker = async () =>
      outcome({ exitCode: 1, newCommits: 0, infra: "usage-limit", ok: false });
    const openPr: OpenPr = async () => {
      openPrCalled = true;
      return "unreachable";
    };

    const result = await runWorkerAttempt(7, 1, {
      dispatch,
      openPr,
      exec,
      log,
    });

    expect(openPrCalled).toBe(false);
    expect(result.ok).toBe(false);
    // A void is a comment only: no claim-label removal, the claim stays held.
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
  });

  it("dispatches with the given ticket and attempt", async () => {
    const { exec } = recordingExec();
    const { log } = recordingLog();
    const attempts: [number, number][] = [];
    const dispatch: DispatchWorker = async (ticket, attempt) => {
      attempts.push([ticket, attempt]);
      return outcome({ ticket, attempt });
    };
    const openPr: OpenPr = async () => "https://github.com/o/r/pull/70";

    await runWorkerAttempt(9, 2, { dispatch, openPr, exec, log });

    expect(attempts).toEqual([[9, 2]]);
  });

  it("still settles the Attempt when PR opening fails, then rethrows, logging the failure at error", async () => {
    const { exec } = recordingExec();
    const { log, events } = recordingLog();
    const dispatch: DispatchWorker = async () => outcome();
    const openPr: OpenPr = async () => {
      throw new Error("gh pr create exploded");
    };

    await expect(
      runWorkerAttempt(7, 1, { dispatch, openPr, exec, log }),
    ).rejects.toThrow("gh pr create exploded");

    expect(msgs(events)).toContain(
      "Worker succeeded: 2 new commits on border-collie/ticket-7 (transcript: .border-collie/transcripts/ticket-7.jsonl)",
    );
    const prOpenFailed = events.find((e) => e.kind === "pr-open-failed");
    expect(prOpenFailed?.level).toBe("error");
    expect(prOpenFailed?.msg).toBe(
      "PR opening failed after a successful Attempt: gh pr create exploded",
    );
  });
});
