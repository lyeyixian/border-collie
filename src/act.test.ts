import { describe, expect, it } from "vitest";
import {
  act,
  type DispatchConflictWorker,
  type DispatchWorker,
  type OpenPr,
} from "./act.js";
import type { Exec } from "./tracker.js";
import {
  type AttemptFailure,
  attemptMarker,
  CLAIM_MARKER,
  CONFLICT_UNRESOLVED_MARKER,
  RELEASE_MARKER,
  VOID_MARKER,
} from "./types.js";
import type { ConflictOutcome, WorkerOutcome } from "./worker.js";

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
    const lines: string[] = [];

    await act(
      [
        { type: "release", ticket: 4, assignees: ["operator"] },
        { type: "claim", ticket: 9 },
      ],
      noDispatch,
      openPr,
      noConflict,
      exec,
      (line) => lines.push(line),
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
    expect(lines).toEqual(["released #4 (orphaned claim)", "claimed #9"]);
  });

  it("closes a merged-but-open ticket via the tracker, linking the PR", async () => {
    const { exec, calls } = recordingExec();
    const { openPr } = recordingOpenPr();
    const lines: string[] = [];

    await act(
      [{ type: "close", ticket: 6, prUrl: "https://github.com/o/r/pull/60" }],
      noDispatch,
      openPr,
      noConflict,
      exec,
      (line) => lines.push(line),
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
    expect(lines).toEqual([
      "closed #6 (merged: https://github.com/o/r/pull/60)",
    ]);
  });

  it("performs no writes for an empty plan", async () => {
    const { exec, calls } = recordingExec();
    const { openPr } = recordingOpenPr();

    await act([], noDispatch, openPr, noConflict, exec, () => {});

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
      dispatch,
      openPr,
      noConflict,
      exec,
      (line) => lines.push(line),
    );

    expect(dispatched).toEqual([2, 4]);
    expect(opened).toEqual([2]); // only the success becomes a PR
    expect(lines).toEqual([
      "claimed #2",
      "spawned Worker for #2 (attempt 1)",
      "claimed #4",
      "spawned Worker for #4 (attempt 1)",
      "Worker for #2 succeeded: 3 new commits on border-collie/ticket-2 (transcript: .border-collie/transcripts/ticket-2.jsonl)",
      "opened draft PR for #2: https://github.com/o/r/pull/20",
      "Worker for #4 failed attempt 1 (nonzero-exit): exit 1, 0 new commits on border-collie/ticket-4 (transcript: .border-collie/transcripts/ticket-4.jsonl)",
      "released #4 with the attempt record (failed attempt 1)",
    ]);
  });

  it("dispatches with the planned attempt number (the retry ladder rung)", async () => {
    const { exec } = recordingExec();
    const attempts: [number, number][] = [];
    const dispatch: DispatchWorker = async (ticket, attempt) => {
      attempts.push([ticket, attempt]);
      return outcome(ticket);
    };

    await act(
      [{ type: "spawn", ticket: 7, attempt: 2 }],
      dispatch,
      recordingOpenPr().openPr,
      noConflict,
      exec,
      () => {},
    );

    expect(attempts).toEqual([[7, 2]]);
  });

  it("releases a failed attempt with its forensic record after Workers settle", async () => {
    const { exec, calls } = recordingExec();
    const dispatch: DispatchWorker = async () =>
      outcome(7, { attempt: 2, exitCode: null, failure: "stall", ok: false });

    await act(
      [{ type: "spawn", ticket: 7, attempt: 2 }],
      dispatch,
      recordingOpenPr().openPr,
      noConflict,
      exec,
      () => {},
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
  });

  it("performs no tracker writes for a successful attempt", async () => {
    const { exec, calls } = recordingExec();
    const dispatch: DispatchWorker = async () => outcome(7);

    await act(
      [{ type: "spawn", ticket: 7, attempt: 1 }],
      dispatch,
      recordingOpenPr().openPr,
      noConflict,
      exec,
      () => {},
    );

    expect(calls).toEqual([]);
  });

  it("escalates: forensic comment, then the ready-for-agent → ready-for-human label swap", async () => {
    const { exec, calls } = recordingExec();
    const lines: string[] = [];
    const failures: AttemptFailure[] = [
      {
        attempt: 1,
        reason: "timeout",
        model: "sonnet",
        branch: "border-collie/ticket-5",
        transcript: ".border-collie/transcripts/ticket-5.jsonl",
      },
    ];

    await act(
      [{ type: "escalate", ticket: 5, failures }],
      noDispatch,
      recordingOpenPr().openPr,
      noConflict,
      exec,
      (line) => lines.push(line),
    );

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
    expect(lines).toEqual([
      "escalated #5 to ready-for-human (attempts exhausted)",
    ]);
  });

  it("flags a cost overrun on a finished attempt while still opening its PR", async () => {
    const { exec, calls } = recordingExec();
    const { openPr, opened } = recordingOpenPr();
    const lines: string[] = [];
    const dispatch: DispatchWorker = async () =>
      outcome(7, { costUsd: 25.5, turns: 80, costOverrun: true });

    await act(
      [{ type: "spawn", ticket: 7, attempt: 1 }],
      dispatch,
      openPr,
      noConflict,
      exec,
      (line) => lines.push(line),
    );

    expect(opened).toEqual([7]); // the work is kept — discarding refunds nothing
    expect(calls).toEqual([]); // no tracker writes: not a failure
    expect(lines).toContain(
      "cost overrun on #7: attempt 1 spent $25.50 — the ticket may be cut too big for one Worker",
    );
  });

  it("voids an infrastructure-classified attempt: comment only, claim held, counted in the report", async () => {
    const { exec, calls } = recordingExec();
    const lines: string[] = [];
    const dispatch: DispatchWorker = async () =>
      outcome(7, {
        exitCode: 1,
        newCommits: 0,
        infra: "usage-limit",
        ok: false,
      });

    const report = await act(
      [{ type: "spawn", ticket: 7, attempt: 1 }],
      dispatch,
      recordingOpenPr().openPr,
      noConflict,
      exec,
      (line) => lines.push(line),
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
    expect(report).toEqual({ infraFailures: 1 });
    expect(lines).toContain("voided attempt 1 of #7 (usage-limit); claim held");
  });

  it("reclassifies several Workers failing the same way in one Tick as correlated infrastructure", async () => {
    const { exec, calls } = recordingExec();
    const lines: string[] = [];
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
      dispatch,
      recordingOpenPr().openPr,
      noConflict,
      exec,
      (line) => lines.push(line),
    );

    // Both attempts voided, none released: no assignee ever removed.
    expect(calls.map((c) => c.slice(0, 3))).toEqual([
      ["gh", "issue", "comment"],
      ["gh", "issue", "comment"],
    ]);
    expect(calls.every((c) => c[5]?.includes(VOID_MARKER))).toBe(true);
    expect(report).toEqual({ infraFailures: 2 });
    expect(lines.join("\n")).toContain("correlated");
  });

  it("reports zero infrastructure failures for a clean Tick", async () => {
    const { exec } = recordingExec();
    const dispatch: DispatchWorker = async (ticket) => outcome(ticket);

    const report = await act(
      [{ type: "spawn", ticket: 2, attempt: 1 }],
      dispatch,
      recordingOpenPr().openPr,
      noConflict,
      exec,
      () => {},
    );

    expect(report).toEqual({ infraFailures: 0 });
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
          { type: "spawn", ticket: 2, attempt: 1 },
          { type: "spawn", ticket: 4, attempt: 1 },
        ],
        dispatch,
        openPr,
        noConflict,
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
      act(
        [{ type: "spawn", ticket: 2, attempt: 1 }],
        dispatch,
        openPr,
        noConflict,
        exec,
        (line) => lines.push(line),
      ),
    ).rejects.toThrow("gh pr create exploded");

    expect(lines).toContain(
      "Worker for #2 succeeded: 2 new commits on border-collie/ticket-2 (transcript: .border-collie/transcripts/ticket-2.jsonl)",
    );
  });
});

describe("act: PR upkeep", () => {
  it("mechanically updates a behind PR's branch via the tracker", async () => {
    const { exec, calls } = recordingExec();
    const lines: string[] = [];

    await act(
      [{ type: "update-branch", pr: 30, ticket: 3 }],
      noDispatch,
      recordingOpenPr().openPr,
      noConflict,
      exec,
      (line) => lines.push(line),
    );

    expect(calls).toEqual([["gh", "pr", "update-branch", "30", "--rebase"]]);
    expect(lines).toEqual([
      "updated PR #30 branch (mechanical rebase onto the base)",
    ]);
  });

  it("flips a green draft PR to ready for review via the tracker", async () => {
    const { exec, calls } = recordingExec();
    const lines: string[] = [];

    await act(
      [{ type: "mark-ready", pr: 30, ticket: 3 }],
      noDispatch,
      recordingOpenPr().openPr,
      noConflict,
      exec,
      (line) => lines.push(line),
    );

    expect(calls).toEqual([["gh", "pr", "ready", "30"]]);
    expect(lines).toEqual(["marked PR #30 ready for review"]);
  });

  it("pushes the branch when the conflict Worker resolves the merge", async () => {
    const { exec, calls } = recordingExec();
    const lines: string[] = [];
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
      noDispatch,
      recordingOpenPr().openPr,
      dispatchConflict,
      exec,
      (line) => lines.push(line),
    );

    expect(calls).toEqual([
      ["git", "push", "--force", "origin", "border-collie/ticket-3-attempt-1"],
    ]);
    expect(lines).toEqual([
      "dispatched conflict Worker for PR #30 (ticket #3)",
      "Conflict Worker for PR #30 resolved the conflicts on border-collie/ticket-3-attempt-1 (transcript: .border-collie/transcripts/pr-30-conflict.jsonl)",
      "pushed the resolved rebase for PR #30",
    ]);
  });

  it("asks for human resolution when the conflict Worker gives up (no push)", async () => {
    const { exec, calls } = recordingExec();
    const lines: string[] = [];
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
      noDispatch,
      recordingOpenPr().openPr,
      dispatchConflict,
      exec,
      (line) => lines.push(line),
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
    expect(lines).toEqual([
      "dispatched conflict Worker for PR #30 (ticket #3)",
      "Conflict Worker for PR #30 could not resolve the conflicts (exit 1) on border-collie/ticket-3-attempt-1 (transcript: .border-collie/transcripts/pr-30-conflict.jsonl)",
      "asked for human resolution on PR #30",
    ]);
  });

  it("runs conflict Workers concurrently with dispatch Workers and reports both", async () => {
    const { exec } = recordingExec();
    const lines: string[] = [];
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
      dispatch,
      recordingOpenPr().openPr,
      dispatchConflict,
      exec,
      (line) => lines.push(line),
    );

    expect(inFlight.sort()).toEqual(["conflict-40", "worker-2"]);
    expect(lines).toContain("pushed the resolved rebase for PR #40");
    expect(lines).toContain(
      "Worker for #2 succeeded: 2 new commits on border-collie/ticket-2 (transcript: .border-collie/transcripts/ticket-2.jsonl)",
    );
  });

  it("reports settled Workers before rethrowing a conflict Worker's infrastructure failure", async () => {
    const { exec } = recordingExec();
    const lines: string[] = [];
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
        dispatch,
        recordingOpenPr().openPr,
        dispatchConflict,
        exec,
        (line) => lines.push(line),
      ),
    ).rejects.toThrow("claude ENOENT");

    expect(lines).toContain(
      "Worker for #2 succeeded: 2 new commits on border-collie/ticket-2 (transcript: .border-collie/transcripts/ticket-2.jsonl)",
    );
  });
});
