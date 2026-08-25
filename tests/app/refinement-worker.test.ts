import { describe, expect, it } from "vitest";
import type { Exec } from "../../src/adapters/tracker.js";
import type { RefinementOutcome } from "../../src/adapters/worker.js";
import type { SyncDispatchRefinementWorker } from "../../src/app/act.js";
import { runRefinementWorker } from "../../src/app/refinement-worker.js";
import type { Log, LogBindings, LogEvent } from "../../src/core/log.js";

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
  return { log: make({ pr: 30 }), events };
}

function msgs(events: LogEvent[]): string[] {
  return events.map((e) => e.msg);
}

function refinementOutcome(
  overrides: Partial<RefinementOutcome> = {},
): RefinementOutcome {
  return {
    pr: 30,
    ticket: 3,
    headRef: "border-collie/ticket-3-attempt-1",
    transcript: ".border-collie/transcripts/pr-30-refinement-round-1.jsonl",
    exitCode: 0,
    newCommits: 1,
    ...overrides,
  };
}

describe("runRefinementWorker", () => {
  it("dispatches, then pushes the branch when the round commits a fix", async () => {
    const { exec, calls } = recordingExec();
    const { log, events } = recordingLog();
    const dispatched: [number, number, string, number][] = [];
    const dispatch: SyncDispatchRefinementWorker = async (
      pr,
      ticket,
      headRef,
      round,
    ) => {
      dispatched.push([pr, ticket, headRef, round]);
      return refinementOutcome({ newCommits: 2 });
    };

    const result = await runRefinementWorker(
      30,
      3,
      "border-collie/ticket-3-attempt-1",
      1,
      { dispatch, exec, log },
    );

    expect(dispatched).toEqual([
      [30, 3, "border-collie/ticket-3-attempt-1", 1],
    ]);
    expect(result.newCommits).toBe(2);
    expect(calls).toEqual([
      ["git", "push", "--force", "origin", "border-collie/ticket-3-attempt-1"],
    ]);
    expect(events.map((e) => e.kind)).toEqual([
      "refinement-outcome",
      "refinement-pushed",
    ]);
    expect(msgs(events)).toEqual([
      "Refinement Worker finished: 2 new commits on border-collie/ticket-3-attempt-1 (transcript: .border-collie/transcripts/pr-30-refinement-round-1.jsonl)",
      "pushed the Refinement fix",
    ]);
  });

  it("does not push when the round committed nothing", async () => {
    const { exec, calls } = recordingExec();
    const { log, events } = recordingLog();
    const dispatch: SyncDispatchRefinementWorker = async () =>
      refinementOutcome({ newCommits: 0 });

    const result = await runRefinementWorker(
      30,
      3,
      "border-collie/ticket-3-attempt-1",
      1,
      { dispatch, exec, log },
    );

    expect(result.newCommits).toBe(0);
    expect(calls).toEqual([]);
    expect(events.map((e) => e.kind)).toEqual(["refinement-outcome"]);
  });
});
