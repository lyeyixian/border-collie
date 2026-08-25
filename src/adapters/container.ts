import { mkdir, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  encodeSessionLabels,
  parseSessionLabels,
  REPOSITORY_LABEL,
  type SessionLabels,
  type TranscriptFile,
  transcriptHostDir,
  transcriptsToPrune,
} from "../core/container.js";
import { type Exec, realExec } from "./tracker.js";

/**
 * The session-container seam (issue #177): a Worker Attempt run detached in
 * its own container instead of a GitHub Actions job, the second implementation
 * behind the `DispatchWorker` seam (act.ts) alongside `dispatchRemoteWorker`
 * (this file's sibling, adapters/worker.ts) — added beside it, not replacing
 * it; the Actions path stays the default until the cutover (issue #176).
 * Everything here goes through the `docker` CLI via the injected `Exec` seam,
 * the same shape every `gh`/`git` call in this codebase already takes.
 *
 * Also carries transcripts on the host past a container's exit and their
 * retention sweep (issue #182): `dispatchContainerWorker` bind-mounts a
 * per-repository host directory into every session it starts, and
 * `pruneTranscripts` deletes what has aged out of it, deferring the pure
 * decision of what qualifies to core/container.ts.
 */

/**
 * What a session container needs to run one Worker Attempt to completion.
 * `image` is never resolved here — the caller names it, the border-collie
 * base image today (issue #177's own scope: "Repository-specific images
 * come later") or a repository's own built image once issue #180 lands, the
 * same way `WorkerConfig.model` (adapters/worker.ts) is resolved by the
 * caller rather than this seam. `ghToken` and `claudeCodeOAuthToken` are the
 * same two credentials the Worker's Actions job already sets as environment
 * (`.github/workflows/border-collie-worker.yml`); minting them is issue
 * #178's concern, not this one's.
 */
export interface ContainerWorkerConfig {
  image: string;
  timeoutMinutes: number;
  ghToken: string;
  claudeCodeOAuthToken: string;
  /**
   * Host directory transcripts live under, one subdirectory per repository
   * (`transcriptHostDir`, core/container.ts) — the operator's disk, not the
   * session container's, so a session's evidence survives the `--rm` below
   * (issue #182).
   */
  transcriptsRoot: string;
}

/**
 * Where a repository's transcript directory is bind-mounted inside a
 * session container. Deliberately outside the git checkout root: `gh repo
 * clone "$REPOSITORY" .` refuses to clone into a directory that already has
 * anything in it, hidden or not, so the mount cannot sit under `.` at
 * container start — the entrypoint script symlinks `.border-collie/
 * transcripts` to this path only after the clone has already landed.
 */
const CONTAINER_TRANSCRIPTS_MOUNT = "/border-collie/transcripts";

/** Directory-creation half of the transcript seam, injectable for tests. */
export type EnsureDir = (path: string) => Promise<void>;

export const realEnsureDir: EnsureDir = async (path) => {
  await mkdir(path, { recursive: true });
};

/** One session container's `docker run --label key=value` arguments, from its identity. */
function labelArgs(session: SessionLabels): string[] {
  return Object.entries(encodeSessionLabels(session)).flatMap(
    ([key, value]) => ["--label", `${key}=${value}`],
  );
}

/**
 * Dispatch one Worker against one claimed ticket by starting its own session
 * container, detached, and returning immediately without an outcome — the
 * container half of the fire-and-forget dispatch seam (issue #73), alongside
 * `dispatchRemoteWorker`'s Actions-job half (adapters/worker.ts). The
 * container clones the repository fresh (via `gh repo clone`, authenticated
 * by the same token the Worker itself runs under — no checkout is shared
 * with it) and then runs the same Worker entrypoint an Actions job runs
 * today, `--in-place` (issue #75): one container means one checkout with
 * nothing to isolate from or serialize against, exactly like a dedicated job.
 * That entrypoint settles its own Attempt against the tracker (src/app/
 * worker.ts, issue #71); the next Tick reads the result back, and reads this
 * ticket's Worker liveness from the container's own labels
 * (`liveContainerTickets` below) rather than waiting on it here.
 *
 * `--rm`: the container itself leaves nothing behind once it exits — its
 * transcript already does, bind-mounted from the host directory this
 * repository's transcripts live under (`transcriptHostDir`, issue #182), so
 * an operator reads it after the fact the same way whether the session
 * succeeded or failed. The bind mount lands at `CONTAINER_TRANSCRIPTS_MOUNT`,
 * outside the checkout `gh repo clone` writes into — cloning into a
 * directory that already has anything in it, hidden included, fails — so the
 * script clones first and only then symlinks `.border-collie/transcripts` to
 * the mount, before the Worker entrypoint that writes there ever runs.
 *
 * The clone-and-run script is a fixed string with every dynamic value
 * carried in through `--env` and read back with `$VAR`, never interpolated
 * into the script body — the same rule the Worker's Actions job's own `run:`
 * step already documents and follows
 * (`.github/workflows/border-collie-worker.yml`: "Dispatch inputs arrive as
 * environment, never interpolated into the script body"), for the same
 * reason: a value spliced straight into a shell string is a command
 * injection waiting on whatever that value turns out to contain. The mount
 * path itself is a fixed, code-controlled constant, never a repository- or
 * ticket-derived value, so it needs no such guard.
 */
export async function dispatchContainerWorker(
  ticket: number,
  attempt: number,
  repository: string,
  config: ContainerWorkerConfig,
  exec: Exec = realExec,
  ensureDir: EnsureDir = realEnsureDir,
): Promise<undefined> {
  const hostDir = transcriptHostDir(config.transcriptsRoot, repository);
  await ensureDir(hostDir);
  await exec("docker", [
    "run",
    "--detach",
    "--rm",
    ...labelArgs({ repository, ticket, attempt }),
    "--env",
    `GH_TOKEN=${config.ghToken}`,
    "--env",
    `CLAUDE_CODE_OAUTH_TOKEN=${config.claudeCodeOAuthToken}`,
    "--env",
    `REPOSITORY=${repository}`,
    "--env",
    `TICKET=${ticket}`,
    "--env",
    `ATTEMPT=${attempt}`,
    "--env",
    `TIMEOUT_MINUTES=${config.timeoutMinutes}`,
    "--volume",
    `${hostDir}:${CONTAINER_TRANSCRIPTS_MOUNT}`,
    config.image,
    "sh",
    "-c",
    `gh repo clone "$REPOSITORY" . && mkdir -p .border-collie && ln -sfn ${CONTAINER_TRANSCRIPTS_MOUNT} .border-collie/transcripts && border-collie worker "$TICKET" "$ATTEMPT" --in-place --timeout-minutes "$TIMEOUT_MINUTES"`,
  ]);
  return undefined;
}

/**
 * Ticket numbers with a session container Docker still counts as running,
 * for one repository — the container replacement for `liveWorkerTickets`'s
 * `gh run list` read (adapters/tracker.ts, issue #73), matching its own
 * shape: Worker liveness read from the environment itself rather than a
 * promise held in the Orchestrator's memory, so a restarted Orchestrator
 * reaches the same verdict a long-running one would, and a container that
 * has already exited (`docker ps` lists running containers only, with no
 * `--all`) is never mistaken for one still live.
 */
export async function liveContainerTickets(
  repository: string,
  exec: Exec = realExec,
): Promise<Set<number>> {
  const stdout = await exec("docker", [
    "ps",
    "--filter",
    `label=${REPOSITORY_LABEL}=${repository}`,
    "--format",
    "{{.Labels}}",
  ]);
  const live = new Set<number>();
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    const session = parseSessionLabels(line);
    if (session !== undefined && session.repository === repository) {
      live.add(session.ticket);
    }
  }
  return live;
}

/** Directory-listing half of the retention sweep, injectable for tests. Yields nothing for a repository with no transcript directory yet, rather than failing the sweep over it. */
export type ListTranscripts = (dir: string) => Promise<TranscriptFile[]>;

export const realListTranscripts: ListTranscripts = async (dir) => {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const files: TranscriptFile[] = [];
  for (const name of names) {
    const info = await stat(join(dir, name));
    if (info.isFile()) files.push({ name, mtimeMs: info.mtimeMs });
  }
  return files;
};

/** Delete half of the retention sweep, injectable for tests. */
export type RemoveTranscript = (path: string) => Promise<void>;

export const realRemoveTranscript: RemoveTranscript = (path) => unlink(path);

/**
 * Delete one repository's session-container transcripts and stderr logs
 * that have aged past the retention window, skipping any still belonging to
 * a Ticket `liveContainerTickets` reports as running (issue #182's pruning
 * rule: age decides for a settled session, liveness always overrides age for
 * one still running). The decision itself is `transcriptsToPrune`
 * (core/container.ts, pure); this is its I/O — list, ask Docker who is
 * still live, delete. Returns the host paths it removed, for logging.
 */
export async function pruneTranscripts(
  repository: string,
  transcriptsRoot: string,
  retentionMs: number,
  exec: Exec = realExec,
  listTranscripts: ListTranscripts = realListTranscripts,
  removeTranscript: RemoveTranscript = realRemoveTranscript,
  now: number = Date.now(),
): Promise<string[]> {
  const dir = transcriptHostDir(transcriptsRoot, repository);
  const [files, liveTickets] = await Promise.all([
    listTranscripts(dir),
    liveContainerTickets(repository, exec),
  ]);
  const toRemove = transcriptsToPrune(files, now, retentionMs, liveTickets);
  for (const name of toRemove) {
    await removeTranscript(join(dir, name));
  }
  return toRemove.map((name) => join(dir, name));
}
