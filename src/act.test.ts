import { describe, expect, it } from "vitest";
import { act, type DispatchWorker, type OpenPr } from "./act.js";
import type { Exec } from "./tracker.js";
import { CLAIM_MARKER, RELEASE_MARKER } from "./types.js";
import type { WorkerOutcome } from "./worker.js";

function recordingExec(): { exec: Exec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: Exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    return "";
  };
  return { exec, calls };
}

const noDispatch: DispatchWorker = async (ticket) => {
  throw new Error(`unexpected dispatch of #${ticket}`);
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

function outcome(ticket: number, overrides: Partial<WorkerOutcome> = {}): WorkerOutcome {
  return {
    ticket,
    branch: `border-collie/ticket-${ticket}`,
    base: "base-sha",
    transcript: `.border-collie/transcripts/ticket-${ticket}.jsonl`,
    exitCode: 0,
    newCommits: 2,
    ok: true,
    ...overrides,
  };
}

describe("act", () => {
  it("executes releases and claims in plan order via the tracker", async () => {
    const { exec, calls } = recordingExec();
    const { openPr } = recordingOpenPr();
    const lines: string[] = [];

    await act(
      [
        { type: "release", ticket: 4, assignees: ["operator"] },
        { type: "claim", ticket: 9 },
      ],
      noDispatch,
      openPr,
      exec,
      (line) => lines.push(line),
    );

    expect(calls).toEqual([
      ["gh", "issue", "edit", "4", "--remove-assignee", "operator"],
      ["gh", "issue", "comment", "4", "--body", expect.stringContaining(RELEASE_MARKER)],
      ["gh", "issue", "edit", "9", "--add-assignee", "@me"],
      ["gh", "issue", "comment", "9", "--body", expect.stringContaining(CLAIM_MARKER)],
    ]);
    expect(lines).toEqual(["released #4 (orphaned claim)", "claimed #9"]);
  });

  it("performs no writes for an empty plan", async () => {
    const { exec, calls } = recordingExec();
    const { openPr } = recordingOpenPr();

    await act([], noDispatch, openPr, exec, () => {});

    expect(calls).toEqual([]);
  });

  it("runs spawned Workers concurrently, opens a PR per success, and reports each outcome", async () => {
    const { exec } = recordingExec();
    const { openPr, opened } = recordingOpenPr();
    const lines: string[] = [];
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
        : outcome(4, { exitCode: 1, newCommits: 0, ok: false });
    };

    await act(
      [
        { type: "claim", ticket: 2 },
        { type: "spawn", ticket: 2 },
        { type: "claim", ticket: 4 },
        { type: "spawn", ticket: 4 },
      ],
      dispatch,
      openPr,
      exec,
      (line) => lines.push(line),
    );

    expect(dispatched).toEqual([2, 4]);
    expect(opened).toEqual([2]); // only the success becomes a PR
    expect(lines).toEqual([
      "claimed #2",
      "spawned Worker for #2",
      "claimed #4",
      "spawned Worker for #4",
      "Worker for #2 succeeded: 3 new commits on border-collie/ticket-2 (transcript: .border-collie/transcripts/ticket-2.jsonl)",
      "opened draft PR for #2: https://github.com/o/r/pull/20",
      "Worker for #4 failed attempt: exit 1, 0 new commits on border-collie/ticket-4 (transcript: .border-collie/transcripts/ticket-4.jsonl)",
    ]);
  });

  it("still reports finished Workers when a sibling dispatch throws, then rethrows", async () => {
    const { exec } = recordingExec();
    const { openPr } = recordingOpenPr();
    const lines: string[] = [];
    const dispatch: DispatchWorker = async (ticket) => {
      if (ticket === 4) throw new Error("git exploded");
      return outcome(ticket);
    };

    await expect(
      act(
        [
          { type: "spawn", ticket: 2 },
          { type: "spawn", ticket: 4 },
        ],
        dispatch,
        openPr,
        exec,
        (line) => lines.push(line),
      ),
    ).rejects.toThrow("git exploded");

    expect(lines).toContain(
      "Worker for #2 succeeded: 2 new commits on border-collie/ticket-2 (transcript: .border-collie/transcripts/ticket-2.jsonl)",
    );
  });

  it("still reports the Worker's outcome when PR opening fails, then rethrows", async () => {
    const { exec } = recordingExec();
    const lines: string[] = [];
    const dispatch: DispatchWorker = async (ticket) => outcome(ticket);
    const openPr: OpenPr = async () => {
      throw new Error("gh pr create exploded");
    };

    await expect(
      act([{ type: "spawn", ticket: 2 }], dispatch, openPr, exec, (line) => lines.push(line)),
    ).rejects.toThrow("gh pr create exploded");

    expect(lines).toContain(
      "Worker for #2 succeeded: 2 new commits on border-collie/ticket-2 (transcript: .border-collie/transcripts/ticket-2.jsonl)",
    );
  });
});
