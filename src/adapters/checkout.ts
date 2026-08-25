import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { stripAppPrivateKey } from "../core/app-auth.js";
import type { Exec } from "./tracker.js";

/**
 * The daemon's own local checkout of one fleet repository (issue #183): the
 * one persistent filesystem footprint the daemon keeps per repository, kept
 * separate from a Worker Attempt's own isolation (a session container clones
 * fresh every time, per ADR 0009). This checkout exists for the two things
 * that still run against a real local clone rather than through the GitHub
 * API: Conflict Worker and Refinement round dispatch, which still cut
 * worktrees on the daemon host until issue #181 moves them into containers
 * too, and the skill-file existence check `tick.ts` reads straight off disk.
 *
 * `gh` and `git` resolve `{owner}/{repo}` and the remote to operate on from
 * the *process's* working directory (adapters/tracker.ts), and a single
 * process cannot hold two working directories at once — the daemon ticks
 * several repositories concurrently, so `execAtRepo` gives every repository
 * its own `Exec`, bound to its own checkout directory, rather than any of
 * them touching the daemon process's own `process.cwd()`.
 */

const execFileAsync = promisify(execFile);

/** The subprocess boundary a real call drives, injectable for tests. */
export type ExecFile = (
  cmd: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
) => Promise<string>;

export const realExecFile: ExecFile = async (cmd, args, options) => {
  const { stdout } = await execFileAsync(cmd, args, {
    ...options,
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
};

/**
 * An `Exec` bound to one repository's checkout directory and installation
 * token: every call runs with that directory as its cwd (so `gh`/`git`
 * resolve this repository, not whichever one the daemon last touched) and
 * `GH_TOKEN` set for `gh` auth. The daemon's own environment may carry the
 * GitHub App private key (`BORDER_COLLIE_APP_PRIVATE_KEY`, needed to mint
 * this very token) — `stripAppPrivateKey` keeps it out of every `git`/`gh`
 * child process this seam spawns, the same rule the Worker process spawner
 * already applies (adapters/worker.ts's `realSpawnWorkerProcess`).
 */
export function execAtRepo(
  cwd: string,
  token: string,
  execFileFn: ExecFile = realExecFile,
): Exec {
  return (cmd, args) =>
    execFileFn(cmd, args, {
      cwd,
      env: { ...stripAppPrivateKey(process.env), GH_TOKEN: token },
    });
}

/** Where one repository's checkout lives under the daemon's own state directory. */
export function checkoutPath(reposDir: string, repository: string): string {
  return join(reposDir, repository.replace("/", "__"));
}

/**
 * Ensures one repository's checkout exists and is current: clones it fresh
 * the first time the daemon ticks it, or fetches and fast-forwards an
 * existing checkout to the remote's default branch on every later poll —
 * cheap enough to run every Tick, and it means a repository whose default
 * branch moved (or whose skill file just changed) is never judged against a
 * stale copy. Returns the checkout's directory, ready to drive a Tick's own
 * `Exec` and `cwd` (`execAtRepo`, `tick.ts`'s `TickDeps.cwd`).
 */
export async function ensureCheckout(
  reposDir: string,
  repository: string,
  token: string,
  execFileFn: ExecFile = realExecFile,
): Promise<string> {
  const dir = checkoutPath(reposDir, repository);
  if (!existsSync(dir)) {
    // The daemon's own state directory (`--state-dir`, default
    // `~/.border-collie`) may not exist yet on a fresh host — `execFile`'s
    // `cwd` throws ENOENT against a missing directory, so this has to exist
    // before the clone below can even start.
    mkdirSync(reposDir, { recursive: true });
    await execAtRepo(
      reposDir,
      token,
      execFileFn,
    )("gh", ["repo", "clone", repository, dir]);
  } else {
    const exec = execAtRepo(dir, token, execFileFn);
    await exec("git", ["fetch", "origin"]);
    await exec("git", ["reset", "--hard", "origin/HEAD"]);
  }
  return dir;
}
