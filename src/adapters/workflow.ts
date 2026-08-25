import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CONTRACT_FILE,
  type Contract,
  EMPTY_CONTRACT,
  parseContract,
  type VerifyCommandOutcome,
  type VerifyOutcome,
  verifyCommandOutcome,
  verifyOutcome,
} from "../core/workflow.js";

/**
 * `WORKFLOW.md` I/O: reading a target checkout's contract, and running the
 * commands it declares. The parsing itself is pure (core/workflow.ts); this
 * module is the filesystem read and the subprocess side of it.
 */

/** File-read half of the contract seam, injectable for tests. */
export type LoadContract = (cwd: string) => Promise<Contract>;

/** Read and parse the contract at a checkout's root; an absent file is a valid, empty contract. */
export const loadContract: LoadContract = async (cwd) => {
  let raw: string;
  try {
    raw = await readFile(join(cwd, CONTRACT_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return EMPTY_CONTRACT;
    }
    throw error;
  }
  return parseContract(raw);
};

/**
 * Raw-read half of the contract seam, injectable for tests: the file's exact
 * text rather than the parsed shape, `undefined` when it is absent. Exists
 * for `declare`'s regression refusal (issue #152), which restores
 * `WORKFLOW.md` byte-identical rather than re-deriving it from the parsed
 * `Contract` — `parseContract` throws away the Markdown body, so a
 * restoration built from it would silently drop the operator's own prose.
 */
export type ReadContractRaw = (cwd: string) => Promise<string | undefined>;

export const readContractRaw: ReadContractRaw = async (cwd) => {
  try {
    return await readFile(join(cwd, CONTRACT_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
};

/** Raw-write half of the same seam: overwrites `WORKFLOW.md` with exactly this text. */
export type WriteContractRaw = (cwd: string, raw: string) => Promise<void>;

export const writeContractRaw: WriteContractRaw = (cwd, raw) =>
  writeFile(join(cwd, CONTRACT_FILE), raw, "utf8");

/** Run one verify command through a shell in `cwd`, resolving with its exit code (never rejecting on a nonzero one). */
export type RunVerifyCommand = (
  command: string,
  cwd: string,
) => Promise<number | null>;

/**
 * A command that never even spawned (bad shell, missing interpreter) is not
 * a spawn-layer error to propagate: it is the same "never got a real exit
 * code" case a killed Worker process already models as `exitCode: null`
 * (`WorkerProcessExit`, `probeEnvironment`'s catch) — so it resolves `null`
 * rather than rejecting, and reads as a failed command (`ok: false`) instead
 * of aborting the whole Attempt over a broken `verify:` entry.
 */
export const realRunVerifyCommand: RunVerifyCommand = (command, cwd) =>
  new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      stdio: "ignore",
    });
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code));
  });

/** Load a checkout's contract and run every command its `verify:` map declares. */
export type RunContractVerify = (
  cwd: string,
) => Promise<VerifyOutcome | undefined>;

/**
 * Every declared `verify:` command, run once each against `cwd`, in
 * declaration order, folded into pass/fail from exit codes alone — never
 * from anything the Worker session said. `undefined` when the contract
 * declares no `verify:` commands at all (absent or empty), which is the
 * "no verify result, no error" case rather than a vacuous pass — a repo that
 * never declared a contract has nothing to carry.
 */
export async function runContractVerify(
  cwd: string,
  loadContractFn: LoadContract = loadContract,
  runVerifyCommand: RunVerifyCommand = realRunVerifyCommand,
): Promise<VerifyOutcome | undefined> {
  const contract = await loadContractFn(cwd);
  const entries = Object.entries(contract.verify);
  if (entries.length === 0) return undefined;

  const commands: VerifyCommandOutcome[] = [];
  for (const [name, command] of entries) {
    const exitCode = await runVerifyCommand(command, cwd);
    commands.push(verifyCommandOutcome(name, command, exitCode));
  }
  return verifyOutcome(commands);
}

/** Load a checkout's contract and run its `after_create` command, if it declares one. */
export type RunAfterCreate = (
  cwd: string,
) => Promise<number | null | undefined>;

/**
 * The declared `after_create` command, run once against `cwd` — `undefined`
 * when the contract declares none, the same "no result, not a vacuous pass"
 * shape `runContractVerify` gives an absent `verify:` map. Unlike `verify:`,
 * which runs after the session and gates nothing (issue #149), this runs
 * before it: a session container prepares its checkout with this before
 * starting the Worker's own session at all (issue #180, ADR 0009), so the
 * caller (`dispatchWorker`, adapters/worker.ts) treats a non-zero exit here
 * as failing the Attempt outright rather than as a fact to carry forward.
 */
export async function runAfterCreate(
  cwd: string,
  loadContractFn: LoadContract = loadContract,
  runVerifyCommand: RunVerifyCommand = realRunVerifyCommand,
): Promise<number | null | undefined> {
  const contract = await loadContractFn(cwd);
  if (contract.afterCreate === undefined) return undefined;
  return runVerifyCommand(contract.afterCreate, cwd);
}
