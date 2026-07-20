import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { realExec, type Exec } from "./tracker.js";
import { AGENT_BRANCH_PREFIX } from "./types.js";

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
}

/** One finished Attempt, as observed by the Orchestrator. */
export interface WorkerOutcome {
  ticket: number;
  /** Agent-prefixed branch the Worker committed to; retained after cleanup. */
  branch: string;
  /** Commit the branch was cut from; `base..branch` is the Attempt's work. */
  base: string;
  /** Transcript file path, for post-mortems. */
  transcript: string;
  exitCode: number | null;
  /** Commits on the branch beyond the base it was cut from. */
  newCommits: number;
  /**
   * The success predicate: the process exited cleanly AND new commits exist.
   * Anything else is a failed attempt (classified fully by the
   * failure-handling ticket).
   */
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
}

/** Process seam: run the Worker to completion, resolving with its exit code. */
export type SpawnWorkerProcess = (request: WorkerProcessRequest) => Promise<number | null>;

export const realSpawnWorkerProcess: SpawnWorkerProcess = (request) =>
  new Promise((resolve, reject) => {
    mkdirSync(dirname(request.transcriptPath), { recursive: true });
    const transcript = createWriteStream(request.transcriptPath);
    const stderr = createWriteStream(request.stderrPath);
    const child = spawn(request.cmd, request.args, {
      cwd: request.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.pipe(transcript);
    child.stderr.pipe(stderr);
    const end = () => {
      transcript.end();
      stderr.end();
    };
    child.on("error", (error) => {
      end();
      reject(error);
    });
    child.on("close", (code) => {
      end();
      resolve(code);
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
    "When the work is committed, make your final message a pull request description for this branch: it will be used verbatim as the PR body.",
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
 * moment a sibling merges mid-run. `-B` and the up-front removal reset leftovers from a
 * crashed run or failed attempt — a local branch that never became a PR is
 * not recorded progress, so a fresh attempt supersedes it and the recovery
 * story stays "re-run the Tick".
 */
export async function dispatchWorker(
  ticket: number,
  config: WorkerConfig,
  exec: Exec = realExec,
  spawnProcess: SpawnWorkerProcess = realSpawnWorkerProcess,
): Promise<WorkerOutcome> {
  const branch = `${AGENT_BRANCH_PREFIX}${ticket}`;
  const worktree = join(RUN_DIR, "worktrees", `ticket-${ticket}`);
  const transcript = join(RUN_DIR, "transcripts", `ticket-${ticket}.jsonl`);
  const stderrLog = join(RUN_DIR, "transcripts", `ticket-${ticket}.stderr.log`);

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
    const exitCode = await spawnProcess({
      cmd: "claude",
      args: [
        "-p",
        workerPrompt(ticket),
        "--model",
        config.model,
        "--output-format",
        "stream-json",
        "--verbose",
        "--dangerously-skip-permissions",
      ],
      cwd: worktree,
      transcriptPath: transcript,
      stderrPath: stderrLog,
    });
    const newCommits = Number(
      (await withGitLock(() => exec("git", ["rev-list", "--count", `${base}..${branch}`]))).trim(),
    );
    return {
      ticket,
      branch,
      base,
      transcript,
      exitCode,
      newCommits,
      ok: exitCode === 0 && newCommits > 0,
    };
  } finally {
    await withGitLock(() => removeWorktree(worktree, exec));
  }
}
