import {
  access,
  mkdir,
  readdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  DEFAULT_TRANSCRIPT_RETENTION_MS,
  encodePrSessionLabels,
  encodeSessionLabels,
  type PrSessionKind,
  type PrSessionLabels,
  parsePrSessionLabels,
  parseSessionLabels,
  prTranscriptSessionKey,
  REPOSITORY_LABEL,
  repositoryImageSlug,
  type SessionLabels,
  sessionLayerDockerfile,
  type TranscriptFile,
  transcriptHostDir,
  transcriptSessionKey,
  transcriptsToPrune,
} from "../core/container.js";
import { RUN_DIR } from "../core/types.js";
import { resolveDockerfilePath } from "../core/workflow.js";
import { cliVersion } from "./scaffold.js";
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
 * decision of what qualifies to core/container.ts. `dispatchContainer
 * ConflictWorker` and `dispatchContainerRefinementWorker` bind-mount the
 * same per-repository directory into their own sessions too (issue #198),
 * so one sweep covers a Worker Attempt's, a Conflict Worker's and a
 * Refinement round's transcripts alike.
 */

/**
 * What a session container needs to run one Worker Attempt to completion.
 * `image` is never resolved here — the caller names it, either the
 * border-collie base image directly or `resolveSessionImage`'s result (issue
 * #180: the border-collie base image when a repository declares no
 * Dockerfile, or an image built from its own Dockerfile and layered with
 * border-collie's own tools otherwise), the same way `WorkerConfig.model`
 * (adapters/worker.ts) is resolved by the caller rather than this seam.
 * `ghToken` and `claudeCodeOAuthToken` are the same two credentials the
 * Worker's Actions job already sets as environment
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
 * Every session container Docker still counts as running for one
 * repository, read straight from `docker ps`'s own label listing — a
 * container that has already exited (`docker ps` lists running containers
 * only, with no `--all`) is simply absent, never mistaken for one still
 * live. One `docker ps` call yields both label shapes at once (a Worker
 * Attempt's `SessionLabels`, a Conflict Worker's or Refinement round's
 * `PrSessionLabels`, issue #198) — each line matches at most one, so
 * parsing both from the same listing costs nothing extra. Shared by
 * `liveContainerTickets` and `liveContainerPrs` below (each repository's
 * own liveness read) and `pruneTranscripts` below (both shapes' liveness at
 * once, since one transcript directory holds both kinds of file side by
 * side): every reader of one repository's `docker ps` listing goes through
 * here, so listing and parsing it lives in exactly one place.
 */
async function liveContainers(
  repository: string,
  exec: Exec,
): Promise<{ sessions: SessionLabels[]; prSessions: PrSessionLabels[] }> {
  const stdout = await exec("docker", [
    "ps",
    "--filter",
    `label=${REPOSITORY_LABEL}=${repository}`,
    "--format",
    "{{.Labels}}",
  ]);
  const sessions: SessionLabels[] = [];
  const prSessions: PrSessionLabels[] = [];
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    const session = parseSessionLabels(line);
    if (session !== undefined && session.repository === repository) {
      sessions.push(session);
    }
    const prSession = parsePrSessionLabels(line);
    if (prSession !== undefined && prSession.repository === repository) {
      prSessions.push(prSession);
    }
  }
  return { sessions, prSessions };
}

/**
 * Ticket numbers with a session container Docker still counts as running,
 * for one repository — the container replacement for `liveWorkerTickets`'s
 * `gh run list` read (adapters/tracker.ts, issue #73), matching its own
 * shape: Worker liveness read from the environment itself rather than a
 * promise held in the Orchestrator's memory, so a restarted Orchestrator
 * reaches the same verdict a long-running one would.
 */
export async function liveContainerTickets(
  repository: string,
  exec: Exec = realExec,
): Promise<Set<number>> {
  const { sessions } = await liveContainers(repository, exec);
  return new Set(sessions.map((session) => session.ticket));
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
 * that have aged past the retention window (default `DEFAULT_TRANSCRIPT_
 * RETENTION_MS`, overridable by the caller — issue #182's "the window is
 * configurable" criterion), skipping any still belonging to a live session:
 * a Worker Attempt still running is checked Ticket-*and*-Attempt (a settled
 * Attempt 1 must still age out while Attempt 2 runs, so this checks the
 * pair, not the Ticket alone — `liveContainerTickets`, above, deliberately
 * checks only the Ticket, the orphan check it serves cares whether the
 * Ticket has any live Worker, not which Attempt); a Conflict Worker or
 * Refinement round still running is checked PR-*and*-kind, the same
 * discipline (issue #198) — a stale Conflict Worker transcript must still
 * age out while a Refinement round for the same PR runs. The decision
 * itself is `transcriptsToPrune` (core/container.ts, pure); this is its I/O
 * — list, ask Docker who is still live, delete. Returns the host paths it
 * removed, for logging.
 */
export async function pruneTranscripts(
  repository: string,
  transcriptsRoot: string,
  retentionMs: number = DEFAULT_TRANSCRIPT_RETENTION_MS,
  exec: Exec = realExec,
  listTranscripts: ListTranscripts = realListTranscripts,
  removeTranscript: RemoveTranscript = realRemoveTranscript,
  now: number = Date.now(),
): Promise<string[]> {
  const dir = transcriptHostDir(transcriptsRoot, repository);
  const [files, { sessions, prSessions }] = await Promise.all([
    listTranscripts(dir),
    liveContainers(repository, exec),
  ]);
  const liveKeys = new Set<string>();
  for (const session of sessions) {
    liveKeys.add(transcriptSessionKey(session.ticket, session.attempt));
  }
  for (const session of prSessions) {
    liveKeys.add(prTranscriptSessionKey(session.pr, session.kind));
  }
  const toRemove = transcriptsToPrune(files, now, retentionMs, liveKeys);
  for (const name of toRemove) {
    await removeTranscript(join(dir, name));
  }
  return toRemove.map((name) => join(dir, name));
}

/**
 * A declared Dockerfile that names a path the checkout does not have, or
 * whose build fails, naming the repository (issue #180) — the caller (the
 * daemon, once wired) reports this rather than silently falling back to the
 * base image, since the repository asked for a Dockerfile it does not have
 * working. Never thrown for a repository that declares no Dockerfile at
 * all: that resolves to the base image with no error, the same posture the
 * verify contract already keeps for an empty `WORKFLOW.md`.
 */
export class ContainerImageError extends Error {}

/** Filesystem existence check, injectable for tests. */
export type PathExists = (path: string) => Promise<boolean>;

export const realPathExists: PathExists = async (path) => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

/** Writes border-collie's own layer Dockerfile to disk, injectable for tests. */
export type WriteLayerDockerfile = (
  path: string,
  content: string,
) => Promise<void>;

export const realWriteLayerDockerfile: WriteLayerDockerfile = async (
  path,
  content,
) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
};

/** What `resolveSessionImage` needs to pick, and if needed build, a session container's image. */
export interface SessionImageInput {
  repository: string;
  /**
   * Wherever the caller already has this repository checked out — `dockerfile`
   * (and the intermediate Dockerfile this writes) are resolved against it.
   * This function never clones or fetches anything itself.
   */
  cwd: string;
  /** The border-collie base image, used verbatim when the repository declares no Dockerfile (issue #177). */
  baseImage: string;
  /** `Contract.dockerfile`, from the checkout's own `WORKFLOW.md`. */
  dockerfile: string | undefined;
}

const REPO_IMAGE_NAME = "border-collie-repo-image";
const SESSION_IMAGE_NAME = "border-collie-session-image";
const SESSION_LAYER_DOCKERFILE = "session-layer.Dockerfile";

/** An error's message, or its stringified form when it isn't an `Error` — for folding into a `ContainerImageError`'s own message. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Resolve the image a session container runs from (issue #180): the
 * border-collie base image, verbatim, when the repository declares no
 * Dockerfile, or its default path (`.border-collie/Dockerfile`) does not
 * exist in this checkout; a two-stage build otherwise — the repository's
 * own Dockerfile first, then border-collie's own layer
 * (`sessionLayerDockerfile`, core/container.ts) on top of whatever it
 * produced. The repository's own file is never asked to `FROM` a
 * border-collie image and never installs border-collie's own tools itself
 * — the layer above does both, so the repository's file never has to know
 * border-collie exists (ADR 0009).
 *
 * A path `WORKFLOW.md` itself declared that does not exist, or a Dockerfile
 * (declared or the default one) that fails to build, is a named
 * `ContainerImageError` naming the repository — never a silent fall back to
 * the base image, since a declared path that does not work is the
 * repository's own broken declaration to fix, not a "declares nothing"
 * state. The default path simply not existing is not an error at all: that
 * is what a repository that declares no Dockerfile looks like on disk.
 */
export async function resolveSessionImage(
  input: SessionImageInput,
  exec: Exec = realExec,
  pathExists: PathExists = realPathExists,
  writeLayerDockerfile: WriteLayerDockerfile = realWriteLayerDockerfile,
  borderCollieVersion: string = cliVersion(),
): Promise<string> {
  const resolution = resolveDockerfilePath(input.dockerfile);
  const dockerfilePath = join(input.cwd, resolution.path);
  const exists = await pathExists(dockerfilePath);
  if (!exists) {
    if (resolution.declared) {
      throw new ContainerImageError(
        `${input.repository} declares a Dockerfile at "${resolution.path}" that does not exist`,
      );
    }
    return input.baseImage;
  }

  const slug = repositoryImageSlug(input.repository);
  const repoTag = `${REPO_IMAGE_NAME}:${slug}`;
  try {
    await exec("docker", [
      "build",
      "-f",
      dockerfilePath,
      "-t",
      repoTag,
      input.cwd,
    ]);
  } catch (error) {
    throw new ContainerImageError(
      `${input.repository}'s Dockerfile at "${resolution.path}" failed to build: ${messageOf(error)}`,
    );
  }

  const layerPath = join(input.cwd, RUN_DIR, SESSION_LAYER_DOCKERFILE);
  await writeLayerDockerfile(
    layerPath,
    sessionLayerDockerfile(borderCollieVersion),
  );
  const sessionTag = `${SESSION_IMAGE_NAME}:${slug}`;
  try {
    await exec("docker", [
      "build",
      "-f",
      layerPath,
      "--build-arg",
      `REPO_IMAGE=${repoTag}`,
      "-t",
      sessionTag,
      input.cwd,
    ]);
  } catch (error) {
    throw new ContainerImageError(
      `${input.repository}: layering border-collie's own tools onto its Dockerfile's image failed: ${messageOf(error)}`,
    );
  }
  return sessionTag;
}

/** One PR-scoped session container's `docker run --label key=value` arguments, from its identity. */
function prLabelArgs(session: PrSessionLabels): string[] {
  return Object.entries(encodePrSessionLabels(session)).flatMap(
    ([key, value]) => ["--label", `${key}=${value}`],
  );
}

/**
 * Dispatch one Conflict Worker against one conflicted PR by starting its own
 * session container, detached, and returning immediately without an outcome
 * (issue #181) — the PR-scoped sibling of `dispatchContainerWorker` above,
 * labelled by PR and kind rather than ticket and attempt, since a Conflict
 * Worker is not an Attempt and has no ticket-scoped identity of its own to
 * key liveness on. The container clones the repository fresh and runs
 * `border-collie conflict-worker --in-place`, the settling entrypoint that
 * dispatches the session and pushes the resolved rebase (or asks a human)
 * itself, exactly as `border-collie worker --in-place` does for a Worker
 * Attempt; the next Tick reads the result back from the tracker, and reads
 * this PR's liveness from the container's own labels (`liveContainerPrs`
 * below) rather than waiting on it here.
 *
 * Bind-mounts and symlinks this repository's host transcript directory the
 * same way `dispatchContainerWorker` does (issue #198): `pr-N-conflict.*`
 * shares the Attempt's own per-repository directory rather than getting one
 * of its own, so `pruneTranscripts` sweeps both from the one place.
 *
 * `--rm`, and the dynamic-value-through-`--env`-never-interpolated rule: the
 * same reasoning `dispatchContainerWorker`'s own doc comment gives.
 */
export async function dispatchContainerConflictWorker(
  pr: number,
  ticket: number,
  headRef: string,
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
    ...prLabelArgs({ repository, pr, kind: "conflict" }),
    "--env",
    `GH_TOKEN=${config.ghToken}`,
    "--env",
    `CLAUDE_CODE_OAUTH_TOKEN=${config.claudeCodeOAuthToken}`,
    "--env",
    `REPOSITORY=${repository}`,
    "--env",
    `PR=${pr}`,
    "--env",
    `TICKET=${ticket}`,
    "--env",
    `HEAD_REF=${headRef}`,
    "--env",
    `TIMEOUT_MINUTES=${config.timeoutMinutes}`,
    "--volume",
    `${hostDir}:${CONTAINER_TRANSCRIPTS_MOUNT}`,
    config.image,
    "sh",
    "-c",
    `gh repo clone "$REPOSITORY" . && mkdir -p .border-collie && ln -sfn ${CONTAINER_TRANSCRIPTS_MOUNT} .border-collie/transcripts && border-collie conflict-worker "$PR" "$TICKET" "$HEAD_REF" --in-place --timeout-minutes "$TIMEOUT_MINUTES"`,
  ]);
  return undefined;
}

/**
 * Dispatch one Refinement round against one open agent PR by starting its own
 * session container, detached, and returning immediately without an outcome
 * (issue #181) — the PR-scoped sibling of `dispatchContainerConflictWorker`
 * above, carrying `round` as an explicit env var since the round marker
 * (`REFINEMENT_ROUND_MARKER`) is posted by the Tick before this dispatches
 * (the charge-before-spend shape `core/types.ts` documents), not recomputed
 * inside the container. Runs `border-collie refine --in-place`, the settling
 * entrypoint that dispatches the round and pushes its branch when it
 * committed a fix.
 *
 * Bind-mounts and symlinks this repository's host transcript directory the
 * same way `dispatchContainerConflictWorker` does (issue #198): `pr-N-
 * refinement-round-R.*` shares the same per-repository directory rather
 * than getting one of its own.
 */
export async function dispatchContainerRefinementWorker(
  pr: number,
  ticket: number,
  headRef: string,
  round: number,
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
    ...prLabelArgs({ repository, pr, kind: "refinement" }),
    "--env",
    `GH_TOKEN=${config.ghToken}`,
    "--env",
    `CLAUDE_CODE_OAUTH_TOKEN=${config.claudeCodeOAuthToken}`,
    "--env",
    `REPOSITORY=${repository}`,
    "--env",
    `PR=${pr}`,
    "--env",
    `TICKET=${ticket}`,
    "--env",
    `HEAD_REF=${headRef}`,
    "--env",
    `ROUND=${round}`,
    "--env",
    `TIMEOUT_MINUTES=${config.timeoutMinutes}`,
    "--volume",
    `${hostDir}:${CONTAINER_TRANSCRIPTS_MOUNT}`,
    config.image,
    "sh",
    "-c",
    `gh repo clone "$REPOSITORY" . && mkdir -p .border-collie && ln -sfn ${CONTAINER_TRANSCRIPTS_MOUNT} .border-collie/transcripts && border-collie refine "$PR" "$TICKET" "$HEAD_REF" "$ROUND" --in-place --timeout-minutes "$TIMEOUT_MINUTES"`,
  ]);
  return undefined;
}

/**
 * Pull request numbers with a Conflict Worker or Refinement-round session
 * container Docker still counts as running, for one repository and kind —
 * the PR-scoped sibling of `liveContainerTickets` above, filtered by
 * `kind` so a live Refinement round is never mistaken for a live Conflict
 * Worker on the same PR or vice versa. Feeds `OpenAgentPr.conflictWorkerLive`
 * (issue #181) via `readScope`'s injectable `readLiveConflictPrs`.
 */
export async function liveContainerPrs(
  repository: string,
  kind: PrSessionKind,
  exec: Exec = realExec,
): Promise<Set<number>> {
  const { prSessions } = await liveContainers(repository, exec);
  const live = new Set<number>();
  for (const session of prSessions) {
    if (session.kind === kind) live.add(session.pr);
  }
  return live;
}
