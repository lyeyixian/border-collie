//
// spike-decide.ts — apply the spike's decision rule to both jobs' observations
// and emit the finding, ready to paste onto issue #63. Throwaway, paired with
// .github/workflows/spike-oauth-longevity.yml. See .github/spike/README.md.
//
// The two jobs observe themselves in isolation; the decision the spike gates is
// about the pair. This is the only place the rule from the issue is executed
// rather than described, so that the recommendation the migration spec cites
// cannot drift from the evidence it was drawn from.
//
// Usage:
//   pnpm exec tsx scripts/spike-decide.ts \
//     --a job-a/observation.json \
//     --b job-b/observation.json \
//     --out finding.md
//
// The recommendation is a starting point for the operator, not the last word:
// an `inconclusive` run means the experiment did not answer its question and
// should be re-run, not that the substrate is broken.

import { readFileSync, writeFileSync } from "node:fs";

/** The subset of an observation this rule turns on. */
interface Observation {
  job: string;
  runner: string;
  verdict: string;
  tokenSurvival: "yes" | "no" | "inconclusive";
  elapsedSeconds: number | null;
  infraSignature: string | null;
  model: string | null;
  maxTurns: number | null;
  terminatingResultEvent: boolean;
  recordShape: string;
  stderrCaptured: boolean;
}

function fail(message: string): never {
  process.stderr.write(`spike-decide: ${message}\n`);
  process.exit(1);
}

/**
 * A job that never wrote an observation is a job whose evidence was lost, which
 * is a different thing from a job that died — and worth saying so rather than
 * defaulting it to a failure and recommending against a runner on no data.
 */
function readObservation(path: string, job: string): Observation | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Observation;
  } catch {
    process.stderr.write(`spike-decide: no observation for job ${job}\n`);
    return null;
  }
}

const argv = process.argv.slice(2);
const arg = (flag: string): string => {
  const index = argv.indexOf(flag);
  const value = index === -1 ? undefined : argv[index + 1];
  return value ?? fail(`missing required ${flag}`);
};

const a = readObservation(arg("--a"), "A");
const b = readObservation(arg("--b"), "B");
const outPath = arg("--out");

/** Survival is the token question alone; observability is judged separately. */
const survived = (o: Observation | null) => o?.tokenSurvival === "yes";
const inconclusive = (o: Observation | null) =>
  o === null || o.tokenSurvival === "inconclusive";

// The rule as issue #63 states it, with one addition it does not: an
// inconclusive run is not a failure. A session that ended early for its own
// reasons never tested the token, and reading that as "the substrate is dead"
// would be the most expensive wrong conclusion this spike could reach.
const { headline, recommendation } =
  inconclusive(a) || inconclusive(b)
    ? {
        headline: "Inconclusive — re-run before deciding",
        recommendation:
          "At least one job ended before the 20-minute threshold for a reason other than authentication, so it never tested the token. Lengthen the prompt or raise the turn cap and run the workflow again. Do not read this as a substrate failure.",
      }
    : survived(a) && survived(b)
      ? {
          headline: "Both runners survive",
          recommendation:
            "Build Workers on raw `claude -p`. The classification pipeline, the fleet heartbeat, and the stall watchdog all keep the process seam they ride on, and no part of the existing forensic story has to be rebuilt.",
        }
      : survived(a)
        ? {
            headline: "Only raw `claude -p` survives",
            recommendation:
              "Build Workers on raw `claude -p`, which is the preferred answer anyway. Nothing further is owed to `claude-code-action`.",
          }
        : survived(b)
          ? {
              headline: "Only `claude-code-action` survives",
              recommendation:
                "Build Workers on `anthropics/claude-code-action@v1`, and open a follow-up for how much of classification, the fleet heartbeat, and stall detection is recoverable without per-chunk stdout and a process death mode. Cite this run's Job B observability rows as the starting inventory.",
            }
          : {
              headline: "Neither runner survives",
              recommendation:
                "The GitHub Actions substrate is invalid for Workers under subscription billing. Reopen the substrate decision before any of the cloud migration is built on it, and record the reversal as an ADR — it supersedes reasoning already captured in docs/adr/.",
            };

const describe = (o: Observation | null, job: string): string[] =>
  o === null
    ? [`### Job ${job}`, "", "No observation was uploaded — evidence lost.", ""]
    : [
        `### Job ${job} — \`${o.runner}\``,
        "",
        `- **Verdict:** ${o.verdict}`,
        `- **Token survived 20+ min:** ${o.tokenSurvival}`,
        `- **Elapsed at exit:** ${o.elapsedSeconds ?? "unknown"}s`,
        `- **Infrastructure signature:** ${o.infraSignature ?? "none"}`,
        `- **Terminating result event:** ${o.terminatingResultEvent ? "yes" : "no"}`,
        `- **Ran as:** ${o.model ?? "?"}, max ${o.maxTurns ?? "?"} turns`,
        `- **Record shape:** ${o.recordShape}; separate stderr: ${o.stderrCaptured ? "yes" : "no"}`,
        "",
      ];

const finding = [
  `## Spike finding: OAuth token longevity in CI — ${headline}`,
  "",
  ...describe(a, "A"),
  ...describe(b, "B"),
  "### Recommendation",
  "",
  recommendation,
  "",
  "Full transcripts, stderr captures, and execution records are attached to this workflow run as artifacts.",
  "",
].join("\n");

writeFileSync(outPath, finding);
process.stdout.write(finding);
