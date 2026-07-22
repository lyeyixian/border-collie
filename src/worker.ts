import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { classifyInfrastructure, lastResultLine, parseResultEvent } from "./classify.js";
import { realExec, type Exec } from "./tracker.js";
import { AGENT_BRANCH_PREFIX, type FailureReason, type InfraReason } from "./types.js";

/**
 * The WorkerHost seam: everything a dispatched Worker needs around it —
 * worktree, branch, headless `claude -p` process, transcript — composed
 * here, with the subprocess layer injectable for tests. All paths are
 * relative to the target repo root (the orchestrator's cwd).
 */

/** Orchestrator-owned scratch space at the target repo root (gitignored). */
export const RUN_DIR = ".border-collie";

export interface WorkerConfig {
  /** Model the Worker runs on (`claude --model`). */
  model: string;
  /**
   * Which Attempt this dispatch is (1-based). Namespaces the branch and
   * transcript so a retry never clobbers the prior attempt's evidence — an
   * Escalation must be able to cite every attempt's forensics.
   */
  attempt: number;
  /** Wall-clock ceiling for the whole Worker process. */
  timeoutMs: number;
  /** Max quiet time between output events before the Worker counts as stalled. */
  stallMs: number;
  /** Budget backstop: max agentic turns (`claude --max-turns`); breach is a ticket failure. */
  maxTurns: number;
  /** Budget backstop: max spend in USD per Attempt; breach is a ticket failure. */
  maxCostUsd: number;
}

/** One finished Attempt, as observed by the Orchestrator. */
export interface WorkerOutcome {
  ticket: number;
  /** Attempt number the dispatch ran as, echoed from the config. */
  attempt: number;
  /** Agent-prefixed branch the Worker committed to; retained after cleanup. */
  branch: string;
  /** Commit the branch was cut from; `base..branch` is the Attempt's work. */
  base: string;
  /** Transcript file path, for post-mortems. */
  transcript: string;
  /** Model the attempt ran on, echoed into the attempt record on failure. */
  model: string;
  exitCode: number | null;
  /** Commits on the branch beyond the base it was cut from. */
  newCommits: number;
  /**
   * Which ticket-failure trigger fired, or undefined when none did (success,
   * or an infrastructure failure): nonzero-exit, no-commits, timeout, stall,
   * budget. Mutually exclusive with `infra`.
   */
  failure: FailureReason | undefined;
  /**
   * The infrastructure class a failed Worker's output evidenced, or
   * undefined. An infra death voids the Attempt instead of burning it
   * (CONTEXT.md "Infrastructure failure").
   */
  infra: InfraReason | undefined;
  /** Attempt spend in USD, from the transcript's result event when one survived. */
  costUsd: number | undefined;
  /** Agentic turns taken, from the transcript's result event when one survived. */
  turns: number | undefined;
  /** The success predicate: no failure trigger fired, ticket or infrastructure. */
  ok: boolean;
}

/** What the Worker process is started with. */
export interface WorkerProcessRequest {
  cmd: string;
  args: string[];
  cwd: string;
  /** File the process's stdout (the stream-json events) streams into as it runs. */
  transcriptPath: string;
  /** File the process's stderr streams into, kept apart so the transcript stays parseable. */
  stderrPath: string;
  /** Wall-clock ceiling; the process is killed when it elapses. */
  timeoutMs: number;
  /** Stall window; the process is killed when stdout goes quiet this long. */
  stallMs: number;
}

/** How the Worker process ended: on its own, or killed by which watchdog. */
export interface WorkerProcessExit {
  exitCode: number | null;
  endedBy: "exit" | "timeout" | "stall";
  /** Last stretch of stdout, kept in memory for classification (full stream is on disk). */
  stdoutTail: string;
  /** Last stretch of stderr, kept in memory for classification. */
  stderrTail: string;
}

/** How much of each output stream's tail is kept for classification. */
export const TAIL_LIMIT = 64 * 1024;

/** Accumulate a stream into a bounded tail: only the last TAIL_LIMIT chars survive. */
function makeTail(): { push: (chunk: Buffer | string) => void; read: () => string } {
  let tail = "";
  return {
    push: (chunk) => {
      tail = (tail + String(chunk)).slice(-TAIL_LIMIT);
    },
    read: () => tail,
  };
}

/** Process seam: run the Worker to completion under both watchdogs. */
export type SpawnWorkerProcess = (request: WorkerProcessRequest) => Promise<WorkerProcessExit>;

export const realSpawnWorkerProcess: SpawnWorkerProcess = (request) =>
  new Promise((resolve, reject) => {
    mkdirSync(dirname(request.transcriptPath), { recursive: true });
    const transcript = createWriteStream(request.transcriptPath);
    const stderr = createWriteStream(request.stderrPath);
    const child = spawn(request.cmd, request.args, {
      cwd: request.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutTail = makeTail();
    const stderrTail = makeTail();
    child.stdout.pipe(transcript);
    child.stderr.pipe(stderr);
    child.stdout.on("data", stdoutTail.push);
    child.stderr.on("data", stderrTail.push);

    // SIGKILL, not SIGTERM: a stalled Worker may not be servicing signals.
    let endedBy: WorkerProcessExit["endedBy"] = "exit";
    const wallTimer = setTimeout(() => {
      endedBy = "timeout";
      child.kill("SIGKILL");
    }, request.timeoutMs);
    let stallTimer: NodeJS.Timeout | undefined;
    const rearmStallWatchdog = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        endedBy = "stall";
        child.kill("SIGKILL");
      }, request.stallMs);
    };
    rearmStallWatchdog();
    child.stdout.on("data", rearmStallWatchdog);

    const end = () => {
      clearTimeout(wallTimer);
      clearTimeout(stallTimer);
      transcript.end();
      stderr.end();
    };
    child.on("error", (error) => {
      end();
      reject(error);
    });
    child.on("close", (code) => {
      end();
      resolve({
        exitCode: code,
        endedBy,
        stdoutTail: stdoutTail.read(),
        stderrTail: stderrTail.read(),
      });
    });
  });

/**
 * The entire Worker prompt: the ticket reference, the /implement invocation,
 * and the final-message-is-a-PR-description instruction — nothing else. A
 * Worker is fed nothing beyond its ticket (CONTEXT.md "Worker"); it
 * discovers repo context itself.
 */
export function workerPrompt(ticket: number): string {
  return [
    `/implement issue #${ticket}`,
    "",
    "When the work is committed, make your final message a pull request description for this branch. It is used verbatim as the PR body, so it must contain nothing but the description itself — no preamble like \"Here's the PR description:\", no status narration, no text before or after it.",
  ].join("\n");
}

/** Best-effort worktree removal: absent or stale worktrees are fine. */
async function removeWorktree(worktree: string, exec: Exec): Promise<void> {
  await exec("git", ["worktree", "remove", "--force", worktree]).catch(() => {});
}

/**
 * git worktree and ref operations take repo-level locks, so concurrent
 * Workers must not run them at once. Every git phase takes a turn on this
 * queue; only the long-running claude processes overlap.
 */
let gitTurn: Promise<unknown> = Promise.resolve();
function withGitLock<T>(operation: () => Promise<T>): Promise<T> {
  const turn = gitTurn.then(operation, operation);
  gitTurn = turn.catch(() => {});
  return turn;
}

/**
 * Push an agent branch to origin so a PR can be opened on it. Force, because
 * `-B` resets the branch each attempt: whatever a crashed run left on the
 * remote is superseded, never recorded progress (ADR 0001). Only ever called
 * on agent-prefixed branches.
 */
export async function pushAgentBranch(branch: string, exec: Exec = realExec): Promise<void> {
  await withGitLock(() => exec("git", ["push", "--force", "origin", branch]));
}

/** Commit subjects of an Attempt's work, oldest first. */
export async function branchCommitSubjects(
  base: string,
  branch: string,
  exec: Exec = realExec,
): Promise<string[]> {
  const stdout = await withGitLock(() =>
    exec("git", ["log", "--format=%s", "--reverse", `${base}..${branch}`]),
  );
  return stdout.split("\n").filter((line) => line.trim() !== "");
}

/**
 * Dispatch one Worker against one claimed ticket: cut an agent branch in an
 * isolated worktree, run headless claude in it streaming to a transcript,
 * then judge the outcome and remove the worktree (branch retained). The
 * branch is cut from the remote default branch's current tip (fetched fresh
 * each dispatch), never the local checkout: a ticket is Dispatchable only
 * once its blockers' PRs have merged, and that gating holds only if the
 * Worker's base contains those merges — the local checkout goes stale the
 * moment a sibling merges mid-run. Branch and transcript are namespaced per
 * attempt so a retry leaves the failed attempt's evidence intact for
 * Escalation. `-B` and the up-front removal reset leftovers of the SAME
 * attempt from a crashed run — a local branch that never became a PR is not
 * recorded progress (ADR 0001: GitHub is the only state store), so
 * re-running the Tick supersedes it.
 */
export async function dispatchWorker(
  ticket: number,
  config: WorkerConfig,
  exec: Exec = realExec,
  spawnProcess: SpawnWorkerProcess = realSpawnWorkerProcess,
): Promise<WorkerOutcome> {
  const branch = `${AGENT_BRANCH_PREFIX}${ticket}-attempt-${config.attempt}`;
  const worktree = join(RUN_DIR, "worktrees", `ticket-${ticket}`);
  const transcript = join(RUN_DIR, "transcripts", `ticket-${ticket}-attempt-${config.attempt}.jsonl`);
  const stderrLog = join(
    RUN_DIR,
    "transcripts",
    `ticket-${ticket}-attempt-${config.attempt}.stderr.log`,
  );

  const base = await withGitLock(async () => {
    await removeWorktree(worktree, exec);
    await exec("git", ["worktree", "prune"]);
    await exec("git", ["fetch", "origin"]);
    await exec("git", ["worktree", "add", worktree, "-B", branch, "origin/HEAD"]);
    return (await exec("git", ["rev-parse", branch])).trim();
  });

  try {
    // Headless Workers cannot answer permission prompts; skipping them is
    // what confines the blast radius to the worktree plus the operator's
    // own tracker.
    const { exitCode, endedBy, stdoutTail, stderrTail } = await spawnProcess({
      cmd: "claude",
      args: [
        "-p",
        workerPrompt(ticket),
        "--model",
        config.model,
        "--max-turns",
        String(config.maxTurns),
        "--output-format",
        "stream-json",
        "--verbose",
        "--dangerously-skip-permissions",
      ],
      cwd: worktree,
      transcriptPath: transcript,
      stderrPath: stderrLog,
      timeoutMs: config.timeoutMs,
      stallMs: config.stallMs,
    });
    const newCommits = Number(
      (await withGitLock(() => exec("git", ["rev-list", "--count", `${base}..${branch}`]))).trim(),
    );
    // A killed Worker fails even with commits on the branch: it never got to
    // finish, so the work is unverified and the PR description is missing.
    const trigger: FailureReason | undefined =
      endedBy !== "exit"
        ? endedBy
        : exitCode !== 0
          ? "nonzero-exit"
          : newCommits === 0
            ? "no-commits"
            : undefined;
    const result = parseResultEvent(stdoutTail);
    // Classification order: budget trumps infra trumps the raw trigger. A
    // parsed result event proves the environment carried the Worker to its
    // end, so a budget breach is the ticket's fault whatever infra-looking
    // noise the logs hold — and it fails even a Worker that otherwise
    // finished cleanly: the backstop is what surfaces oversized tickets to a
    // human. (The cost cap is necessarily post-hoc — mid-flight spend is
    // invisible until the result event — so a runaway is *stopped* by the
    // turn cap and wall clock, and the cost cap fails what they let
    // through.) Infra is only consulted for Workers that already died — a
    // successful Attempt is never voided — and only against stderr plus the
    // result line, never the transcript body, where a ticket legitimately
    // about rate limits would match by content instead of cause.
    const budgetBreached =
      result?.subtype === "error_max_turns" ||
      (result?.totalCostUsd !== undefined && result.totalCostUsd > config.maxCostUsd);
    const infra =
      trigger !== undefined && !budgetBreached
        ? classifyInfrastructure(`${stderrTail}\n${lastResultLine(stdoutTail)}`)
        : undefined;
    const failure: FailureReason | undefined =
      budgetBreached ? "budget" : infra !== undefined ? undefined : trigger;
    return {
      ticket,
      attempt: config.attempt,
      branch,
      base,
      transcript,
      model: config.model,
      exitCode,
      newCommits,
      failure,
      infra,
      costUsd: result?.totalCostUsd,
      turns: result?.numTurns,
      ok: failure === undefined && infra === undefined,
    };
  } finally {
    await withGitLock(() => removeWorktree(worktree, exec));
  }
}

/** The probe's own generous window: a healthy environment answers in seconds. */
export const PROBE_TIMEOUT_MS = 2 * 60_000;

/**
 * The circuit breaker's recovery probe: one trivial headless prompt, no
 * tracker writes, no worktree. The environment counts as recovered when the
 * probe exits cleanly with no infrastructure signature in its output — only
 * then does dispatch resume.
 */
export async function probeEnvironment(
  model: string,
  spawnProcess: SpawnWorkerProcess = realSpawnWorkerProcess,
): Promise<boolean> {
  const { exitCode, endedBy, stdoutTail, stderrTail } = await spawnProcess({
    cmd: "claude",
    args: ["-p", "Reply with only the word ok.", "--model", model],
    cwd: ".",
    transcriptPath: join(RUN_DIR, "transcripts", "probe.log"),
    stderrPath: join(RUN_DIR, "transcripts", "probe.stderr.log"),
    timeoutMs: PROBE_TIMEOUT_MS,
    stallMs: PROBE_TIMEOUT_MS,
  }).catch(() => ({
    // A probe that cannot even spawn is a failed probe, not a crashed run.
    exitCode: null,
    endedBy: "exit" as const,
    stdoutTail: "",
    stderrTail: "spawn failed",
  }));
  return (
    endedBy === "exit" &&
    exitCode === 0 &&
    classifyInfrastructure(`${stderrTail}\n${stdoutTail}`) === undefined
  );
}
