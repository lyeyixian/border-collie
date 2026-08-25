import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkoutPath,
  type ExecFile,
  ensureCheckout,
  execAtRepo,
} from "../../src/adapters/checkout.js";
import { APP_PRIVATE_KEY_ENV } from "../../src/core/app-auth.js";

function fakeExecFile(stdout = ""): {
  execFileFn: ExecFile;
  calls: { cmd: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }[];
} {
  const calls: {
    cmd: string;
    args: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
  }[] = [];
  const execFileFn: ExecFile = async (cmd, args, options) => {
    calls.push({ cmd, args, cwd: options.cwd, env: options.env });
    return stdout;
  };
  return { execFileFn, calls };
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "border-collie-checkout-test-"));
}

describe("execAtRepo", () => {
  it("runs every command with the repository's own checkout directory as cwd and GH_TOKEN set", async () => {
    const { execFileFn, calls } = fakeExecFile("ok");
    const exec = execAtRepo("/repos/acme__widget", "ghs_scoped", execFileFn);

    await expect(exec("git", ["fetch", "origin"])).resolves.toBe("ok");

    expect(calls).toEqual([
      {
        cmd: "git",
        args: ["fetch", "origin"],
        cwd: "/repos/acme__widget",
        env: expect.objectContaining({ GH_TOKEN: "ghs_scoped" }),
      },
    ]);
  });

  it("never forwards the GitHub App private key to the spawned process", async () => {
    const before = process.env[APP_PRIVATE_KEY_ENV];
    process.env[APP_PRIVATE_KEY_ENV] = "-----BEGIN PRIVATE KEY-----secret";
    try {
      const { execFileFn, calls } = fakeExecFile();
      const exec = execAtRepo("/repos/acme__widget", "ghs_scoped", execFileFn);

      await exec("git", ["status"]);

      expect(calls[0]?.env[APP_PRIVATE_KEY_ENV]).toBeUndefined();
    } finally {
      if (before === undefined) delete process.env[APP_PRIVATE_KEY_ENV];
      else process.env[APP_PRIVATE_KEY_ENV] = before;
    }
  });
});

describe("checkoutPath", () => {
  it("names a repository's checkout under the daemon's state directory, slash replaced", () => {
    expect(checkoutPath("/state/repos", "acme/widget")).toBe(
      "/state/repos/acme__widget",
    );
  });
});

describe("ensureCheckout", () => {
  it("creates the daemon's own state directory on a fresh host, before cloning into it", async () => {
    // A brand-new operator host: the state directory itself (the daemon's
    // `--state-dir`, default `~/.border-collie`) has never been created,
    // unlike every other test here which pre-creates it via `tempDir()`.
    const reposDir = join(tempDir(), "not-yet-created");
    expect(existsSync(reposDir)).toBe(false);
    const { execFileFn, calls } = fakeExecFile();

    const dir = await ensureCheckout(
      reposDir,
      "acme/widget",
      "ghs_scoped",
      execFileFn,
    );

    // Real `execFile` throws ENOENT for a `cwd` that doesn't exist — a fake
    // exec wouldn't catch that, so the state directory's own existence is
    // what this test actually verifies fixes the bug.
    expect(existsSync(reposDir)).toBe(true);
    expect(dir).toBe(checkoutPath(reposDir, "acme/widget"));
    expect(calls).toEqual([
      {
        cmd: "gh",
        args: ["repo", "clone", "acme/widget", dir],
        cwd: reposDir,
        env: expect.objectContaining({ GH_TOKEN: "ghs_scoped" }),
      },
    ]);
  });

  it("clones a repository it has never checked out before", async () => {
    const reposDir = tempDir();
    const { execFileFn, calls } = fakeExecFile();

    const dir = await ensureCheckout(
      reposDir,
      "acme/widget",
      "ghs_scoped",
      execFileFn,
    );

    expect(dir).toBe(checkoutPath(reposDir, "acme/widget"));
    expect(calls).toEqual([
      {
        cmd: "gh",
        args: ["repo", "clone", "acme/widget", dir],
        cwd: reposDir,
        env: expect.objectContaining({ GH_TOKEN: "ghs_scoped" }),
      },
    ]);
  });

  it("fetches and hard-resets to the remote default branch for an already-checked-out repository", async () => {
    const reposDir = tempDir();
    const dir = checkoutPath(reposDir, "acme/widget");
    mkdirSync(dir, { recursive: true });
    const { execFileFn, calls } = fakeExecFile();

    const result = await ensureCheckout(
      reposDir,
      "acme/widget",
      "ghs_scoped",
      execFileFn,
    );

    expect(result).toBe(dir);
    expect(calls).toEqual([
      {
        cmd: "git",
        args: ["fetch", "origin"],
        cwd: dir,
        env: expect.objectContaining({ GH_TOKEN: "ghs_scoped" }),
      },
      {
        cmd: "git",
        args: ["reset", "--hard", "origin/HEAD"],
        cwd: dir,
        env: expect.objectContaining({ GH_TOKEN: "ghs_scoped" }),
      },
    ]);
  });
});
