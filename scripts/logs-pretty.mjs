#!/usr/bin/env node
//
// logs-pretty.mjs — replay a durable run log as pretty, level-filtered output.
//
// tslog ships a `tslog` bin that does exactly this, but it never runs from
// `node_modules/.bin` on any package manager. Its entry-point guard compares
// `import.meta.url` against `process.argv[1]`, and a symlink always sits
// between the two: under npm the `.bin` entry is itself the symlink, under
// pnpm the `node_modules/tslog` directory is. Node resolves symlinks for
// `import.meta.url` and not for `argv[1]`, so the guard is always false and
// `npx tslog` exits 0 having printed nothing.
//
// The rendering here is still tslog's own — this calls the same `runCli` the
// bin would, through the public `tslog/cli` subpath. Only the entry point is
// ours, which is the part that was broken. See issue #47.
//
// Usage:
//   pnpm logs:pretty                    # newest log under .border-collie/logs
//   pnpm logs:pretty <file.jsonl>
//   cat <file.jsonl> | pnpm logs:pretty
//
// Flags are tslog's and pass straight through: `-l`/`--level <name|id>` to
// filter, `--color`/`--no-color` to override TTY detection.
//
//   pnpm logs:pretty --level warn

import { createReadStream, fstatSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { parseCliArgs, runCli } from "tslog/cli";

// Mirrors RUN_DIR in src/adapters/worker.ts. Duplicated rather than imported
// so this stays a plain node script with no build step; if the run directory
// ever moves, this fails loudly with the message below rather than silently.
const LOGS_DIR = join(".border-collie", "logs");

/**
 * Split argv into tslog's flags and the optional file path. `parseCliArgs`
 * ignores anything it does not recognize, so it gets the whole array; we only
 * need to know which bare word is a path, skipping the value `--level` takes.
 */
function splitArgs(argv) {
  const paths = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-l" || arg === "--level") {
      i++;
    } else if (!arg.startsWith("-")) {
      paths.push(arg);
    }
  }
  return { options: parseCliArgs(argv), path: paths[0] };
}

/**
 * The newest log under the run directory — the run you just watched. File
 * names are ISO start times, so lexical order is chronological order.
 */
async function newestLog() {
  let entries;
  try {
    entries = await readdir(LOGS_DIR);
  } catch {
    throw new Error(
      `no ${LOGS_DIR} directory yet — run border-collie first, or pass a file path`,
    );
  }
  const newest = entries
    .filter((entry) => entry.endsWith(".jsonl"))
    .sort()
    .at(-1);
  if (newest === undefined) {
    throw new Error(`no .jsonl logs in ${LOGS_DIR} — pass a file path`);
  }
  return join(LOGS_DIR, newest);
}

/**
 * Whether someone actually fed us bytes: stdin is a pipe or a redirected file.
 * `isTTY` alone is not enough — under a CI runner or a non-interactive shell
 * stdin is an empty character device, and reading it would print nothing at
 * all, which is the exact silent failure this script exists to replace.
 */
function stdinIsFed() {
  try {
    const stats = fstatSync(0);
    return stats.isFIFO() || stats.isFile();
  } catch {
    return false;
  }
}

/** An explicit path wins; then a pipe; then the newest log on disk. */
async function resolveInput(path) {
  if (path !== undefined) {
    return createReadStream(path);
  }
  if (stdinIsFed()) {
    return process.stdin;
  }
  const newest = await newestLog();
  // Named on stderr so stdout stays pipeable, and so an auto-picked file is
  // never a mystery when it turns out to be the wrong run.
  process.stderr.write(`logs-pretty: replaying ${newest}\n`);
  return createReadStream(newest);
}

const { options, path } = splitArgs(process.argv.slice(2));

try {
  await runCli(await resolveInput(path), process.stdout, options);
} catch (error) {
  process.stderr.write(
    `logs-pretty: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
