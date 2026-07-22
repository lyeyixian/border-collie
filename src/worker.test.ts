import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Exec } from "./tracker.js";
import {
  branchCommitSubjects,
  dispatchWorker,
  probeEnvironment,
  pushAgentBranch,
  realSpawnWorkerProcess,
  workerPrompt,
  type SpawnWorkerProcess,
  type WorkerConfig,
  type WorkerProcessExit,
  type WorkerProcessRequest,
} from "./worker.js";

const WORKTREE = ".border-collie/worktrees/ticket-4";
const BRANCH = "border-collie/ticket-4-attempt-1";
const TRANSCRIPT = ".border-collie/transcripts/ticket-4-attempt-1.jsonl";

const CONFIG: WorkerConfig = {
  model: "sonnet",
  attempt: 1,
  timeoutMs: 60_000,
  stallMs: 30_000,
  maxTurns: 200,
  maxCostUsd: 20,
};

/**
 * Fake the git side of the subprocess seam: reads are answered from fixtures,
 * writes recorded. `removeThrows` simulates the (normal) case of no stale
 * worktree to remove.
 */
function fakeExec(opts: { newCommits?: string; removeThrows?: boolean } = {}): {
  exec: Exec;
  calls: string[][];
} {
  const calls: string[][] = [];
  const exec: Exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args[1] === "remove" && opts.removeThrows) {
      throw new Error("fatal: not a working tree");
    }
    if (args[0] === "rev-parse") return "base-sha\n";
    if (args[0] === "rev-list") return `${opts.newCommits ?? "0"}\n`;
    return "";
  };
  return { exec, calls };
}

function fakeSpawn(
  result: number | null | Error,
  endedBy: WorkerProcessExit["endedBy"] = "exit",
  tails: { stdoutTail?: string; stderrTail?: string } = {},
): {
  spawn: SpawnWorkerProcess;
  requests: WorkerProcessRequest[];
} {
  const requests: WorkerProcessRequest[] = [];
  const spawn: SpawnWorkerProcess = async (request) => {
    requests.push(request);
    if (result instanceof Error) throw result;
    return {
      exitCode: result,
      endedBy,
      stdoutTail: tails.stdoutTail ?? "",
      stderrTail: tails.stderrTail ?? "",
    };
  };
  return { spawn, requests };
}

describe("workerPrompt", () => {
  it("contains only the ticket reference, the /implement invocation, and the PR-description instruction", () => {
    expect(workerPrompt(4)).toBe(
      '/implement issue #4\n\nWhen the work is committed, make your final message a pull request description for this branch. It is used verbatim as the PR body, so it must contain nothing but the description itself — no preamble like "Here\'s the PR description:", no status narration, no text before or after it.',
    );
  });
});

describe("dispatchWorker", () => {
  it("creates the worktree on an agent branch, runs claude headless in it, and cleans up (branch retained)", async () => {
    const { exec, calls } = fakeExec({ newCommits: "3" });
    const { spawn, requests } = fakeSpawn(0);

    await dispatchWorker(4, CONFIG, exec, spawn);

    expect(calls).toEqual([
      ["git", "worktree", "remove", "--force", WORKTREE],
      ["git", "worktree", "prune"],
      ["git", "fetch", "origin"],
      ["git", "worktree", "add", WORKTREE, "-B", BRANCH, "origin/HEAD"],
      ["git", "rev-parse", BRANCH],
      ["git", "rev-list", "--count", `base-sha..${BRANCH}`],
      ["git", "worktree", "remove", "--force", WORKTREE],
    ]);
    expect(requests).toEqual([
      {
        cmd: "claude",
        args: [
          "-p",
          workerPrompt(4),
          "--model",
          "sonnet",
          "--max-turns",
          "200",
          "--output-format",
          "stream-json",
          "--verbose",
          "--dangerously-skip-permissions",
        ],
        cwd: WORKTREE,
        transcriptPath: TRANSCRIPT,
        stderrPath: ".border-collie/transcripts/ticket-4-attempt-1.stderr.log",
        timeoutMs: 60_000,
        stallMs: 30_000,
      },
    ]);
  });

  it("serializes git phases across concurrent dispatches (repo-level locks), keeping Workers concurrent", async () => {
    const calls: string[][] = [];
    // Every git call yields first, giving the sibling dispatch a chance to
    // interleave — only the lock keeps each setup block contiguous.
    const exec: Exec = async (cmd, args) => {
      await new Promise((resolve) => setImmediate(resolve));
      calls.push([cmd, ...args]);
      if (args[0] === "rev-parse") return "base-sha\n";
      if (args[0] === "rev-list") return "1\n";
      return "";
    };
    const { spawn } = fakeSpawn(0);

    const outcomes = await Promise.all([
      dispatchWorker(1, CONFIG, exec, spawn),
      dispatchWorker(2, CONFIG, exec, spawn),
    ]);

    const setupBlock = (ticket: number) => [
      ["git", "worktree", "remove", "--force", `.border-collie/worktrees/ticket-${ticket}`],
      ["git", "worktree", "prune"],
      ["git", "fetch", "origin"],
      [
        "git",
        "worktree",
        "add",
        `.border-collie/worktrees/ticket-${ticket}`,
        "-B",
        `border-collie/ticket-${ticket}-attempt-1`,
        "origin/HEAD",
      ],
      ["git", "rev-parse", `border-collie/ticket-${ticket}-attempt-1`],
    ];
    expect(calls.slice(0, 10)).toEqual([...setupBlock(1), ...setupBlock(2)]);
    expect(outcomes.map((o) => o.ok)).toEqual([true, true]);
  });

  it("succeeds when the process exits cleanly and new commits exist on the branch", async () => {
    const { exec } = fakeExec({ newCommits: "3" });
    const { spawn } = fakeSpawn(0);

    const outcome = await dispatchWorker(4, CONFIG, exec, spawn);

    expect(outcome).toEqual({
      ticket: 4,
      attempt: 1,
      branch: BRANCH,
      base: "base-sha",
      transcript: TRANSCRIPT,
      model: "sonnet",
      exitCode: 0,
      newCommits: 3,
      failure: undefined,
      infra: undefined,
      costUsd: undefined,
      turns: undefined,
      costOverrun: false,
      ok: true,
    });
  });

  it("fails the attempt on a clean exit with no new commits", async () => {
    const { exec } = fakeExec({ newCommits: "0" });
    const { spawn } = fakeSpawn(0);

    const outcome = await dispatchWorker(4, CONFIG, exec, spawn);

    expect(outcome).toMatchObject({ ok: false, exitCode: 0, newCommits: 0, failure: "no-commits" });
  });

  it("fails the attempt on a non-zero exit even when commits exist", async () => {
    const { exec } = fakeExec({ newCommits: "2" });
    const { spawn } = fakeSpawn(1);

    const outcome = await dispatchWorker(4, CONFIG, exec, spawn);

    expect(outcome).toMatchObject({ ok: false, exitCode: 1, newCommits: 2, failure: "nonzero-exit" });
  });

  it("fails the attempt as a timeout when the process was killed at the wall clock, even with commits", async () => {
    const { exec } = fakeExec({ newCommits: "2" });
    const { spawn } = fakeSpawn(null, "timeout");

    const outcome = await dispatchWorker(4, CONFIG, exec, spawn);

    expect(outcome).toMatchObject({ ok: false, newCommits: 2, failure: "timeout" });
  });

  it("fails the attempt as a stall when the process went quiet past the stall window", async () => {
    const { exec } = fakeExec({ newCommits: "0" });
    const { spawn } = fakeSpawn(null, "stall");

    const outcome = await dispatchWorker(4, CONFIG, exec, spawn);

    expect(outcome).toMatchObject({ ok: false, failure: "stall" });
  });

  it("tolerates worktree-remove failures: no stale worktree before, best-effort cleanup after", async () => {
    const { exec } = fakeExec({ newCommits: "1", removeThrows: true });
    const { spawn } = fakeSpawn(0);

    const outcome = await dispatchWorker(4, CONFIG, exec, spawn);

    expect(outcome.ok).toBe(true);
  });

  it("still removes the worktree when spawning the process throws, then rethrows", async () => {
    const { exec, calls } = fakeExec();
    const { spawn } = fakeSpawn(new Error("spawn claude ENOENT"));

    await expect(dispatchWorker(4, CONFIG, exec, spawn)).rejects.toThrow("ENOENT");

    expect(calls.at(-1)).toEqual(["git", "worktree", "remove", "--force", WORKTREE]);
  });

  it("runs the configured model", async () => {
    const { exec } = fakeExec({ newCommits: "1" });
    const { spawn, requests } = fakeSpawn(0);

    await dispatchWorker(7, { ...CONFIG, model: "opus" }, exec, spawn);

    expect(requests[0]?.args).toContain("opus");
  });

  it("fails the attempt as a budget breach when the Worker hit the turn cap", async () => {
    const { exec } = fakeExec({ newCommits: "2" });
    const { spawn } = fakeSpawn(1, "exit", {
      stdoutTail: '{"type":"result","subtype":"error_max_turns","total_cost_usd":3.2,"num_turns":200}',
    });

    const outcome = await dispatchWorker(4, CONFIG, exec, spawn);

    expect(outcome).toMatchObject({
      ok: false,
      failure: "budget",
      infra: undefined,
      costUsd: 3.2,
      turns: 200,
    });
  });

  it("keeps a finished attempt that spent past the cost cap, flagging the overrun instead of failing", async () => {
    const { exec } = fakeExec({ newCommits: "3" });
    const { spawn } = fakeSpawn(0, "exit", {
      stdoutTail: '{"type":"result","subtype":"success","total_cost_usd":25.5,"num_turns":80}',
    });

    const outcome = await dispatchWorker(4, CONFIG, exec, spawn);

    expect(outcome).toMatchObject({
      ok: true,
      failure: undefined,
      costUsd: 25.5,
      costOverrun: true,
    });
  });

  it("keeps the underlying failure reason when a failed attempt also overran the cost cap", async () => {
    const { exec } = fakeExec({ newCommits: "0" });
    const { spawn } = fakeSpawn(1, "exit", {
      stdoutTail: '{"type":"result","subtype":"error_during_execution","total_cost_usd":25.5,"num_turns":80}',
    });

    const outcome = await dispatchWorker(4, CONFIG, exec, spawn);

    expect(outcome).toMatchObject({ ok: false, failure: "nonzero-exit", costOverrun: true });
  });

  it("succeeds under the cost cap, reporting the spend and turns", async () => {
    const { exec } = fakeExec({ newCommits: "3" });
    const { spawn } = fakeSpawn(0, "exit", {
      stdoutTail: '{"type":"result","subtype":"success","total_cost_usd":4.1,"num_turns":52}',
    });

    const outcome = await dispatchWorker(4, CONFIG, exec, spawn);

    expect(outcome).toMatchObject({ ok: true, failure: undefined, costUsd: 4.1, turns: 52 });
  });

  it("classifies a failed Worker with a rate-limit signature as an infrastructure failure", async () => {
    const { exec } = fakeExec({ newCommits: "0" });
    const { spawn } = fakeSpawn(1, "exit", {
      stderrTail: 'API Error: 429 {"type":"rate_limit_error"}',
    });

    const outcome = await dispatchWorker(4, CONFIG, exec, spawn);

    expect(outcome).toMatchObject({ ok: false, failure: undefined, infra: "rate-limit" });
  });

  it("classifies a stalled Worker with a network signature as infrastructure, not a stall", async () => {
    const { exec } = fakeExec({ newCommits: "0" });
    const { spawn } = fakeSpawn(null, "stall", {
      stderrTail: "TypeError: fetch failed\n  cause: Error: getaddrinfo ENOTFOUND api.anthropic.com",
    });

    const outcome = await dispatchWorker(4, CONFIG, exec, spawn);

    expect(outcome).toMatchObject({ ok: false, failure: undefined, infra: "network" });
  });

  it("never voids on infra-looking text in the transcript body: classification is by cause, not content", async () => {
    const { exec } = fakeExec({ newCommits: "0" });
    // A ticket legitimately about rate limiting: the Worker's prose and tool
    // output mention the signatures, but neither stderr nor the result line do.
    const { spawn } = fakeSpawn(1, "exit", {
      stdoutTail: [
        '{"type":"assistant","message":{"content":"Implementing the rate limit retry after ECONNRESET"}}',
        '{"type":"result","subtype":"error_during_execution","total_cost_usd":1.1,"num_turns":12}',
      ].join("\n"),
    });

    const outcome = await dispatchWorker(4, CONFIG, exec, spawn);

    expect(outcome).toMatchObject({ ok: false, failure: "nonzero-exit", infra: undefined });
  });

  it("lets a budget breach trump an infra signature: the result event proves the environment was up", async () => {
    const { exec } = fakeExec({ newCommits: "2" });
    const { spawn } = fakeSpawn(1, "exit", {
      stdoutTail: '{"type":"result","subtype":"error_max_turns","total_cost_usd":9,"num_turns":200}',
      stderrTail: "retrying after rate_limit_error",
    });

    const outcome = await dispatchWorker(4, CONFIG, exec, spawn);

    expect(outcome).toMatchObject({ ok: false, failure: "budget", infra: undefined });
  });

  it("never voids a successful Worker, whatever transient noise its logs carry", async () => {
    const { exec } = fakeExec({ newCommits: "2" });
    const { spawn } = fakeSpawn(0, "exit", {
      stdoutTail: '{"type":"result","subtype":"success","total_cost_usd":2,"num_turns":30}',
      stderrTail: "retrying after ECONNRESET",
    });

    const outcome = await dispatchWorker(4, CONFIG, exec, spawn);

    expect(outcome).toMatchObject({ ok: true, failure: undefined, infra: undefined });
  });

  it("namespaces branch and transcript per attempt, so a retry never clobbers prior evidence", async () => {
    const { exec } = fakeExec({ newCommits: "0" });
    const { spawn } = fakeSpawn(1);

    const outcome = await dispatchWorker(7, { ...CONFIG, attempt: 2 }, exec, spawn);

    expect(outcome.branch).toBe("border-collie/ticket-7-attempt-2");
    expect(outcome.transcript).toBe(".border-collie/transcripts/ticket-7-attempt-2.jsonl");
  });
});

describe("probeEnvironment", () => {
  it("answers true when a trivial prompt exits cleanly with no infrastructure signature", async () => {
    const { spawn, requests } = fakeSpawn(0, "exit", { stdoutTail: "ok" });

    await expect(probeEnvironment("sonnet", spawn)).resolves.toBe(true);
    expect(requests[0]?.cmd).toBe("claude");
    expect(requests[0]?.args).toContain("sonnet");
  });

  it("answers false on a non-zero exit", async () => {
    const { spawn } = fakeSpawn(1);

    await expect(probeEnvironment("sonnet", spawn)).resolves.toBe(false);
  });

  it("answers false on a clean exit that still carries an infrastructure signature", async () => {
    const { spawn } = fakeSpawn(0, "exit", { stdoutTail: "Claude AI usage limit reached|123" });

    await expect(probeEnvironment("sonnet", spawn)).resolves.toBe(false);
  });

  it("answers false when the probe cannot even spawn — a failed probe, not a crashed run", async () => {
    const { spawn } = fakeSpawn(new Error("spawn claude ENOENT"));

    await expect(probeEnvironment("sonnet", spawn)).resolves.toBe(false);
  });
});

describe("pushAgentBranch", () => {
  it("force-pushes the agent branch to origin", async () => {
    const { exec, calls } = fakeExec();

    await pushAgentBranch(BRANCH, exec);

    expect(calls).toEqual([["git", "push", "--force", "origin", BRANCH]]);
  });
});

describe("branchCommitSubjects", () => {
  it("lists the Attempt's commit subjects oldest first", async () => {
    const calls: string[][] = [];
    const exec: Exec = async (cmd, args) => {
      calls.push([cmd, ...args]);
      return "First commit\nSecond commit\n";
    };

    const subjects = await branchCommitSubjects("base-sha", BRANCH, exec);

    expect(calls).toEqual([["git", "log", "--format=%s", "--reverse", `base-sha..${BRANCH}`]]);
    expect(subjects).toEqual(["First commit", "Second commit"]);
  });
});

/** Drive real node child processes through the seam with tiny windows. */
describe("realSpawnWorkerProcess", () => {
  function request(script: string, windows: { timeoutMs: number; stallMs: number }): WorkerProcessRequest {
    const dir = mkdtempSync(join(tmpdir(), "border-collie-test-"));
    return {
      cmd: "node",
      args: ["-e", script],
      cwd: dir,
      transcriptPath: join(dir, "transcript.jsonl"),
      stderrPath: join(dir, "stderr.log"),
      ...windows,
    };
  }

  it("lets a clean exit through, streaming stdout to the transcript and keeping the tails", async () => {
    const req = request(`console.log("event"); console.error("warned")`, {
      timeoutMs: 5_000,
      stallMs: 5_000,
    });

    const exit = await realSpawnWorkerProcess(req);

    expect(exit).toEqual({
      exitCode: 0,
      endedBy: "exit",
      stdoutTail: "event\n",
      stderrTail: "warned\n",
    });
    expect(readFileSync(req.transcriptPath, "utf8")).toContain("event");
  });

  it("kills a process that outlives the wall-clock timeout even while it keeps emitting output", async () => {
    const req = request(`setInterval(() => console.log("tick"), 20)`, {
      timeoutMs: 300,
      stallMs: 5_000,
    });

    const exit = await realSpawnWorkerProcess(req);

    expect(exit.endedBy).toBe("timeout");
  });

  it("kills a process that goes quiet past the stall window", async () => {
    const req = request(`console.log("hi"); setTimeout(() => {}, 60_000)`, {
      timeoutMs: 5_000,
      stallMs: 300,
    });

    const exit = await realSpawnWorkerProcess(req);

    expect(exit.endedBy).toBe("stall");
  });
});
