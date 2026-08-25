/**
 * The repository contract (`WORKFLOW.md`, issue #149): Markdown with YAML
 * front matter, naming three top-level keys. `after_create` is a single
 * shell script string that prepares a checkout; `verify` is a flat map of
 * name to command string, naming commands with meaningful exit codes;
 * `dockerfile` names the path to the repository's own Dockerfile, the
 * session container is built from (issue #180). The Markdown body is prose
 * for humans — nothing here reads it, and no function in this module ever
 * returns it.
 *
 * Parsing is pure functions over a string: front-matter split, key
 * validation, and the flat map shape. No YAML library — the grammar this
 * contract needs (a handful of top-level keys, one nested flat map, one
 * literal block scalar) is a narrow enough subset that a hand-rolled,
 * indentation-driven reader is simpler than a dependency, in the same spirit
 * as `tests/helpers/workflow-template.ts`'s hand-rolled `run-name` reader.
 */

import { RUN_DIR } from "./types.js";

export class ContractError extends Error {}

/** File name looked up at the target repo's root. */
export const CONTRACT_FILE = "WORKFLOW.md";

/**
 * The parsed contract: `afterCreate` and `dockerfile` undefined when their
 * key is absent, `verify` an empty map when the key is absent or declared
 * empty — all three are accepted states, not errors (see `parseContract`).
 */
export interface Contract {
  afterCreate: string | undefined;
  verify: Record<string, string>;
  dockerfile: string | undefined;
}

/** The contract a repository with no `WORKFLOW.md`, or an empty one, resolves to. */
export const EMPTY_CONTRACT: Contract = {
  afterCreate: undefined,
  verify: {},
  dockerfile: undefined,
};

/** One verify command's outcome, exit code only — never the session's report. */
export interface VerifyCommandOutcome {
  name: string;
  command: string;
  exitCode: number | null;
  ok: boolean;
}

/** Every declared verify command's outcome, and the all-passed predicate. */
export interface VerifyOutcome {
  commands: VerifyCommandOutcome[];
  ok: boolean;
}

const AFTER_CREATE_KEY = "after_create";
const VERIFY_KEY = "verify";
const DOCKERFILE_KEY = "dockerfile";

/**
 * Symphony's other three lifecycle hooks (ADR context: this repository
 * contract keeps `after_create`'s name for that continuity). Rejected rather
 * than ignored for forward compatibility: under a fresh checkout per Attempt
 * they would silently do nothing, and a key that silently does nothing is
 * worse than a key that is refused.
 */
const FORWARD_COMPAT_HOOK_KEYS = new Set([
  "before_run",
  "after_run",
  "before_remove",
]);

const FRONT_MATTER_PATTERN = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/;

/** The leading YAML front-matter block, or undefined when the source declares none. */
function splitFrontMatter(source: string): string | undefined {
  return FRONT_MATTER_PATTERN.exec(source)?.[1];
}

interface TopEntry {
  key: string;
  /** Text after the key's colon, trimmed — empty when the value is on following indented lines. */
  inline: string;
  /** Raw lines indented under this key, in source order. */
  children: string[];
}

const TOP_KEY_PATTERN = /^([A-Za-z_][A-Za-z0-9_-]*):[ \t]*(.*)$/;

/**
 * Group a block of lines into top-level `key: value` entries, everything
 * indented under a key collected as that entry's raw `children`. Throws when
 * a line at zero indent is not a `key:` line, or an indented line appears
 * before any key has been seen — both mean the block is not a mapping at
 * all, which is this function's only notion of "not a map" (a plain scalar
 * or a `- ` sequence item are both non-matches).
 */
function topLevelEntries(lines: string[]): TopEntry[] {
  const entries: TopEntry[] = [];
  let current: TopEntry | undefined;
  for (const line of lines) {
    if (line.trim() === "") {
      current?.children.push(line);
      continue;
    }
    const indent = line.length - line.trimStart().length;
    if (indent === 0) {
      const match = TOP_KEY_PATTERN.exec(line);
      if (!match) {
        throw new ContractError(
          `${CONTRACT_FILE} front matter must be a mapping of keys to values, not "${line.trim()}"`,
        );
      }
      current = {
        key: match[1] as string,
        inline: (match[2] as string).trim(),
        children: [],
      };
      entries.push(current);
    } else if (current === undefined) {
      throw new ContractError(
        `${CONTRACT_FILE} front matter must be a mapping of keys to values, not "${line.trim()}"`,
      );
    } else {
      current.children.push(line);
    }
  }
  return entries;
}

/** Strip matching wrapping quotes off an inline scalar; anything else passes through as written. */
function unquote(raw: string): string {
  if (raw.length < 2) return raw;
  const first = raw[0];
  const last = raw[raw.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return raw.slice(1, -1);
  }
  return raw;
}

/** Strip the common leading indentation off a block of lines; blank lines stay blank. */
function dedent(lines: string[]): string[] {
  const nonBlank = lines.filter((line) => line.trim() !== "");
  const indent =
    nonBlank.length === 0
      ? 0
      : Math.min(
          ...nonBlank.map((line) => line.length - line.trimStart().length),
        );
  return lines.map((line) => (line.trim() === "" ? "" : line.slice(indent)));
}

/** A literal block scalar's text: dedented, trailing blank lines clipped, newline-joined. */
function blockScalar(lines: string[]): string {
  const dedented = dedent(lines);
  while (dedented.length > 0 && dedented[dedented.length - 1] === "") {
    dedented.pop();
  }
  return dedented.join("\n");
}

/** Resolve one entry as a scalar string: inline, or a `|` literal block over its children. */
function resolveScalar(entry: TopEntry): string {
  if (entry.children.length === 0) return unquote(entry.inline);
  if (entry.inline !== "" && entry.inline !== "|") {
    throw new ContractError(
      `${CONTRACT_FILE} front matter key "${entry.key}" must be a single scalar string, not a mapping`,
    );
  }
  return blockScalar(entry.children);
}

/** Resolve one entry as a flat map of name to command string (the `verify:` shape). */
function resolveFlatMap(entry: TopEntry): Record<string, string> {
  if (entry.inline !== "") {
    throw new ContractError(
      `${CONTRACT_FILE} front matter key "${entry.key}" must be a mapping, not a scalar value`,
    );
  }
  if (entry.children.length === 0) return {};
  const map: Record<string, string> = {};
  for (const child of topLevelEntries(dedent(entry.children))) {
    if (child.children.length > 0) {
      throw new ContractError(
        `${CONTRACT_FILE} front matter key "${entry.key}.${child.key}" must be a single command string`,
      );
    }
    map[child.key] = unquote(child.inline);
  }
  return map;
}

/**
 * Parse a `WORKFLOW.md` file's raw content into a `Contract`. No front
 * matter, or front matter that is entirely blank, parses as `EMPTY_CONTRACT`
 * rather than failing — an unonboarded or freshly-onboarded-with-nothing
 * repository is a valid state, not an error. Every other shape either
 * resolves the three known keys or throws `ContractError` naming the
 * offending key: an unsupported key, one of the three forward-compat hook
 * keys, or front matter that is not a mapping at all.
 */
export function parseContract(source: string): Contract {
  const frontMatter = splitFrontMatter(source);
  if (frontMatter === undefined || frontMatter.trim() === "") {
    return EMPTY_CONTRACT;
  }

  let afterCreate: string | undefined;
  let verify: Record<string, string> = {};
  let dockerfile: string | undefined;
  for (const entry of topLevelEntries(frontMatter.split(/\r?\n/))) {
    if (entry.key === AFTER_CREATE_KEY) {
      afterCreate = resolveScalar(entry);
    } else if (entry.key === VERIFY_KEY) {
      verify = resolveFlatMap(entry);
    } else if (entry.key === DOCKERFILE_KEY) {
      dockerfile = resolveScalar(entry);
    } else if (FORWARD_COMPAT_HOOK_KEYS.has(entry.key)) {
      throw new ContractError(
        `${CONTRACT_FILE} declares "${entry.key}", which border-collie does not act on yet — a fresh checkout per Attempt makes it a no-op, so it is rejected rather than silently ignored`,
      );
    } else {
      throw new ContractError(
        `${CONTRACT_FILE} front matter has an unsupported key "${entry.key}"`,
      );
    }
  }
  return { afterCreate, verify, dockerfile };
}

/**
 * A declared Dockerfile's resolved path, and whether `WORKFLOW.md` named it
 * itself (issue #180). `declared` is what tells the container-build seam
 * (adapters/container.ts) how to treat a path that turns out not to exist:
 * a repository that named a path and does not have it there is a broken
 * declaration (a named error); a repository that named nothing has simply
 * declared no Dockerfile, and the fallback path not existing is the
 * ordinary case for it — see "runs on the base image" (CONTEXT.md "Session
 * container").
 */
export interface DockerfileResolution {
  path: string;
  declared: boolean;
}

/**
 * The path a repository's Dockerfile is looked up at, relative to its own
 * root: `contract.dockerfile` verbatim when declared, or a fixed default
 * under the fleet's own directory (`RUN_DIR`) otherwise — never the
 * repository's root `Dockerfile`, which is deliberately not used by
 * convention (it is usually the application's own production image, built
 * to ship the application rather than to run an agent in it). Pure: no
 * filesystem read happens here, only the path a caller should check.
 */
export const DEFAULT_DOCKERFILE_PATH = `${RUN_DIR}/Dockerfile`;

export function resolveDockerfilePath(
  declared: string | undefined,
): DockerfileResolution {
  return declared === undefined
    ? { path: DEFAULT_DOCKERFILE_PATH, declared: false }
    : { path: declared, declared: true };
}

/** Turn one verify command's exit code into its outcome. */
export function verifyCommandOutcome(
  name: string,
  command: string,
  exitCode: number | null,
): VerifyCommandOutcome {
  return { name, command, exitCode, ok: exitCode === 0 };
}

/** Every declared command's outcome, folded into the all-passed predicate. */
export function verifyOutcome(commands: VerifyCommandOutcome[]): VerifyOutcome {
  return { commands, ok: commands.every((command) => command.ok) };
}
