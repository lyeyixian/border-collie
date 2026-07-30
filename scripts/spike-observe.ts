//
// spike-observe.ts — reduce one spike job's captured evidence to a recorded
// observation. Throwaway, paired with .github/workflows/spike-oauth-longevity.yml.
// See issue #63 and .github/spike/README.md.
//
// The spike asks whether a subscription OAuth token survives a long headless
// run. The workflow captures the evidence; this reads it and says what
// happened, deliberately through the SAME classification the Orchestrator
// applies to real Worker deaths (src/core/classify.ts). That reuse is the
// point: if a death here classifies as `auth`, the identical evidence would
// void an Attempt and trip the circuit breaker in production.
//
// Usage — `--record` is whatever stream-json the runner gave back, Job A's
// transcript or Job B's execution file; every flag but --job/--runner/--out is
// optional, and an absent one is reported as unknown rather than guessed:
//
//   pnpm exec tsx scripts/spike-observe.ts \
//     --job A --runner "raw claude -p" \
//     --record   spike-evidence/transcript.jsonl \
//     --stderr   spike-evidence/stderr.log \
//     --exit-code 137 \
//     --elapsed-seconds 2700 \
//     --ceiling-seconds 2700 \
//     --model sonnet --max-turns 200 \
//     --out spike-evidence/observation.json
//
// Writes the observation as JSON to `--out` and a Markdown summary to stdout
// (the workflow tees that into the job summary). A dead session, an empty
// transcript, and a missing file are all findings rather than errors, so only a
// usage mistake exits non-zero.

import { readFileSync, writeFileSync } from "node:fs";
import {
  classifyInfrastructure,
  lastResultLine,
  parseResultEvent,
} from "../src/core/classify.js";

/** The question the spike exists to answer: does the token last past this? */
const SURVIVAL_THRESHOLD_SECONDS = 20 * 60;

/** Usage mistakes stop the run, and say so in one line rather than a stack. */
function fail(message: string): never {
  process.stderr.write(`spike-observe: ${message}\n`);
  process.exit(1);
}

/** `--key value` pairs; anything else is a usage error. */
function parseArgs(argv: string[]): Map<string, string> {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === undefined || !key.startsWith("--") || value === undefined) {
      fail(`bad argument at position ${i}: expected --key value`);
    }
    args.set(key.slice(2), value);
  }
  return args;
}

/** Missing files are evidence too — a job that died early may write none. */
function readOrEmpty(path: string | undefined): string {
  if (path === undefined) return "";
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/** How a runner chose to record the session's stream-json events. */
type RecordShape = "jsonl" | "json-array" | "empty" | "unrecognized";

/**
 * Both runners' records reduced to the JSONL the Orchestrator's parsers
 * expect, plus the shape they arrived in. Job A writes `claude`'s stdout
 * straight through, so it is already newline-delimited. `claude-code-action`
 * writes an execution file, and whether that file is JSONL, a single JSON
 * array, or something else entirely is itself one of the observations the
 * spike is here to make (user stories 11 and 12) — so the shape is reported
 * rather than assumed.
 */
function toStreamJsonLines(raw: string): {
  lines: string;
  shape: RecordShape;
  eventCount: number;
} {
  if (raw.trim() === "") return { lines: "", shape: "empty", eventCount: 0 };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return {
        lines: parsed.map((event) => JSON.stringify(event)).join("\n"),
        shape: "json-array",
        eventCount: parsed.length,
      };
    }
  } catch {}
  const events = raw
    .split("\n")
    .filter((line) => line.trim() !== "")
    .filter((line) => {
      try {
        JSON.parse(line);
        return true;
      } catch {
        return false;
      }
    });
  return events.length > 0
    ? { lines: events.join("\n"), shape: "jsonl", eventCount: events.length }
    : { lines: "", shape: "unrecognized", eventCount: 0 };
}

const args = parseArgs(process.argv.slice(2));
const required = (key: string): string =>
  args.get(key) ?? fail(`missing required --${key}`);
const asNumber = (key: string): number | null => {
  const value = args.get(key);
  if (value === undefined || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const job = required("job");
const runner = required("runner");
const outPath = required("out");
const elapsedSeconds = asNumber("elapsed-seconds");
const ceilingSeconds = asNumber("ceiling-seconds");
const exitCode = asNumber("exit-code");
// The settings the run actually used, recorded rather than assumed: the
// dispatch inputs are overridable, and a "pass" measured under a shortened
// ceiling or a smaller turn cap does not license a real Worker's 45 minutes.
const model = args.get("model") ?? null;
const maxTurns = asNumber("max-turns");

const { lines, shape, eventCount } = toStreamJsonLines(
  readOrEmpty(args.get("record")),
);
const stderr = readOrEmpty(args.get("stderr"));
const result = parseResultEvent(lines);
const resultLine = lastResultLine(lines);

// The Orchestrator's own rule, applied to the same two sources: stderr and the
// result line. Never the transcript body — a session that spends 20 minutes
// reading src/core/classify.ts quotes every one of these signatures back at us.
const infra = classifyInfrastructure(`${stderr}\n${resultLine}`);
// The same rule again, narrowed to stderr alone, so the finding can say where
// the evidence was rather than only that it existed. Deliberately not a second
// hand-written regex: two auth tests that disagree would undermine the whole
// premise that this is the production classification.
const stderrSignature = classifyInfrastructure(stderr);

// Elapsed time, not the exit code, decides this — Job B is killed by a step
// timeout and reports no exit code at all. It is the single distinction the
// whole spike turns on: a death at ~12 minutes is the token expiring, a death
// at the ceiling is the experiment running out of room.
const hitCeiling =
  ceilingSeconds !== null &&
  elapsedSeconds !== null &&
  elapsedSeconds >= ceilingSeconds;

// Same precedence dispatchWorker applies: a turn-cap halt trumps infrastructure,
// because a result event proves the environment carried the session to its own
// end whatever infra-looking noise the logs hold. A clean finish is read off the
// result event rather than the exit code, since Job B exposes no exit code at
// all — the event is the only evidence both runners can produce.
const verdict =
  result?.subtype === "error_max_turns"
    ? "turn-cap-halt"
    : infra === "auth"
      ? "auth-failure"
      : infra !== undefined
        ? `infra-${infra}`
        : result?.subtype === "success"
          ? "clean-finish"
          : hitCeiling
            ? "wall-clock-ceiling"
            : "died-unclassified";

// The headline, and deliberately three-valued. A run killed by the 45-minute
// ceiling still answers the question — the token lasted the whole time — so
// survival is measured on elapsed time, not on a clean exit. But a session that
// simply finished its work in fifteen minutes proves nothing either way, and
// reporting that as "no" would read as a token failure it never observed.
const tokenSurvival: "yes" | "no" | "inconclusive" =
  infra === "auth"
    ? "no"
    : elapsedSeconds !== null && elapsedSeconds >= SURVIVAL_THRESHOLD_SECONDS
      ? "yes"
      : "inconclusive";

const observation = {
  job,
  runner,
  verdict,
  tokenSurvival,
  survivalThresholdSeconds: SURVIVAL_THRESHOLD_SECONDS,
  elapsedSeconds,
  ceilingSeconds,
  hitCeiling,
  exitCode,
  stepOutcome: args.get("step-outcome") ?? null,
  // What the run was actually configured with, so a weakened run cannot be
  // read back as a pass at production settings.
  model,
  maxTurns,
  // Whether the session ended on its own terms, and how it said it ended.
  terminatingResultEvent: result !== undefined,
  resultSubtype: result?.subtype ?? null,
  turns: result?.numTurns ?? null,
  costUsd: result?.totalCostUsd ?? null,
  // What the Orchestrator's classifier makes of the death, if it died.
  infraSignature: infra ?? null,
  stderrSignature: stderrSignature ?? null,
  // What this runner gives back — the observability half of the question.
  recordShape: shape,
  streamJsonEvents: eventCount,
  stderrCaptured: args.get("stderr") !== undefined,
  stderrBytes: Buffer.byteLength(stderr),
  resultLinePresent: resultLine !== "",
};

writeFileSync(outPath, `${JSON.stringify(observation, null, 2)}\n`);

const row = (label: string, value: unknown) =>
  `| ${label} | ${value === null ? "—" : String(value)} |`;
process.stdout.write(
  [
    `## Job ${job} — ${runner}`,
    "",
    "| Observation | Value |",
    "| --- | --- |",
    row("Verdict", verdict),
    row(
      `Token survived ${SURVIVAL_THRESHOLD_SECONDS / 60}+ min`,
      tokenSurvival,
    ),
    row("Elapsed at exit (s)", elapsedSeconds),
    row("Hit wall-clock ceiling", hitCeiling ? "yes" : "no"),
    row("Process exit code", exitCode),
    row("Step outcome", observation.stepOutcome),
    row("Ran as", `${model ?? "?"}, max ${maxTurns ?? "?"} turns`),
    row(
      "Terminating result event",
      observation.terminatingResultEvent ? "yes" : "no",
    ),
    row("Result subtype", observation.resultSubtype),
    row("Turns", observation.turns),
    row("Cost (USD)", observation.costUsd),
    row(
      "classifyInfrastructure(stderr + result line)",
      observation.infraSignature,
    ),
    row("classifyInfrastructure(stderr alone)", observation.stderrSignature),
    row("Record shape", `${shape} (${eventCount} events)`),
    row(
      "stderr captured separately",
      observation.stderrCaptured
        ? `yes (${observation.stderrBytes} bytes)`
        : "no",
    ),
    "",
  ].join("\n"),
);
