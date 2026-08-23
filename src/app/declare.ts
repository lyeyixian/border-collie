import {
  type ClearDeclareSidecar,
  clearDeclareSidecar,
  type LoadDeclareSidecar,
  loadDeclareSidecar,
} from "../adapters/declare.js";
import {
  type CreateIssue,
  createIssue as createIssueReal,
  type ListOpenIssues,
  listOpenIssues as listOpenIssuesReal,
} from "../adapters/tracker.js";
import {
  dispatchOnboardingWorker,
  type OnboardingOutcome,
  realSpawnWorkerProcess,
} from "../adapters/worker.js";
import {
  type LoadContract,
  loadContract,
  type ReadContractRaw,
  readContractRaw,
  type WriteContractRaw,
  writeContractRaw,
} from "../adapters/workflow.js";
import type { WorkerAttemptConfig } from "../core/config.js";
import {
  type DeclareExclusion,
  type DeclareOutcome,
  declareRegressions,
  findRedBaselineIssue,
  type RedBaselineAction,
  redBaselineBody,
  redBaselineTitle,
  type TrackerIssueRef,
} from "../core/declare.js";
import type { Log } from "../core/log.js";
import {
  CONTRACT_FILE,
  type Contract,
  EMPTY_CONTRACT,
  parseContract,
} from "../core/workflow.js";

/**
 * `declare` (issue #150): run one Onboarding Worker and read back what it
 * produced, injectable so a fake session/contract/sidecar exercises this
 * without a real headless run — the same split `runWorkerAttempt`
 * (src/app/worker.ts) keeps between the injectable unit and its real wiring.
 */
export type DispatchOnboarding = () => Promise<OnboardingOutcome>;

export interface DeclareDeps {
  dispatch: DispatchOnboarding;
  loadContractFn: LoadContract;
  readExistingContract: ReadContractRaw;
  restoreContract: WriteContractRaw;
  loadSidecar: LoadDeclareSidecar;
  clearSidecar: ClearDeclareSidecar;
  listOpenIssues: ListOpenIssues;
  createIssue: CreateIssue;
  log: Log;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The contract on disk before the session ran, for the regression diff
 * (issue #152). A pre-existing `WORKFLOW.md` that fails to parse can't name
 * what it previously declared, so it degrades to `EMPTY_CONTRACT` — the same
 * no-regressions-possible state a first declare starts from — rather than
 * failing the run over a file this session did not write.
 */
function parsePreviousContract(raw: string | undefined, log: Log): Contract {
  if (raw === undefined) return EMPTY_CONTRACT;
  try {
    return parseContract(raw);
  } catch (error) {
    log({
      kind: "declare-contract-invalid",
      level: "warn",
      msg: `existing ${CONTRACT_FILE} could not be read before the session ran: ${messageOf(error)}`,
    });
    return EMPTY_CONTRACT;
  }
}

/**
 * File one tracker issue per red exclusion (issue #151): a command that
 * exists and failed cannot enter the contract, so it is recorded as debt
 * instead of dropped. Only `kind: "red"` exclusions owe a filing — a
 * missing candidate or one that could not be torn down is not a red check.
 *
 * The open issues are read once and re-used across every red exclusion in
 * this run, both to dedup by marker (never by title, which is fragile) and
 * so one command's filing failure never costs the others their turn — the
 * same per-item isolation `runInitLabels` (src/app/init.ts) gives the label
 * set. A tracker `declare` cannot reach at all degrades every red exclusion
 * to `failed` rather than throwing, matching how label creation already
 * degrades (CONTEXT.md "Red baseline"): the contract `runDeclare` already
 * read is unaffected either way.
 */
async function fileRedBaselines(
  excluded: DeclareExclusion[],
  deps: Pick<DeclareDeps, "listOpenIssues" | "createIssue" | "log">,
): Promise<RedBaselineAction[]> {
  const redExclusions = excluded.filter(
    (exclusion) => exclusion.kind === "red",
  );
  if (redExclusions.length === 0) return [];

  let issues: TrackerIssueRef[];
  try {
    issues = await deps.listOpenIssues();
  } catch (error) {
    const message = messageOf(error);
    deps.log({
      kind: "declare-red-baseline-unreachable",
      level: "warn",
      msg: `the tracker could not be reached to file red-baseline issues: ${message}`,
    });
    return redExclusions.map((exclusion) => ({
      command: exclusion.name,
      outcome: "failed" as const,
      error: message,
    }));
  }

  const actions: RedBaselineAction[] = [];
  for (const exclusion of redExclusions) {
    const existing = findRedBaselineIssue(issues, exclusion.name);
    if (existing !== undefined) {
      actions.push({
        command: exclusion.name,
        outcome: "already-recorded",
        issue: existing,
      });
      continue;
    }
    try {
      const issue = await deps.createIssue(
        redBaselineTitle(exclusion.name),
        redBaselineBody(exclusion),
      );
      actions.push({ command: exclusion.name, outcome: "filed", issue });
    } catch (error) {
      actions.push({
        command: exclusion.name,
        outcome: "failed",
        error: messageOf(error),
      });
    }
  }
  return actions;
}

/**
 * Run one Onboarding Worker and read back what it produced. The session
 * itself writes `WORKFLOW.md` and the sidecar into the working tree
 * (`onboardingWorkerPrompt`, adapters/worker.ts); this only runs it, then
 * reads the contract and the sidecar back and clears the sidecar — never
 * authoring or re-deriving either (CONTEXT.md "Onboarding Worker"). A
 * contract or sidecar that fails to parse is the session's fault, not
 * declare's: caught and logged rather than left to crash an otherwise-
 * complete run, the same choice `dispatchWorker` makes about a malformed
 * `WORKFLOW.md` after a Worker's own Attempt (issue #149). The sidecar is
 * cleared either way — scratch, read once, never part of the contract.
 *
 * Before dispatch, the existing `WORKFLOW.md` is read raw, so a previously
 * declared command now missing from what the session wrote can be named and,
 * since rewriting the contract over a regression is refused (issue #152),
 * restored byte-identical — a reconstruction built from the parsed shape
 * would silently drop the operator's own prose body.
 */
export async function runDeclare(deps: DeclareDeps): Promise<DeclareOutcome> {
  const {
    dispatch,
    loadContractFn,
    readExistingContract,
    restoreContract,
    loadSidecar,
    clearSidecar,
    log,
  } = deps;
  const previousRaw = await readExistingContract(".");
  const previousContract = parsePreviousContract(previousRaw, log);

  const session = await dispatch();
  let contractParseFailed = false;
  const contract = await loadContractFn(".").catch((error: unknown) => {
    contractParseFailed = true;
    log({
      kind: "declare-contract-invalid",
      level: "warn",
      msg: `${CONTRACT_FILE} could not be read after the session ended: ${messageOf(error)}`,
    });
    return EMPTY_CONTRACT;
  });
  const excluded: DeclareExclusion[] = await loadSidecar(".").catch(
    (error: unknown) => {
      log({
        kind: "declare-sidecar-invalid",
        level: "warn",
        msg: `the declare sidecar could not be read: ${messageOf(error)}`,
      });
      return [];
    },
  );
  await clearSidecar(".");

  const redBaselines = await fileRedBaselines(excluded, deps);
  const runFacts = {
    endedBy: session.endedBy,
    exitCode: session.exitCode,
    costUsd: session.costUsd,
    costOverrun: session.costOverrun,
    redBaselines,
  };

  // Skipped when the session's own contract failed to parse: an unparseable
  // WORKFLOW.md is that failure's own story, not evidence every previously
  // declared command individually broke — `contract` is only EMPTY_CONTRACT
  // as a fallback here, not because the session wrote one.
  const regressions = contractParseFailed
    ? []
    : declareRegressions(previousContract, contract);
  if (regressions.length > 0 && previousRaw !== undefined) {
    await restoreContract(".", previousRaw);
    return {
      ...runFacts,
      contract: previousContract,
      excluded: [],
      regressions,
    };
  }

  return { ...runFacts, contract, excluded, regressions: [] };
}

/**
 * The real composition: today's collaborators, wired exactly as `declare`
 * needs them. Runs on the retry model rather than the worker model
 * (`config.retryModel`, never `modelForAttempt` — there is no Attempt here).
 */
export function declareOnce(
  config: WorkerAttemptConfig,
  deps: { log: Log },
): Promise<DeclareOutcome> {
  const { log } = deps;
  return runDeclare({
    dispatch: () =>
      dispatchOnboardingWorker(
        {
          model: config.retryModel,
          timeoutMs: config.timeoutMinutes * 60_000,
          stallMs: config.stallMinutes * 60_000,
          maxTurns: config.maxTurns,
          maxCostUsd: config.maxCostUsd,
        },
        realSpawnWorkerProcess,
        log,
      ),
    loadContractFn: loadContract,
    readExistingContract: readContractRaw,
    restoreContract: writeContractRaw,
    loadSidecar: loadDeclareSidecar,
    clearSidecar: clearDeclareSidecar,
    listOpenIssues: listOpenIssuesReal,
    createIssue: createIssueReal,
    log,
  });
}
