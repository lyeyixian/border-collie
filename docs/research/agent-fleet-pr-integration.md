# Agent-fleet PR integration: how the industry lands concurrent agent work

Research notes (not a decision — see `docs/adr/0007-serialise-conflict-resolution-not-resolve-eagerly.md`).
Gathered 2026-08-04/05 while grilling issue #103 ("issue with domino of merge
conflicts"). Every claim below carries its primary source; where a widely-cited
number turned out to be wrong or untraceable, that is recorded too, because the
wrong versions circulate more than the right ones.

The question that prompted it: when a human merges one agent PR, every other
open agent PR can go conflicted, and border-collie dispatches a Conflict Worker
per conflicted PR. Merging N PRs sequentially therefore costs O(N²/2) Worker
sessions where N−1 would do.

## Summary

- **Nobody has published a solution to post-merge conflict fan-out across
  independent agent PRs.** Not Stripe at 1,300 agent PRs/week, not Ramp at
  ~30–40% of merged PRs, not any of the eight agent products surveyed. The
  primitives exist (GitHub merge queue, native stacked PRs) and no vendor
  documentation connects either to an agent fleet.
- **Isolation is the only shipped answer to collision**, universally: worktree,
  container, or VM per agent. Every vendor prevents file-level races; none
  prevents semantic ones.
- **Prevention over reconciliation** is the near-universal stance: partition the
  work so PRs do not overlap.
- **Human review before merge is the default gate** everywhere, and no vendor
  claims otherwise.
- **Automated conflict resolution tops out around 55–65% correct**, and that
  ceiling has barely moved since GPT-3.
- **But the human baseline is worse than assumed** — conflict code that required
  manual intervention is 26× more bug-prone.

## 1. What the vendors actually ship

| Vendor | Cross-PR conflict policy |
|---|---|
| **GitHub Copilot** | Ships auto-resolution, but human-clicked. Verifies build+tests, then *"requests your review so you can confirm the resolution before merging"* ([docs](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/make-changes-to-an-existing-pr), [changelog](https://github.blog/changelog/2026-03-26-ask-copilot-to-resolve-merge-conflicts-on-pull-requests/)) |
| **Devin** | Auto-resolves **silently, but only inside a PR stack Devin itself authored** — *"It only asks you when a conflict reflects a substantive decision"* ([stacked-prs](https://docs.devin.ai/work-with-devin/stacked-prs)). Across independent sessions: *"resolve the conflict manually or ask Devin to fix it"* |
| **Cursor** | Manual click only (`Resolve in Chat`). Explicitly refuses to merge parallel output: *"`/best-of-n` compares runs only. It does not merge changes back into your main checkout for you"* ([worktrees](https://cursor.com/docs/configuration/worktrees)) |
| **Jules** | Nothing in-product — zero hits for `conflict`/`rebase`/`base branch` across all docs. Google Labs ships `@google/jules-merge` **separately and unsupported** ([npm](https://www.npmjs.com/package/@google/jules-merge)) |
| **OpenAI Codex** | Absent, with no refusal statement. [Feature request open since Aug 2025](https://community.openai.com/t/allow-openai-codex-web-to-solve-merge-conflicts/1354486) |
| **Factory, Amp, Goose** | Absent entirely |
| **CodeRabbit** | Auto-resolves and pushes, gated by a **categorical refusal list** (auth, crypto, secrets, access control), marker+index+build+lint checks, and all-or-nothing abort ([docs](https://docs.coderabbit.ai/finishing-touches/resolve-merge-conflict)) |

The dominant shipped guardrail pattern is uniform: sandbox → resolve →
**deterministic** verification (markers, parse, build, lint, tests) → atomic
all-or-nothing → push to a branch **under review**, plus domain-based refusal.
Notably **nobody uses a model confidence threshold**; everybody uses external
verification.

### Stripe and Ramp

Both were examined closely as the closest industrial analogues. Both solve
*isolation* and *validation* and leave *landing* to a human. Neither publishes
anything on merge queues, stacked PRs, branch lifetime, or agent conflict
resolution — across six primary posts the words do not appear.

- Stripe: *"Over 1,300 Stripe pull requests … merged each week are completely
  minion-produced, human-reviewed, but containing no human-written code"*
  ([part 2](https://stripe.dev/blog/minions-stripes-one-shot-end-to-end-coding-agents-part-2)).
  Two human gates — the minion **prepares** a PR; the engineer opens it and
  requests review from *another* engineer.
- Stripe explicitly rejected worktrees: *"This also gives parallelization without
  the overhead of something like git worktrees, which wouldn't scale at Stripe"*
  — they use disposable devboxes instead
  ([part 1](https://stripe.dev/blog/minions-stripes-one-shot-end-to-end-coding-agents)).
- Stripe's only conflict-adjacent statement is prevention-by-environment:
  *"it unnecessarily wastes tokens on resolution if agents are interfering with
  one another's changes."*
- Ramp: *"~30% of all pull requests merged to our frontend and backend repos are
  written by Inspect"*; *"no code is merged without engineer review"*, enforced
  architecturally by opening PRs with the *user's* token so no one can approve
  their own ([builders.ramp.com](https://builders.ramp.com/post/why-we-built-our-background-agent)).
- Ramp does run a merge queue, but the only source is
  [a 2022 post](https://builders.ramp.com/post/merge-queues), four years before
  Inspect. **No source connects the two.** Do not infer that agent PRs go
  through it.

### Disagreement worth knowing

- **Enforce disjointness?** Devin: yes, formally — *"no two groups should modify
  the same file or share mutable state"*, human-approved partition
  ([parallelize-migration](https://docs.devin.ai/use-cases/gallery/parallelize-migration)).
  Cursor: explicitly no — *"we accept some moments of turbulence and let the
  system naturally converge"*, and they **removed** their serialized integrator:
  *"There were hundreds of workers and one gate… 20 agents would slow to the
  throughput of 1-3"* ([self-driving-codebases](https://cursor.com/blog/self-driving-codebases)).
  Note the scale — hundreds of workers, not the single digits `max_open_prs`
  models.
- **Is parallelism even worth it?** Factory lists it under *"Open questions"*:
  *"Is parallelization necessary? … We are testing this."*

## 2. How good is automated conflict resolution?

| System | Year | Headline | What it measures |
|---|---|---|---|
| MergeBERT (Microsoft, FSE'22) | 2022 | 63–68% | top-1 string match |
| Gmerge (GPT-3) | 2021 | 64.6% | pass@10; single-shot 37.2% |
| MergeGen | 2026 | "90.0% similarity" | **55%** exact match |
| Merge-Bench best (Gemini 2.5 Pro) | 2026 | 62.5% | code-normalised equivalence |

[Merge-Bench](https://arxiv.org/html/2605.25890v1) (7,938 real conflict hunks,
1,439 repos, 11 languages) states it plainly: *"The best models correctly resolve
less than 60% of merge conflicts."* Claude Opus 4: 51.2% correct with 21.2%
explicit abstention. Their own caveat: hunk-size limits *"might exclude some of
the hardest merge problems, making our results an over-estimate."*

**Five years of frontier scaling moved this by single digits.** Treat ~60% as the
ceiling for unaided single-shot resolution.

A hard ceiling on anything file-local, from MergeBERT's user study (25 developers,
122 conflicts they had personally hit): ***16% of conflicts require external
information not found in either conflicting file.***

**Structural correctness must not be delegated to the model.** A calibrated
LLM-as-judge study found *"the LLM judge accepted 4 of the 5 resolutions that
fail the deterministic structural check"*
([arXiv 2607.27674](https://arxiv.org/abs/2607.27674)).

### The counter-case

- **The human baseline is bad.** Brindescu et al., *Empirical Software
  Engineering* 2019, 143 projects: *"the code associated with a merge conflict is
  twice as likely to have a bug. When the code associated with merge conflicts
  require manual intervention, the code is 26× more likely to have a bug"*
  ([DOI](https://doi.org/10.1007/s10664-019-09735-4)). "Require a human" is a
  different error distribution, not a correctness guarantee.
- **Automatic metrics understate acceptance.** MergeBERT's user study:
  *"in practice, MergeBERT resolutions would be accepted at a higher rate than
  estimated by automatic metrics"* — exact-match against one developer's
  resolution is a floor, since multiple resolutions are acceptable.
- **Where LLMs win is coverage, not accuracy**: LLMs (55–59%) beat the strongest
  traditional tool (AutoMerge, 36.7%) *"an edge that comes almost entirely from
  coverage, not raw accuracy: the tools abstain on 20–90% of conflicts."*

### Failure modes

- **Silent one-side deletion is the dangerous shape, and it survives CI.** The
  best-documented instance is a deterministic bug, not an AI one: GitHub's merge
  queue incident of 2026-04-23 built squash merges from the wrong base state —
  *"changes from previously merged PRs and prior commits were inadvertently
  reverted by subsequent merges"* — affecting **658 repositories and 2,092 pull
  requests**, with no conflict, green CI, and no failed check
  ([thread](https://github.com/orgs/community/discussions/193645)).
- **Tests are a weak oracle for semantic conflicts.** SAM, using auto-generated
  unit tests as merge oracles, detected **nine of 28** semantic conflicts
  ([arXiv 2310.02395](https://arxiv.org/abs/2310.02395)).
- **Clean merges are already often wrong.** From the ASE 2024 head-to-head
  (5,983 merge scenarios), `git merge` produced 157 incorrect merges out of 2,905
  clean ones — **5.4%** — before any automation
  ([paper](https://homes.cs.washington.edu/~mernst/pubs/merge-evaluation-ase2024.pdf)).
- **⚠ Correction to a widely-cited number.** Brun et al. FSE 2011 is usually cited
  as "33% of clean merges are broken." The paper's 399 denominator is its own
  *conflict* count, not its clean-merge count; the actual rate is
  133/(1694−266) ≈ **9.3%**. Cite ~9%, not 33%.
- **⚠ The "GenAI fails loudly" result probably does not transfer to us.** It comes
  from single-shot models whose failure mode is token truncation. An agentic loop
  with file access, build feedback, and retry has no truncation failure mode — it
  iterates until the output *looks* clean. This is the load-bearing caveat for
  border-collie's architecture.
- **⚠ Structured merge tools trade visible conflicts for invisible wrong ones.**
  ASE 2024: Spork 54% correct but 11% incorrect (16.5% of its clean merges);
  IntelliMerge 50% incorrect. *"Spork is the best merge tool if incorrect merges
  cost no more than unhandled merges (k = 1). But by k = ~2, Spork is the worst
  tool other than IntelliMerge."* IntelliMerge's own published numbers failed to
  replicate — do not cite them.

## 3. Integrating concurrent PRs at scale

Three algorithms get conflated under "merge queue": **serial gate** (1 build per
PR), **batch + bisect** (1 build per K PRs), and **speculative parallel** (K
builds for K speculative futures, eject on failure).

### The canonical mechanism: speculative execution

Zuul is the prior art everyone re-derived: *"it assumes that all jobs will
succeed and tests them in parallel accordingly. If they do succeed, they can all
be merged. However, if one fails, then changes that were expecting it to succeed
are re-tested without the failed change"*
([gating](https://zuul-ci.org/docs/zuul/latest/gating.html)). Measured payoff at
OpenStack: 24 changes/day serialised → *"averaging over 180 patches approved and
merged per day"* (≈7.5×).

Zuul is also the only one with a feedback-controlled window: *"It starts with the
window set to … twenty changes by default. Each time a change successfully
merges, the window is increased by one. Each time a change fails, the window is
halved."*

### Uber SubmitQueue — the core insight

[*Keeping Master Green at Scale*, EuroSys '19](https://www.masoud.io/docs/eurosys19.pdf).
The whole paper in one sentence:

> *"only **n out of 2ⁿ − 1 builds will ever be needed** to commit n pending
> changes."*

The speculation tree is exponential; exactly one root-to-leaf path is
retroactively real. Zuul picks it by assuming all-succeed. SubmitQueue makes path
selection a *ranked probabilistic* decision — a decision tree annotated with
success probabilities, a value function `V = B · P_needed`, and a greedy
best-first walk visiting highest-probability nodes first (O(n) space). Conflict is
a first-class probability term, computed from content-addressed **target hashes**
over the build graph. What makes it affordable: *"only **7.9% of changes**
actually cause a change to the build graph."* Model: logistic regression, ~100
features, 97% accuracy.

**The two numbers that matter most here:**

> *"with even two concurrent and potentially conflicting changes, there is a **5%
> chance of a real conflict**. This number grows to **40% with only 16**."*

> *"even changes with **one to ten hour staleness have between 10% to 20% chance
> of making the mainline red**. Thus, while frequent synchronization with the
> mainline may help avoid some conflicts, there is still a high chance of a
> breakage."*

That second one is the strongest argument in the literature against "just rebase
more often." Rebasing does not save you; only testing the actual combination does.

Results: mainline green 52% of the time → *"green at all times"*. vs a
bors-style single queue at 500 changes/hr, P50/P95/P99 turnaround grew **80×,
129×, 132×**. Now [open source](https://github.com/uber/submitqueue), Apache-2.0
— though the README describes no ML component, so the OSS release may be a
simplified variant.

### Who resolves a true textual conflict? The author. Everywhere.

| System | On textual conflict |
|---|---|
| GitHub merge queue | Auto-eject at the front of the queue, notify author |
| Meta / Sapling | Push **rejected** — *"it does not do any file content merging"* |
| Meta restack | Backs off — rebases descendants *"unless doing so would result in merge conflicts"* |
| Google LSC | **Discard and regenerate** |
| bors-ng | Kicked back to creator at batch size 1 |

**Semantic conflicts are handled only as "the combined build fails."** No system
reasons about semantics. Google names it: *"it is possible for two changes that
touch completely different files to cause a test to fail. We call this a **mid-air
collision** … CI systems for smaller repositories can avoid this problem by
serializing submits"* ([SWE Book ch. 23](https://abseil.io/resources/swe-book/html/ch23.html)).

### Google's outlier strategy: cattle, not pets

Rosie shards large-scale changes *"based upon project boundaries and ownership
rules"*, caps outstanding shards, and runs at lower priority. Conflicts are not
avoided — they are made cheap by regeneration: *"The change generation process
should be as automated as possible so that the parent change can be updated … as
textual merge conflicts occur"*, over *"nameless and faceless commits that might
be rolled back or otherwise rejected at any given time with little cost"*
([SWE Book ch. 22](https://abseil.io/resources/swe-book/html/ch22.html)).

**This is the only strategy in the survey that escapes "the author resolves it,"
and it works only because the change has a generator.** An agent fleet has one.
Rejected for border-collie on cost grounds (see the ADR) but worth remembering.

### Meta's stacked diffs solve review granularity, not conflict volume

No primary source claims stacking reduces total merge-conflict labour. The honest
claim is that it makes each conflict smaller and earlier: *"Working with stacked
diffs usually means **more frequent rebasing** of small diffs"* / *"the conflicts
you need to merge tend to be smaller"*
([Pragmatic Engineer](https://newsletter.pragmaticengineer.com/p/stacked-diffs)).
Vendor claims of "fewer conflicts" are unsupported by any measurement found.

### GitHub's own primitives

Native **stacked pull requests** went to public preview 2026-07-30, all repos,
free — bottom PR targets trunk, each subsequent PR targets the branch below, and
merging the bottom auto-rebases the rest
([changelog](https://github.blog/changelog/2026-07-30-stacked-pull-requests-are-now-in-public-preview/),
[docs](https://docs.github.com/en/pull-requests/get-started/about-stacked-prs)).
The cascade is a **mechanical** rebase — the docs claim no conflict resolution.
Stacks are merge-queue aware. **No GitHub doc recommends either for agent
fleets**; the agent docs and the merge-queue docs never cross-reference.

## 4. Agent fleets specifically

- **[AgenticFlict](https://arxiv.org/abs/2604.03551)** (AIware '26; 142K+ agent
  PRs from 59K+ repos): *"Our pipeline identifies 29K+ PRs exhibiting merge
  conflicts, yielding a **conflict rate of 27.67%**."* Per agent: Copilot 15.24%,
  Cursor 19.75%, Devin 22.85%, **Claude Code 25.93%**, Codex 31.85%. Mean 11.36
  conflict regions / 540 conflict lines per conflicting PR.
  **⚠** The paper does *not* establish that agents conflict more than humans.
- **[arXiv 2607.04697](https://arxiv.org/html/2607.04697v2)**: *"79.4% of all
  agent PRs are temporally concurrent"*; intra-agent textual conflict rate 19.8%,
  **cross-agent 41.7%** — roughly double, non-overlapping CIs. Concurrency is the
  driver, and concurrency is a scheduling choice.
- **Anthropic's own account** — 16 agents building a C compiler over ~2,000
  sessions, coordinating via git lock files: *"Merge conflicts are frequent, but
  Claude is smart enough to figure that out."* And the boundary condition stated
  out loud: *"compiling the Linux kernel is one giant task. Every agent would hit
  the same bug, fix that bug, and then overwrite each other's changes"*
  ([engineering post](https://www.anthropic.com/engineering/building-c-compiler)).
- **Claude Code's documented blind spot**: *"GitHub does not emit a webhook when
  the base branch advances and creates a merge conflict, so auto-fix can't react
  to conflicts on its own"*
  ([docs](https://code.claude.com/docs/en/claude-code-on-the-web)).
- **The bluntest partitioning rule anyone publishes**: *"Two teammates editing the
  same file leads to overwrites. Break the work so each teammate owns a different
  set of files"* ([agent-teams](https://code.claude.com/docs/en/agent-teams)).

## 5. Tooling evaluated as a substrate

None of the three helps with conflict fan-out. Evaluated because the alternative
to designing this ourselves is adopting someone else's orchestrator.

### Orca — `stablyai/orca`

Desktop ADE for agent fleets, MIT, 37.2k stars, **created 2026-03-17** (five
months old), 3,059 open issues. Runs Goose, Claude Code, Codex, Cursor CLI and
others — a layer *above* them, not a competitor. Genuinely deep git integration:
worktree-per-task, merge-queue-aware auto-merge (*"Merge when ready"*),
`--force-with-lease`, "Resolve with AI", Actions-failure→agent loop. Orchestration
CLI has runs/tasks/dispatches/workers/decision gates.

**Overlaps border-collie's core substantially.** Against adopting: it is an
Electron desktop app (*"Not a hosted VPS product"*; `orca serve` is the exception
path), five months old, shipping daily. Its conflict handling is still
single-PR "Resolve with AI" — it does not solve fan-out either.

### Goose — `aaif-goose/goose` (formerly `block/goose`)

Donated to the Linux Foundation's Agentic AI Foundation April 2026. **Stripe's
Minions is built on a fork of it** — *"The core agent loop runs on a fork of
Block's coding agent goose … which we forked early on"* (Stripe part 1). Note the
fork is from late 2024 and has diverged ~18 months.

**Does nothing for this problem, by explicit decision.** Repo-wide greps: `merge
queue` → **zero hits**; `git worktree add` → **nowhere**. Both relevant issues
were closed as declined — [#7916](https://github.com/aaif-goose/goose/issues/7916)
(git-native task coordination, NOT_PLANNED) and
[#3557](https://github.com/aaif-goose/goose/issues/3557) (worktrees — *"I don't
think we want to build this into goose at a native level"*). Official guidance:
*"reads can be parallel, writes should be sequential."*

**⚠ Its `--output-format json` `status` field is hardcoded to `"completed"` in
both the success and the error branch** (`crates/goose-cli/src/session/mod.rs`),
and its exit codes have no documented contract. A poll loop cannot trust it.

Worth stealing: recipe `retry` + shell `checks` (declarative agent-loop plus
deterministic verification), and the `stream-json` event taxonomy.

### Flue — `withastro/flue`

Genuinely the Astro team, Apache-2.0, created 2026-02-07, 7.7k stars, v2.0.2
(2026-08-04). Effectively solo: **FredKSchott 1,027 commits, next contributor 4**;
2.0 was a breaking API rewrite. It is an agent *authoring* framework (React-style
hooks), not an orchestrator.

**No model of version control at all.** Greps at v2.0.2: `worktree`,
`merge conflict`, `merge queue`, `git commit`, `git push`, `createPullRequest` →
**0 files each**. The 52 `conflict` hits are all `SubmissionConflictError` and
kin; the 8 `rebase` hits are all the string *"rebaseline"* (context compaction).
`@flue/github` is *"webhook ingress only … does not include an outbound GitHub
client."*

Worth stealing (recorded on #94): its terminal contract — *"`--json` always prints
exactly one envelope, discriminated by `outcome`, for every terminal result"*,
emitted even on setup failure, with `0`/`1`/`130` exit codes; plus `--new` with a
deterministic `--id` for exactly-once creation across retries, and idempotency
keys so redelivery converges.

**⚠ Search-result quality for "flue" is poor** — several sites assert a wrong repo
(`floatplane/flue`), a non-existent `packages/connectors` directory, and stale
star counts. Only the repo and `flueframework.com` are trustworthy.

## 6. Measured against this repository

Last 4 months, 50 commits touching `src/`, 32 TypeScript files:

| Measure | Value |
|---|---|
| Median files changed per commit | **6 of 32** |
| Commits touching exactly one file | **3 of 49 (6%)** |
| `worker.ts` appears in | **48% of all commits** |
| `act.ts` / `tracker.ts` / `types.ts` | 46% / 42% / 38% |

Two random tickets both touching `worker.ts` is ~23% on that file alone, which
lands almost exactly on AgenticFlict's measured 25.93% for Claude Code PRs. **The
domino is architectural, not bad luck**: a layered design funnels every feature
through a composition root (`src/cli/context.ts`) and a shared type module, and a
Tracer bullet is *defined* in CONTEXT.md as a cross-cutting vertical slice.

This rules out one-file tickets as a mitigation — that would mean abandoning the
tracer-bullet concept. It does **not** rule out the weaker and more useful form of
Devin's rule: no two *concurrently dispatched* tickets touch the same file. That
is a dispatch-time scheduling constraint requiring a predicted file-set per
ticket, and is left as future work.

## 7. What this repository concluded

See `docs/adr/0007-serialise-conflict-resolution-not-resolve-eagerly.md`.
In short: keep automatic resolution, serialise it behind the operator's merges,
and verify it with the repository's own CI rather than the agent's say-so.
