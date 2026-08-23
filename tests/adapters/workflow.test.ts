import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadContract,
  readContractRaw,
  realRunVerifyCommand,
  runContractVerify,
  writeContractRaw,
} from "../../src/adapters/workflow.js";
import type { Contract } from "../../src/core/workflow.js";

function tmpRepo(): string {
  return mkdtempSync(join(tmpdir(), "border-collie-workflow-test-"));
}

describe("loadContract", () => {
  it("reads and parses WORKFLOW.md at the checkout's root", async () => {
    const dir = tmpRepo();
    writeFileSync(
      join(dir, "WORKFLOW.md"),
      ["---", "verify:", "  test: pnpm test", "---"].join("\n"),
    );

    const contract = await loadContract(dir);

    expect(contract.verify).toEqual({ test: "pnpm test" });
  });

  it("is the empty contract when the repo has no WORKFLOW.md", async () => {
    const dir = tmpRepo();

    const contract = await loadContract(dir);

    expect(contract).toEqual({ afterCreate: undefined, verify: {} });
  });
});

describe("readContractRaw", () => {
  it("reads WORKFLOW.md's exact text, prose body included", async () => {
    const dir = tmpRepo();
    const source = [
      "---",
      "verify:",
      "  test: pnpm test",
      "---",
      "",
      "# Notes",
      "some prose a parsed Contract never carries",
      "",
    ].join("\n");
    writeFileSync(join(dir, "WORKFLOW.md"), source);

    await expect(readContractRaw(dir)).resolves.toBe(source);
  });

  it("is undefined when the repo has no WORKFLOW.md", async () => {
    const dir = tmpRepo();

    await expect(readContractRaw(dir)).resolves.toBeUndefined();
  });
});

describe("writeContractRaw", () => {
  it("writes WORKFLOW.md with exactly the given text", async () => {
    const dir = tmpRepo();

    await writeContractRaw(dir, "---\nverify:\n  test: pnpm test\n---\n");

    expect(readFileSync(join(dir, "WORKFLOW.md"), "utf8")).toBe(
      "---\nverify:\n  test: pnpm test\n---\n",
    );
  });

  it("overwrites an existing WORKFLOW.md", async () => {
    const dir = tmpRepo();
    writeFileSync(join(dir, "WORKFLOW.md"), "---\nverify:\n  old: x\n---\n");

    await writeContractRaw(dir, "---\nverify:\n  new: y\n---\n");

    expect(readFileSync(join(dir, "WORKFLOW.md"), "utf8")).toBe(
      "---\nverify:\n  new: y\n---\n",
    );
  });
});

describe("realRunVerifyCommand", () => {
  it("resolves null, rather than rejecting, when the command can never even spawn", async () => {
    await expect(
      realRunVerifyCommand("true", "/no/such/directory/at-all"),
    ).resolves.toBeNull();
  });
});

describe("runContractVerify", () => {
  it("is undefined for a contract with no verify commands, and never touches the command runner", async () => {
    const loadContractFn = async (): Promise<Contract> => ({
      afterCreate: undefined,
      verify: {},
    });
    let ran = false;
    const runVerifyCommand = async () => {
      ran = true;
      return 0;
    };

    const result = await runContractVerify(
      "/repo",
      loadContractFn,
      runVerifyCommand,
    );

    expect(result).toBeUndefined();
    expect(ran).toBe(false);
  });

  it("runs every declared command in cwd, deriving pass/fail from exit codes alone", async () => {
    const loadContractFn = async (): Promise<Contract> => ({
      afterCreate: undefined,
      verify: { lint: "pnpm lint", test: "pnpm test" },
    });
    const calls: Array<{ command: string; cwd: string }> = [];
    const runVerifyCommand = async (command: string, cwd: string) => {
      calls.push({ command, cwd });
      return command === "pnpm lint" ? 0 : 1;
    };

    const result = await runContractVerify(
      "/repo/worktree",
      loadContractFn,
      runVerifyCommand,
    );

    expect(calls).toEqual([
      { command: "pnpm lint", cwd: "/repo/worktree" },
      { command: "pnpm test", cwd: "/repo/worktree" },
    ]);
    expect(result).toEqual({
      ok: false,
      commands: [
        { name: "lint", command: "pnpm lint", exitCode: 0, ok: true },
        { name: "test", command: "pnpm test", exitCode: 1, ok: false },
      ],
    });
  });

  it("is ok when every declared command exits zero", async () => {
    const loadContractFn = async (): Promise<Contract> => ({
      afterCreate: undefined,
      verify: { build: "pnpm build" },
    });

    const result = await runContractVerify(
      "/repo",
      loadContractFn,
      async () => 0,
    );

    expect(result?.ok).toBe(true);
  });

  it("wires the real reader and the real shell end to end", async () => {
    const dir = tmpRepo();
    writeFileSync(
      join(dir, "WORKFLOW.md"),
      ["---", "verify:", "  pass: true", "  fail: false", "---"].join("\n"),
    );

    const result = await runContractVerify(
      dir,
      loadContract,
      realRunVerifyCommand,
    );

    expect(result).toEqual({
      ok: false,
      commands: [
        { name: "pass", command: "true", exitCode: 0, ok: true },
        { name: "fail", command: "false", exitCode: 1, ok: false },
      ],
    });
  });
});
