# Skills for the workflows

Which skill each session in `workflows.md` runs, what exists, and what is
still to write. A skill here means a `SKILL.md` a session loads by name: a
packaged set of instructions for one job, what to read first, and what done
looks like.

## Skills hold judgement, the daemon holds state

A skill is the right unit for how an agent does a job. It is the wrong
unit for three things, and drawing that line first keeps every skill
small.

- **Not a trigger.** What starts a session is the daemon, a schedule, or
  me. A skill never decides when it runs.
- **Not state.** Moving a ticket to in progress, opening the change, moving
  to in review, putting a ticket back to todo after a failure. These are
  the daemon's writes, or a hook's. An agent asked to remember a status
  transition forgets it one time in twenty, and that one time leaves the
  board wrong. This repo has already paid for that lesson once: a worker
  migrated labels from inside its own session and three tickets got
  double-dispatched before anyone noticed.
- **Not a permission.** What a session may touch comes from where it runs
  and what it was given, never from its instructions.

So a skill reads the tracker freely and writes code, tests, docs, comments
and new tickets. The status of the ticket it was started on is never its
to change.

## Session to skill

| Session in the workflow | Entry skill | Pulls in | Exists | To do |
| --- | --- | --- | --- | --- |
| Planning | `grill`, then `to-spec`, then `to-tickets` | research subagents | Upstream, to fork | `grill` shows options as bullets, not paragraphs. `to-tickets` writes to the tracker the daemon watches, with the label vocabulary below |
| Work, with me | `implement` | `tdd`, `code-review`, `codebase-design` | Upstream, to fork | Nothing beyond the fork |
| Work, autonomous | `implement` | Same | Yes | Nothing. The daemon's prompt is the only difference |
| Address review | `address-review` | `tdd` | No | New, small |
| Triage | `triage` | `tdd` for the failing test | No | New. The most novel one. Runs on every bug, no label needed |
| Fix, autonomous | `implement` | Same as work | Yes | Nothing. The worktree starts from the branch the ticket names, and the failing test is the spec |
| Smoke test | `smoke-test` | Browser driving | No | New. Blocked on a staging environment existing |
| Docs | `sync-docs` | `codebase-design` for the architecture parts | No | New |
| Refactor | `refactor-pass` | `codebase-design`, `implement` | Half | A wrapper that scopes one opportunity per change |
| Release | None | | This repo's own `release` skill covers this repo | Not an agent job. A tag and a pipeline |
| Review | None | | Hosted product | Becomes a row only if that changes |

Four new skills, one wrapper, and a fork of the seven I already use. The
fork comes first: every skill in the table, existing or new, lives in my
own library from then on, not in a plugin I install (LIFE-45).

## The new skills

Each sketch is inputs, steps, done. Enough to write from, not the skill
itself.

### `triage`

The one to write first, because its output shape decides how the fix
session starts.

- **Input.** A bug ticket. Reporter's words, maybe an alert payload, maybe
  a smoke test's evidence.
- **Steps.** Read the ticket and the relevant code. Decide whether the
  behaviour is intended. If intended, open a feature or enhancement ticket
  with the reasoning, link it, comment on the bug, and stop. If it cannot
  be reproduced, comment with what was tried, and stop. If reproduced,
  write a failing test that captures it, commit the test to a branch,
  push the branch to the remote, and open a new bug ticket carrying the
  reproduction steps, the branch name, and what was learned about the
  cause. Label the new ticket for agents. Link the new ticket to the
  original in both directions. What counts as a reproduction is the
  repo's third per-repo input: a failing test unless the repo says
  otherwise.
- **Done.** One of three outcomes, each written on the ticket: a detailed
  bug ticket linked and labelled, a feature ticket linked, or a comment
  saying it could not be reproduced. The daemon reads which one happened
  and sets the status and label accordingly.
- **Not done by the skill.** Fixing anything. Closing any ticket. Changing
  any ticket's status or the stop label.

### `address-review`

- **Input.** A change with review comments, and the ticket it links to.
- **Steps.** Read every unresolved comment. For each, either make the
  change and reply with what was done, or reply with why not and leave it
  unresolved for a human. Run the verify commands. Push once.
- **Done.** Every comment has a reply. The verify commands pass.
- **Not done by the skill.** Resolving a comment it disagreed with.
  Merging.

### `smoke-test`

- **Input.** A staging URL and the list of flows that count as smoke.
- **Steps.** Drive each flow in a browser. On a failure, capture the page,
  the console, the network log, and the exact step, and file one bug
  ticket per distinct failure with that evidence attached.
- **Done.** Every flow ran. Every failure has a ticket.
- **Input source.** The repo's smoke flows, one of the three per-repo
  inputs in `workflows.md` "Assumptions".

### `sync-docs`

- **Input.** A repo, and a list of which docs count.
- **Steps.** For each doc, find the code it describes and check the two
  still agree: names, commands, flags, diagrams, examples. Fix drift in the
  doc, never in the code. Open one change.
- **Done.** One change, docs only, with a summary of each drift found.
- **Input source.** The repo's doc list, one of the three per-repo inputs
  in `workflows.md` "Assumptions".

### `refactor-pass` (wrapper)

- **Input.** A repo.
- **Steps.** Run `codebase-design`'s deepening pass to find opportunities.
  Pick one. Implement it through `implement` with the opportunity as the
  spec. Open one change describing the opportunity and what changed.
- **Done.** One change, one opportunity.
- **Not done by the skill.** A second opportunity in the same change.

## Where skills live

In my own skills library, one repo I maintain, and from there vendored
into each target repository under its own skills directory. `init` does
the vendoring today from an upstream plugin, byte-identical, and leaves a
re-run alone. After the fork it vendors from my library instead, and the
byte-identical rule points there. Each target repo also gets an
`AGENTS.md` rather than a tool-specific instructions file, so the same
context reads for any agent (LIFE-45).

Owning the skills is what makes the new ones and the edits possible.
`grill` in bullets, `to-tickets` writing to Linear, `triage` at all: none
of those land in an upstream plugin on my schedule.

This matters for the session client: a session started in a worktree of
the repo loads the repo's skills with no extra setup. Anything that runs
agents outside a checkout would need another way to hand them their
skills.

## Labels the daemon reads

Two labels carry the whole control surface. The vendored triage vocabulary
has five (needs-triage, needs-info, ready-for-agent, ready-for-human,
wontfix); the workflow uses one of them and adds one.

| Label | Meaning | Set by | Removed by |
| --- | --- | --- | --- |
| ready-for-agent | The daemon may start an implementation session on this | Me on feature tickets, `triage` on the detailed bug ticket it creates | Nobody needs to. The stop label below overrides it |
| needs-human-attention | The daemon must not touch this ticket | The daemon, when a session fails or `triage` cannot reproduce or judges the behaviour intended | Me, once I have looked |

Bugs need no label to be triaged: the daemon triages every bug in todo
that does not carry the stop label, because triage changes no code.
Implementation always needs ready-for-agent, because it does. The
distinction is by action, not by ticket type, which is why two labels are
enough.

The daemon never closes a ticket on the agent's say-so. The one closure it
performs is the original bug after `triage` has filed the detailed ticket
and linked the two, because at that point the original is a duplicate by
construction.

## Open

- Whether `to-tickets` can be pointed at the daemon's tracker as it is, or
  needs a fork. The upstream setup skill abstracts over trackers, so the
  answer is probably configuration, not code.
- Whether `triage` should run the failing test in a container or a
  worktree. Follows whatever the session client does for isolation.
- The exact file the three per-repo inputs live in (smoke flows, doc
  list, what counts as a reproduction), and whether it is one file or
  three. One file, read by all three skills, is the guess.
