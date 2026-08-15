# Claude subscription limits: interactive vs headless agent sessions

Research notes for issue #126 (not a decision). Every claim below was fetched
from a primary Anthropic source on **2026-08-15**; each carries the URL it came
from, and the sentence it rests on is quoted rather than paraphrased. Where the
only source is community-authored it is marked **SECONDARY**; where no source
could be found the claim is marked **UNVERIFIED** rather than filled in.

The question that prompted it (issue #125, the v2 autonomy roadmap): should
operator-facing conversation ever be driven *by* the fleet — spending fleet
budget, unattended — or stay in the operator's own interactive sessions? That
only has an answer if "fleet budget" and "interactive budget" are actually
different things. They are mostly not.

## Summary

- **There is no interactive-vs-headless metering distinction today.** Claude
  Code "charges by API token consumption" on every surface, and the subscription
  window "applies across your account—not individual sessions". A headless
  Worker and the operator's terminal draw on one pool.
- **That distinction was built, announced, and paused.** Anthropic announced a
  separate monthly Agent SDK credit covering `claude -p`, the Agent SDK, and the
  GitHub Actions integration, due 2026-06-15 — and paused it on 2026-06-15.
  The per-plan credit amounts were published before the pause. **This is the
  single most decision-relevant fact on this ticket: the split border-collie
  would benefit from is a policy Anthropic has already drafted and shelved, and
  may un-shelve.**
- **The one real mechanism difference is credential selection, not metering.**
  `claude -p --bare` refuses to read OAuth credentials at all — including
  `CLAUDE_CODE_OAUTH_TOKEN` — which silently converts a session from
  subscription spend to API spend. **`--bare` "will become the default for `-p`
  in a future release."** border-collie does not pass `--bare` today.
- **A second real asymmetry favours subscription for border-collie's session
  shape**: the prompt-cache lifetime is **one hour on a subscription** and
  **five minutes on an API key**. A 45-minute Worker fits inside the former and
  not the latter.
- **Anthropic publishes no absolute subscription allowance** — only multipliers
  ("20x Pro"), never the thing being multiplied. The fleet's ceiling therefore
  cannot be computed in advance; it can only be measured.
- **The crossover is not a dollar line, it is a throughput ceiling.** A Max 20x
  seat at $200/month pays for itself somewhere between **one and thirteen Worker
  sessions per day** depending on session size — a bar border-collie clears
  almost immediately. Past the ceiling you cannot buy more subscription; you can
  only enable usage credits, which bill "at standard API pricing rates". A
  subscription is best read as a **prepaid block of API-rate usage at a discount,
  behind a hard rate limiter**.
- **Nothing published forbids what border-collie does.** The docs positively
  sanction it: `claude setup-token` exists "for CI pipelines, scripts, or other
  environments where interactive browser login isn't available", and GitHub
  Actions documents subscription OAuth as a first-class auth path.

---

## 1. What the limits actually are

### 1.1 Two windows, plus a per-model cap

Subscription usage runs on a **rolling five-hour session window** and a
**weekly cap**, with a separate Opus-only cap layered on top. The
[Max plan page](https://support.claude.com/en/articles/11049741-what-is-the-max-plan):

> Your session-based usage limit will reset every five hours.

and

> a weekly usage limit that applies across all models

[`code.claude.com/docs/en/errors`](https://code.claude.com/docs/en/errors) shows
the three distinct messages, which is the clearest published evidence that the
caps are genuinely separate:

```text
You've hit your session limit · resets 3:45pm
You've hit your weekly limit · resets Mon 12:00am
You've hit your Opus limit · resets 3:45pm
```

> The session and weekly limits are shared across all models. Switching to a
> different model only helps with the Opus-specific limit.

The same page's operator-facing counterpart,
[`docs/en/costs`](https://code.claude.com/docs/en/costs), says the same thing
from the admin side:

> These windows are shared across all models, so switching models with `/model`
> doesn't restore access, though it does keep the developer working after the
> model-specific "You've hit your Opus limit" message.

### 1.2 Published prices

| Plan | Price | Source |
|---|---|---|
| Pro | "$17" /mo annual; "$20 if billed monthly" | [claude.com/pricing](https://claude.com/pricing) |
| Max 5x | "$100 per month" | [Max plan](https://support.claude.com/en/articles/11049741-what-is-the-max-plan) |
| Max 20x | "$200 per month" | [Max plan](https://support.claude.com/en/articles/11049741-what-is-the-max-plan) |
| Team Standard | "$20" /seat annual; "$25 if billed monthly" | [claude.com/pricing](https://claude.com/pricing) |
| Team Premium | "$100" /seat annual; "$125 if billed monthly" | [claude.com/pricing](https://claude.com/pricing) |
| Enterprise | "Seat price + usage at API rates" / "$20/seat" | [claude.com/pricing](https://claude.com/pricing) |

Note that `claude.com/pricing` itself prints only **"From $100"** for Max and
does not break out the 20x price; the $200 figure comes from the Max plan
support article. Anything quoting Max 20x off the pricing page alone is
guessing.

### 1.3 The allowance is a multiplier of an unpublished base

This is the load-bearing gap. Every published figure is relative:

| Tier | Published allowance | Source |
|---|---|---|
| Pro | "At least five times the usage per session compared to our free service" | [Pro plan](https://support.claude.com/en/articles/8325606-what-is-the-pro-plan) |
| Max 5x | "five times more usage per session than the Pro plan" | [Max plan](https://support.claude.com/en/articles/11049741-what-is-the-max-plan) |
| Max 20x | "20 times more usage per session than the Pro plan" | [Max plan](https://support.claude.com/en/articles/11049741-what-is-the-max-plan) |
| Team Standard | "1.25x more usage per session than Pro" | [Team plan](https://support.claude.com/en/articles/9266767-what-is-the-team-plan) |
| Team Premium | "6.25x more usage per session than Pro" | [Team plan](https://support.claude.com/en/articles/9266767-what-is-the-team-plan) |

The base is never stated, and Anthropic says explicitly that it is not a fixed
quantity ([Pro plan](https://support.claude.com/en/articles/8325606-what-is-the-pro-plan)):

> The number of messages you can send will vary based on message length,
> including the length of files you attach, the length of your current
> conversation, and the model or feature you use.

The Max page also reserves the right to change the shape of the limit:

> to manage capacity and ensure fair access to all users, we may limit your
> usage in other ways, such as weekly and monthly caps or model and feature
> usage, at our discretion.

**Consequence for a fleet: you cannot size a fleet against the published
limits, because there are no published limits — only ratios.** The only way to
know how many Worker-hours a Max 20x seat buys is to run them and watch
`/usage`.

### 1.4 One pool across every surface

[Using Claude Code with your Pro or Max plan](https://support.claude.com/en/articles/11145838-using-claude-code-with-your-pro-or-max-plan):

> shared across Claude and Claude Code, meaning all activity in both tools
> counts against the same usage limits

[How usage and length limits work](https://support.claude.com/en/articles/11647753-how-do-usage-and-length-limits-work):

> Your usage of all different Claude product surfaces (claude.ai, Claude Code,
> Claude Desktop) counts towards the same usage limit.

On Team/Enterprise, [`docs/en/costs`](https://code.claude.com/docs/en/costs)
adds Cowork to the list:

> each member's Claude Code usage draws from a per-seat allowance that resets on
> a rolling five-hour window and a weekly window. The allowance is shared with
> Claude chat and Cowork

**This is the direct answer to the roadmap question in #125.** There is no
separate "fleet budget". A Worker that spends the window is spending the same
window the operator's next interactive session needs. Fleet-driven conversation
does not spend a different pot from operator-driven conversation; it spends the
operator's pot while the operator is not watching.

### 1.5 What happens at the cap

A hard stop, with one paid escape hatch.
[`docs/en/errors`](https://code.claude.com/docs/en/errors) lists the resolution as
"Wait for the reset time shown", `/usage` to see limits, `/usage-credits` to buy
more, or upgrade. [`docs/en/costs`](https://code.claude.com/docs/en/costs) is
blunt about the ceiling on Team/Enterprise:

> **Cap spend**: the seat allowance is the default ceiling.

The escape hatch is **usage credits**
([Extra usage for paid Claude plans](https://support.claude.com/en/articles/12429409-extra-usage-for-paid-claude-plans)),
available on "Pro, Max 5x, and Max 20x":

> Usage credits allow individuals subscribed to paid Claude plans (Pro, Max 5x,
> and Max 20x) to continue using Claude seamlessly after reaching their included
> usage limits.

Billed at **"standard API pricing rates"**, with an optional monthly spend cap,
and they cover Claude Code:

> Usage credits apply to both Claude conversations and Claude Code terminal
> usage. Your combined usage across both interfaces counts toward your limits.

**So the marginal token past the cap costs exactly API rates.** That single fact
determines the shape of the whole crossover analysis in §4: subscription is a
discount on a fixed block, not a different price curve.

---

## 2. Interactive vs headless: where the difference is, and is not

### 2.1 Metering: no documented difference

`claude -p` is documented purely as an execution mode, with no billing language
attached ([`docs/en/headless`](https://code.claude.com/docs/en/headless)):

> To run Claude Code in non-interactive mode, pass `-p` with your prompt

The billing statement in [`docs/en/costs`](https://code.claude.com/docs/en/costs)
is surface-agnostic:

> Claude Code charges by API token consumption.

and the window is explicitly per-account, not per-session
([Extra usage](https://support.claude.com/en/articles/12429409-extra-usage-for-paid-claude-plans)):

> The reset cycle applies across your account—not individual sessions. All your
> conversations count toward the same five-hour window threshold.

No primary source distinguishes headless from interactive metering. **On the
narrow question the ticket asks — is consumption genuinely different? — the
answer today is no.**

The perceived difference is therefore *mostly* the ticket's own hypothesis:
background agents run longer and unattended, so they consume more of a shared
pool without anyone watching the bar go down. `docs/en/costs` names the driver
directly:

> Per-developer costs vary widely based on model selection, codebase size, and
> usage patterns such as running multiple instances or automation.

But "mostly" is doing work. Two real mechanisms follow.

### 2.2 Mechanism one: `--bare` silently changes which credential pays

This is the sharpest finding, and it is a credential mechanism rather than a
metering one. [`docs/en/headless`](https://code.claude.com/docs/en/headless):

> Set `ANTHROPIC_API_KEY` before running it, because bare mode doesn't use your
> subscription login

> In bare mode, Claude Code never reads OAuth credentials or the system keychain.

[`docs/en/authentication`](https://code.claude.com/docs/en/authentication) closes
the loop on the token border-collie actually uses:

> Bare mode does not read `CLAUDE_CODE_OAUTH_TOKEN`. If your script passes
> `--bare`, authenticate with `ANTHROPIC_API_KEY` or an `apiKeyHelper` instead.

And the forward hazard, from the same headless page:

> `--bare` is the recommended mode for scripted and SDK calls, and **will become
> the default for `-p` in a future release**.

So: the same prompt, run headless, can be subscription-billed or API-billed
depending on one flag — and the default is scheduled to flip toward the
API-billed side. Without `--bare`, `claude -p` behaves like an interactive
session for credential purposes:

> Without it, `claude -p` loads the same context an interactive session would,
> including anything configured in the working directory or `~/.claude`.

### 2.3 Mechanism two: an API key beats the subscription token, silently, in `-p`

The [precedence order](https://code.claude.com/docs/en/authentication) puts
`ANTHROPIC_API_KEY` at position 3 and `CLAUDE_CODE_OAUTH_TOKEN` at position 5:

> 3. `ANTHROPIC_API_KEY` environment variable... In interactive mode, you are
>    prompted once to approve or decline the key... **In non-interactive mode
>    (`-p`), the key is always used when present.**

> 5. `CLAUDE_CODE_OAUTH_TOKEN` environment variable. A long-lived OAuth token
>    generated by `claude setup-token`. Use this for CI pipelines and scripts
>    where browser login isn't available.

An interactive session asks before spending an API key. **A headless one never
asks.** Any `ANTHROPIC_API_KEY` that leaks into a Worker's environment moves the
whole fleet from subscription to metered billing with no prompt and no log line.
That *is* a genuine interactive-vs-headless difference — in the failure mode,
not in the meter.

### 2.4 Mechanism three: the cache lifetime differs by credential

[`docs/en/costs`](https://code.claude.com/docs/en/costs), on why usage climbs in
a long session:

> your first message after a break longer than the cache lifetime misses the
> cache and reprocesses your full context. **The lifetime is an hour on a
> subscription and drops to five minutes once you're drawing on usage credits;
> on an API key or cloud provider, it's five minutes by default.**

`ENABLE_PROMPT_CACHING_1H=1` restores the hour while on credits. On the API,
buying the 1-hour TTL costs **2x base input** on writes versus **1.25x** for the
5-minute TTL
([pricing](https://platform.claude.com/docs/en/about-claude/pricing)).

This asymmetry points the *opposite* way from the usual assumption: for a
45-minute Worker doing think–act–verify loops with long gaps between model
calls, **the subscription is the configuration with the better cache behaviour,
for free.** Moving border-collie to API billing would either pay 2x writes to
match it or eat cache misses on a 45-minute session.

### 2.5 The split that was built and paused

[Use the Claude Agent SDK with your Claude plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)
is the most consequential page on this ticket. Anthropic announced a separate
monthly credit for exactly the surfaces border-collie runs on:

> Claude subscription plans are now eligible to receive a monthly Agent SDK
> credit

covering

> Claude Agent SDK usage, the `claude -p` command, and third-party apps built on
> the Agent SDK

— and the GitHub Actions integration was named as covered too. Published credit
amounts: Pro $20, Max 5x $100, Max 20x $200, Team Standard $20, Team Premium
$100, Enterprise (seat-based Premium) $200.

Then, on the day it was due to take effect:

> We're pausing the changes to Claude Agent SDK usage described below. For now,
> nothing has changed: Claude Agent SDK, `claude -p`, and third-party app usage
> still draw from your subscription's usage limits.

> The previously announced monthly credit, which would have been available to
> eligible claimants in connection with these changes, isn't available.

**Read this as a roadmap signal, not trivia.** Anthropic has already designed,
priced, and published a world in which headless fleet usage is metered
separately from interactive usage. It is paused, not cancelled. A v2 design that
assumes headless and interactive budgets stay fungible is betting on a pause
holding.

### 2.6 Is it allowed?

The primary docs positively sanction it.
[`docs/en/authentication`](https://code.claude.com/docs/en/authentication):

> For CI pipelines, scripts, or other environments where interactive browser
> login isn't available, generate a one-year OAuth token with `claude setup-token`

> This token authenticates with your Claude subscription and requires a Pro,
> Max, Team, or Enterprise plan. It can only make model requests

and [`docs/en/github-actions`](https://code.claude.com/docs/en/github-actions):

> `CLAUDE_CODE_OAUTH_TOKEN`: an OAuth token that authenticates with your Claude
> subscription, available on Pro, Max, Team, and Enterprise plans. Generate one
> by running `claude setup-token` locally.

A **SECONDARY** community claim circulates that an Anthropic legal/compliance
page dated 2026-02-19 states the Agent SDK requires API-key auth and that
subscription OAuth with the SDK is not permitted. **That could not be confirmed
against any primary source, and it is contradicted by the two primary pages
quoted above**, both of which document subscription OAuth for CI as a supported
path. Recorded here because the wrong version circulates more than the right
one — but treat it as UNVERIFIED and do not design against it without checking
the terms directly.

One operational caveat that *is* primary: the token is one-year-lived, and

> Renewing early matters most for sessions that run unattended.

---

## 3. How concurrency interacts with the limits

### 3.1 No published per-account session cap

**UNVERIFIED.** No page on `support.claude.com`, `code.claude.com`, or
`claude.com` publishes a limit on how many concurrent Claude Code sessions one
account may run. Secondary sources assert "no cap, machine resources are the
constraint"; that is not an Anthropic statement and is not relied on here.

What *is* published is that everything lands in one bucket: the five-hour window
"applies across your account—not individual sessions", and all surfaces "count
towards the same usage limit". So N concurrent Workers do not get N windows —
they drain one window N times faster. **Concurrency does not change the ceiling;
it changes how fast you reach it.**

### 3.2 What is published about parallelism

- **Subagents**: 20 concurrent by default, tunable
  ([`docs/en/sub-agents`](https://code.claude.com/docs/en/sub-agents)) — "By
  default, when 20 subagents are running in a session, spawning another with the
  Agent tool fails with `Concurrent subagent limit reached`", changed via
  `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`. The former 200-per-session cap was
  removed in
  [week 32, 2026](https://code.claude.com/docs/en/whats-new/2026-w32).
- **Agent teams** carry a published multiplier
  ([`docs/en/costs`](https://code.claude.com/docs/en/costs)): "Agent teams use
  approximately **7x more tokens** than standard sessions when teammates run in
  plan mode, because each teammate maintains its own context window and runs as
  a separate Claude instance."
- **API-side rate limits** are the analogue if border-collie ever moves to a key.
  `docs/en/costs` recommends, for a 1–5 user org, **200k–300k TPM and 5–7 RPM per
  user**, and notes these "apply at the organization level, not per individual
  user".

### 3.3 The observability hole

`/usage` will not see a fleet running in CI
([`docs/en/costs`](https://code.claude.com/docs/en/costs)):

> The figures are approximate and computed from local session history on this
> machine, so usage from other devices or claude.ai is not included.

The operator's laptop cannot report what the GitHub Actions Workers spent. On
Pro/Max the only account-wide view is **Settings > Usage** on claude.ai; on
Team/Enterprise there is a spend report and, on Enterprise, an
[Analytics API](https://platform.claude.com/docs/en/api/admin/analytics). **A
Pro/Max operator running an always-on fleet has no programmatic way to read
remaining headroom.** That is a real constraint on any "fleet backs off before
the cap" design.

`/usage` does at least attribute usage once you look:

> **Attribution**: recent usage attributed to skills, subagents, plugins, and
> individual MCP servers, each shown as a percentage of the total.

> **Behavior flags**: behaviors such as long context or cache misses, flagged
> when one accounts for 10% or more of recent usage.

---

## 4. Where the crossover sits

### 4.1 The published API prices

From [platform pricing](https://platform.claude.com/docs/en/about-claude/pricing),
fetched 2026-08-15:

| Model | Input | 5m cache write | 1h cache write | Cache read | Output |
|---|---|---|---|---|---|
| Claude Opus 5 (`claude-opus-5`) | $5 /MTok | $6.25 | $10 | $0.50 | $25 /MTok |
| Claude Sonnet 5 (`claude-sonnet-5`) | $2 /MTok | $2.50 | $4 | $0.20 | $10 /MTok |
| Claude Haiku 4.5 (`claude-haiku-4-5`) | $1 /MTok | $1.25 | $2 | $0.10 | $5 /MTok |

One correction worth carrying forward — Sonnet 5's introductory price is now
permanent:

> The $2/$10 per million input/output token pricing for Claude Sonnet 5,
> announced at launch as introductory pricing through August 31, 2026, is now
> the standard price. The previously scheduled increase to $3/$15 per million
> input/output tokens on September 1, 2026 will not occur.

Cache multipliers: 5-minute write **1.25x**, 1-hour write **2x**, read **0.1x**
base input. Opus 5 is **2.5x** Sonnet 5 on both input and output — directly
relevant, because border-collie's retry ladder puts Opus on attempt 2.

### 4.2 Anchor A — Anthropic's own per-developer figure

[`docs/en/costs`](https://code.claude.com/docs/en/costs):

> Across enterprise deployments, the average cost is around $13 per developer per
> active day and $150-250 per developer per month, with costs remaining below $30
> per active day for 90% of users.

**A Max 20x seat is $200/month — inside that band.** So one developer's worth of
Claude Code costs roughly the same on either billing model. The subscription
wins only on what it does *beyond* one developer's worth, and only up to its
cap.

### 4.3 Anchor B — break-even in Worker sessions per day

Let `C` be the list-priced cost of one Worker session — precisely the
`total_cost_usd` border-collie already records. Break-even against Max 20x is
$200 / 30.4 ≈ **$6.58 of list-priced work per day**:

| Cost per Worker session | Sessions/day to break even on Max 20x |
|---|---|
| $0.50 | ~13 |
| $1 | ~6.6 |
| $2 | ~3.3 |
| $5 | ~1.3 |
| $20 (border-collie's configured ceiling) | ~0.3 (one session every ~3 days) |

**The crossover is low.** Even on pessimistic assumptions an always-on fleet
crosses it within a day or two of operation. Below the cap, subscription is
strictly cheaper per unit of work; the question is never "is it worth $200" but
"does the work fit under the ceiling".

### 4.4 The honest framing

Because the marginal token past the cap is billed at "standard API pricing
rates", the two options are not two price curves. They are:

- **Subscription** — a fixed-price prepaid block of API-rate usage at a
  discount, behind a hard throughput limiter you cannot pay to raise (only
  upgrade tier, or spill into credits at full API rates), with a **1-hour cache
  TTL included**.
- **API** — the same tokens at full price with no throughput limiter beyond
  rate limits, a **5-minute cache TTL** by default, and per-workspace spend
  caps and per-user reporting that a Pro/Max subscription does not offer.

So the decision is not really about cost. It is about **which failure mode you
prefer**: a fleet that stops (subscription) or a fleet that keeps spending
(API). border-collie already has machinery for the first (circuit breaker,
`usage-limit` infra class) and none for the second.

A hybrid follows naturally and is worth flagging for the roadmap: subscription
for the fleet's steady state, usage credits with a monthly spend cap as the
overflow valve. The cap makes the worst case bounded, and the credits make a
weekly-cap stall recoverable instead of a multi-day outage.

---

## 5. What this means for border-collie

Repo-local evidence, gathered at `0d3ca4b`.

### 5.1 The fleet already runs on the operator's subscription

`.github/workflows/border-collie-worker.yml:122` and
`.github/workflows/border-collie-tick.yml:101` pass exactly one Claude
credential — `CLAUDE_CODE_OAUTH_TOKEN` — and no `ANTHROPIC_API_KEY`, Bedrock, or
Vertex configuration. `README.md:74` names it "a subscription OAuth token
(`claude setup-token`)", and `src/core/scaffold.ts:225` prints the same secret
into every repo `init` scaffolds.
[ADR 0006](../adr/0006-github-actions-execution-substrate.md) records why the
runner is raw headless `claude` rather than `claude-code-action`.

`src/adapters/worker.ts:68-77` builds the invocation:
`-p`, `--model`, `--max-turns`, `--output-format stream-json`, `--verbose`,
`--dangerously-skip-permissions`. **No `--bare`.**

So: every Worker is a headless session spending the operator's subscription
window, and the operator's own interactive terminal draws on the same window.
There is no separate fleet budget to spend today.

### 5.2 Three concrete hazards

1. **`--bare` becoming the `-p` default.** Documented as coming. On the day it
   lands, a border-collie Worker stops reading `CLAUDE_CODE_OAUTH_TOKEN` and
   fails to authenticate — or, worse, succeeds against an `ANTHROPIC_API_KEY`
   that happens to be in the runner environment and starts billing silently.
   The mitigation is cheap and available now: decide explicitly whether Workers
   pass `--bare` (and therefore which credential they use) rather than inheriting
   whichever default ships. Note `--bare` also skips hooks, skills, plugins, MCP
   and `CLAUDE.md` discovery — border-collie's Worker prompt invokes a skill by
   name, so adopting `--bare` is not a one-line change.
2. **The breaker's cooldown is tuned for the wrong window.**
   `src/core/breaker.ts:27-28` caps the recovery probe at
   `BREAKER_MAX_COOLDOWN_MS = 60 * 60_000`, with the comment "rate limits clear
   in minutes, usage windows in hours". The five-hour session window fits that
   assumption. **The weekly cap does not.** A weekly-cap stall would leave the
   breaker probing hourly — one wasted Worker per hour — for up to seven days.
3. **The `usage-limit` classifier may not fire on the structured signal.**
   `src/core/classify.ts:20-23` matches
   `/usage[ _]limit|usage_limit_reached|out of extra usage|limit reached\|\d/i`.
   The strings Claude Code actually prints are `You've hit your session limit`,
   `You've hit your weekly limit`, `You've hit your Opus limit` — none of which
   contain "usage limit". Meanwhile the `system/api_retry` event's `error`
   enumeration ([`docs/en/headless`](https://code.claude.com/docs/en/headless))
   is `authentication_failed`, `oauth_org_not_allowed`, `billing_error`,
   `rate_limit`, `overloaded`, `invalid_request`, `model_not_found`,
   `server_error`, `max_output_tokens`, `unknown` — **there is no
   `usage_limit` category**, so a subscription cap most likely arrives as
   `rate_limit` or `billing_error`. Worth verifying against a real capped run
   before trusting the classification.

### 5.3 The crossover for *this* fleet is already measurable

`src/adapters/worker.ts:444-451` records `costUsd` from the stream-json result
event's `total_cost_usd` and compares it to `config.maxCostUsd`
(`DEFAULT_MAX_COST_USD = 20`) — a post-hoc **report**, not a ceiling. Those logs
are uploaded as artifacts by the Worker workflow. So §4.3's table can be
resolved from data the fleet already produces: read `total_cost_usd` across
recent Worker runs, and the break-even in sessions/day falls out.

Two caveats on that number, both primary. It is a list-price estimate, not a
bill ([`docs/en/costs`](https://code.claude.com/docs/en/costs)):

> Claude Code computes the dollar figure locally from token counts priced at
> standard list rates, so it doesn't reflect promotional pricing or contracted
> discounts and may differ from your actual bill.

and [`docs/en/headless`](https://code.claude.com/docs/en/headless) says the same
of the JSON output: "Both figures are client-side estimates and can differ from
your actual bill." On a subscription it is not a bill at all — it is the
list-price equivalent of the window the Worker consumed. Which, for sizing a
fleet against a cap, is exactly the right unit.

### 5.4 The fleet already has the lever, pointed elsewhere

`CONTEXT.md` "Working hours" suppresses "the quota-consuming actions (claims,
spawns, Conflict Workers)" during the operator's configured off-hours. That is
already a quota-shaping mechanism — it is simply aimed at the operator's sleep
rather than at the five-hour window or the weekly cap. If a rung of the v2
roadmap needs the fleet to pace itself against a limit, the seam exists.

### 5.5 Bearing on the #125 question

The roadmap question was whether operator-facing conversation should be driven
by the fleet or stay in the operator's interactive sessions. On the budget
argument alone: **there is no distinction to exploit.** Both spend the same
five-hour window and the same weekly cap on the same account. Driving
conversation from the fleet does not move spend to a different pot — it moves it
to a time when the operator is not watching the pot.

If that argument is to be revisited, the thing to watch is §2.5: the paused
Agent SDK credit. If it un-pauses, headless fleet usage acquires its own budget,
and the question genuinely changes.

---

## 6. What could not be verified

| Claim | Status |
|---|---|
| Absolute token/message allowance for any subscription tier | **UNVERIFIED** — Anthropic publishes only multipliers, and says the base varies by content |
| Any published limit on concurrent Claude Code sessions per account | **UNVERIFIED** — no primary source; secondary sources claim "none" |
| Whether Claude Code and claude.ai share one token bucket or separate buckets under one label | **UNVERIFIED** — "same usage limit" is stated; the internal accounting is not |
| That five-hour limits were doubled on 2026-05-06 | **UNVERIFIED** — surfaced during research, not found on any page fetched here; do not repeat without a source |
| Date the weekly caps were introduced | **SECONDARY only** — widely reported as announced 2025-07-28 / rolled out late Aug 2025; no primary page fetched here states it |
| Seat-based Enterprise Standard/Premium multipliers | **UNVERIFIED** — only Team multipliers are published |
| That an Anthropic legal page forbids subscription OAuth with the Agent SDK | **SECONDARY, and contradicted** by two primary docs pages — see §2.6 |
| Whether a subscription cap surfaces as `rate_limit`, `billing_error`, or prose | **UNVERIFIED** — no primary source maps the limit messages onto the `api_retry` error enumeration; needs an empirical check |
| Actual per-Worker cost for border-collie | **NOT MEASURED** — the data exists in `.border-collie/logs/*.jsonl`; see §5.3 |

## Sources

All fetched 2026-08-15.

- [claude.com/pricing](https://claude.com/pricing)
- [What is the Max plan?](https://support.claude.com/en/articles/11049741-what-is-the-max-plan)
- [What is the Pro plan?](https://support.claude.com/en/articles/8325606-what-is-the-pro-plan)
- [What is the Team plan?](https://support.claude.com/en/articles/9266767-what-is-the-team-plan)
- [How do usage and length limits work?](https://support.claude.com/en/articles/11647753-how-do-usage-and-length-limits-work)
- [Using Claude Code with your Pro or Max plan](https://support.claude.com/en/articles/11145838-using-claude-code-with-your-pro-or-max-plan)
- [Extra usage for paid Claude plans](https://support.claude.com/en/articles/12429409-extra-usage-for-paid-claude-plans)
- [Use the Claude Agent SDK with your Claude plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)
- [Claude Code — Manage costs effectively](https://code.claude.com/docs/en/costs)
- [Claude Code — Run Claude Code programmatically (headless)](https://code.claude.com/docs/en/headless)
- [Claude Code — Authentication](https://code.claude.com/docs/en/authentication)
- [Claude Code — Errors](https://code.claude.com/docs/en/errors)
- [Claude Code — GitHub Actions](https://code.claude.com/docs/en/github-actions)
- [Claude Code — Subagents](https://code.claude.com/docs/en/sub-agents)
- [Claude Code — What's new, week 32 2026](https://code.claude.com/docs/en/whats-new/2026-w32)
- [Claude API — Pricing](https://platform.claude.com/docs/en/about-claude/pricing)
- [Claude API — Rate limits](https://platform.claude.com/docs/en/api/rate-limits)
