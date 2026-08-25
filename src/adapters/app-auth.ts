import { execFile } from "node:child_process";
import { createPrivateKey, createSign, type KeyObject } from "node:crypto";
import { promisify } from "node:util";
import { AppAuthError, buildAppJwtClaims } from "../core/app-auth.js";
import type { Exec } from "./tracker.js";

/**
 * GitHub App authentication (issue #178): the I/O half. Signs the JWT that
 * asserts the App's own identity, exchanges it for an installation access
 * token scoped to exactly one repository, and reads the fleet — the set of
 * repositories the App is installed on — straight from GitHub rather than a
 * list border-collie stores. The App private key never leaves this process:
 * only the short-lived token this module mints crosses into a Worker (and
 * even that is kept out of a Worker's *environment* — see
 * `core/app-auth.ts`'s `stripAppPrivateKey`).
 */

const execFileAsync = promisify(execFile);

function base64url(input: string | Buffer): string {
  const buffer = typeof input === "string" ? Buffer.from(input) : input;
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Signs a GitHub App JWT (RS256) from the App's id and private key. The
 * private key is validated here rather than left to fail deep inside
 * `node:crypto`'s own error, so a missing or malformed key is a named
 * `AppAuthError` (issue #178) rather than an opaque crash.
 */
export function signAppJwt(
  appId: string,
  privateKeyPem: string | undefined,
  nowMs: number,
): string {
  if (privateKeyPem === undefined || privateKeyPem.trim() === "") {
    throw new AppAuthError("missing GitHub App private key");
  }
  let key: KeyObject;
  try {
    key = createPrivateKey(privateKeyPem);
  } catch (error) {
    throw new AppAuthError(
      `malformed GitHub App private key: ${(error as Error).message}`,
    );
  }
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify(buildAppJwtClaims(appId, nowMs)));
  const signingInput = `${header}.${payload}`;
  const signature = base64url(
    createSign("RSA-SHA256").update(signingInput).sign(key),
  );
  return `${signingInput}.${signature}`;
}

/** The subprocess boundary `execWithToken` drives, injectable for tests — mirrors `adapters/tracker.ts`'s `Exec`, plus the env a real call needs to carry the token in. */
export type ExecWithEnv = (
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
) => Promise<string>;

export const realExecWithEnv: ExecWithEnv = async (cmd, args, env) => {
  const { stdout } = await execFileAsync(cmd, args, {
    maxBuffer: 64 * 1024 * 1024,
    env,
  });
  return stdout;
};

/**
 * An `Exec` (adapters/tracker.ts) that authenticates every gh call it drives
 * with a GitHub App installation token, via `GH_TOKEN` — gh's own documented
 * override, read ahead of any stored `gh auth login` session — instead of
 * the ambient shell's credentials. Building one never mutates `process.env`
 * itself, so a concurrent call authenticated a different way is unaffected.
 */
export function execWithToken(
  token: string,
  exec: ExecWithEnv = realExecWithEnv,
): Exec {
  return (cmd, args) => exec(cmd, args, { ...process.env, GH_TOKEN: token });
}

/** `fetch`'s own type, injectable for tests. */
export type Fetch = typeof fetch;

export const realFetch: Fetch = fetch;

export interface AppCredentials {
  /** The GitHub App's own id (the JWT's `iss` claim). */
  appId: string;
  privateKey: string | undefined;
}

export interface RepositoryRef {
  owner: string;
  name: string;
}

/** `"owner/name"`, as the daemon's fleet scheduler (core/fleet.ts) names a repository. */
export function repositoryFullName(repository: RepositoryRef): string {
  return `${repository.owner}/${repository.name}`;
}

/** The inverse of `repositoryFullName`, for a fleet member the scheduler hands back to mint a token against. */
export function parseRepositoryFullName(fullName: string): RepositoryRef {
  const slash = fullName.indexOf("/");
  return { owner: fullName.slice(0, slash), name: fullName.slice(slash + 1) };
}

export interface InstallationToken {
  token: string;
  expiresAt: string;
}

const API_ROOT = "https://api.github.com";

const API_HEADERS: Record<string, string> = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "border-collie",
};

/** GET/POST against the GitHub REST API, with a named `AppAuthError` on anything but a 2xx — never a bare fetch rejection or a JSON parse crash on an HTML error page. */
async function githubJson<T>(
  url: string,
  init: RequestInit,
  fetchImpl: Fetch,
): Promise<T> {
  const response = await fetchImpl(url, {
    ...init,
    headers: { ...API_HEADERS, ...init.headers },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new AppAuthError(
      `GitHub App API request failed: ${init.method ?? "GET"} ${url} -> ${response.status} ${body}`,
    );
  }
  return (await response.json()) as T;
}

interface InstallationRef {
  id: number;
}

interface RawInstallationToken {
  token: string;
  expires_at: string;
}

function mintInstallationToken(
  jwt: string,
  installationId: number,
  repositoryNames: string[] | undefined,
  fetchImpl: Fetch,
): Promise<InstallationToken> {
  const init: RequestInit = {
    method: "POST",
    headers: {
      Authorization: `Bearer ${jwt}`,
      "Content-Type": "application/json",
    },
  };
  if (repositoryNames !== undefined) {
    init.body = JSON.stringify({ repositories: repositoryNames });
  }
  return githubJson<RawInstallationToken>(
    `${API_ROOT}/app/installations/${installationId}/access_tokens`,
    init,
    fetchImpl,
  ).then((raw) => ({ token: raw.token, expiresAt: raw.expires_at }));
}

/**
 * Mints an installation access token scoped to exactly one repository
 * (issue #178 acceptance criteria): the mint request names only that
 * repository, so a request made with the returned token against any other
 * repository is refused by GitHub itself — a token minted for one Attempt
 * cannot touch another. That refusal is GitHub's own enforcement, not this
 * function's, so the test for it asserts the one thing on this side of the
 * seam: the mint request names exactly the repository asked for.
 */
export async function mintRepositoryToken(
  credentials: AppCredentials,
  repository: RepositoryRef,
  now: number,
  fetchImpl: Fetch = realFetch,
): Promise<InstallationToken> {
  const jwt = signAppJwt(credentials.appId, credentials.privateKey, now);
  const installation = await githubJson<InstallationRef>(
    `${API_ROOT}/repos/${repository.owner}/${repository.name}/installation`,
    { headers: { Authorization: `Bearer ${jwt}` } },
    fetchImpl,
  );
  return mintInstallationToken(
    jwt,
    installation.id,
    [repository.name],
    fetchImpl,
  );
}

const REPOSITORIES_PER_PAGE = 100;

interface RawRepositoriesPage {
  repositories: { name: string; owner: { login: string } }[];
}

async function listRepositoriesFor(
  token: string,
  fetchImpl: Fetch,
): Promise<RepositoryRef[]> {
  const repositories: RepositoryRef[] = [];
  for (let page = 1; ; page += 1) {
    const result = await githubJson<RawRepositoriesPage>(
      `${API_ROOT}/installation/repositories?per_page=${REPOSITORIES_PER_PAGE}&page=${page}`,
      { headers: { Authorization: `Bearer ${token}` } },
      fetchImpl,
    );
    repositories.push(
      ...result.repositories.map((repo) => ({
        owner: repo.owner.login,
        name: repo.name,
      })),
    );
    if (result.repositories.length < REPOSITORIES_PER_PAGE) break;
  }
  return repositories;
}

/**
 * The fleet's repositories (issue #178 acceptance criteria), read from the
 * App's own installations rather than anything border-collie stores:
 * installing the App on a repository is how the operator adds it, and
 * uninstalling is how they remove it — there is no second list to drift.
 */
export async function listFleetRepositories(
  credentials: AppCredentials,
  now: number,
  fetchImpl: Fetch = realFetch,
): Promise<RepositoryRef[]> {
  const jwt = signAppJwt(credentials.appId, credentials.privateKey, now);
  const installations = await githubJson<InstallationRef[]>(
    `${API_ROOT}/app/installations?per_page=${REPOSITORIES_PER_PAGE}`,
    { headers: { Authorization: `Bearer ${jwt}` } },
    fetchImpl,
  );
  const repositories: RepositoryRef[] = [];
  for (const installation of installations) {
    const { token } = await mintInstallationToken(
      jwt,
      installation.id,
      undefined,
      fetchImpl,
    );
    repositories.push(...(await listRepositoriesFor(token, fetchImpl)));
  }
  return repositories;
}
