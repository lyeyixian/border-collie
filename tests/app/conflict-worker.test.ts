import { describe, expect, it } from "vitest";
import type { Exec } from "../../src/adapters/tracker.js";
import type { ConflictOutcome } from "../../src/adapters/worker.js";
import type { SyncDispatchConflictWorker } from "../../src/app/act.js";
import { runConflictWorker } from "../../src/app/conflict-worker.js";
import type { Log, LogBindings, LogEvent } from "../../src/core/log.js";
import { CONFLICT_UNRESOLVED_MARKER } from "../../src/core/types.js";

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

function conflictOutcome(
  overrides: Partial<ConflictOutcome> = {},
): ConflictOutcome {
  return {
    pr: 30,
    ticket: 3,
    headRef: "border-collie/ticket-3-attempt-1",
    transcript: ".border-collie/transcripts/pr-30-conflict.jsonl",
    exitCode: 0,
    resolved: true,
    ...overrides,
  };
}

describe("runConflictWorker", () => {
  it("dispatches, then pushes the resolved rebase and converts the PR to draft", async () => {
    const { exec, calls } = recordingExec();
    const { log, events } = recordingLog();
    const dispatched: [number, number, string][] = [];
    const dispatch: SyncDispatchConflictWorker = async (
      pr,
      ticket,
      headRef,
    ) => {
      dispatched.push([pr, ticket, headRef]);
      return conflictOutcome({ resolved: true });
    };

    const result = await runConflictWorker(
      30,
      3,
      "border-collie/ticket-3-attempt-1",
      {
        dispatch,
        exec,
        log,
      },
    );

    expect(dispatched).toEqual([[30, 3, "border-collie/ticket-3-attempt-1"]]);
    expect(result.resolved).toBe(true);
    expect(calls).toEqual([
      ["git", "push", "--force", "origin", "border-collie/ticket-3-attempt-1"],
      ["gh", "pr", "ready", "30", "--undo"],
    ]);
    expect(events.map((e) => e.kind)).toEqual([
      "conflict-outcome",
      "conflict-pushed",
      "conflict-drafted",
    ]);
    expect(msgs(events)).toEqual([
      "Conflict Worker resolved the conflicts on border-collie/ticket-3-attempt-1 (transcript: .border-collie/transcripts/pr-30-conflict.jsonl)",
      "pushed the resolved rebase",
      "converted the PR to draft for a re-read before it can merge",
    ]);
  });

  it("asks for human resolution when the Worker gives up, without pushing", async () => {
    const { exec, calls } = recordingExec();
    const { log, events } = recordingLog();
    const dispatch: SyncDispatchConflictWorker = async () =>
      conflictOutcome({ exitCode: 1, resolved: false });

    const result = await runConflictWorker(
      30,
      3,
      "border-collie/ticket-3-attempt-1",
      {
        dispatch,
        exec,
        log,
      },
    );

    expect(result.resolved).toBe(false);
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
      "conflict-outcome",
      "conflict-unresolved",
    ]);
  });
});
