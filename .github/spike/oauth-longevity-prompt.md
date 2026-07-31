Analyse this repository's source and test trees exhaustively.

This is a read-only exercise. Its purpose is to keep one Claude Code session
continuously busy for a long stretch of wall-clock time. Nothing you produce is
kept; the only thing that matters is that you keep working, in the open, until
the work is done or you are stopped.

## Hard constraints

Breaking any of these invalidates the run.

- Change nothing on disk. No file creation, modification, deletion, or move —
  no Write, no Edit, no shell redirection, no `mkdir`, no `rm`, no `mv`.
- Run no git command that writes. No `commit`, `add`, `checkout`, `switch`,
  `branch`, `push`, `merge`, `rebase`, `stash`, `tag`, or `config`. Read-only
  git (`log`, `show`, `status`, `diff`) is fine.
- Make no network call. No `curl`, no `wget`, no package install, no web fetch,
  no web search.
- Touch no issue tracker. No `gh` command of any kind.
- Read no environment variable and print none. No `env`, no `printenv`, no
  `echo $ANYTHING`, no reading `.env` or a credentials file. This session holds
  a live OAuth token in its environment and everything it writes to stdout is
  uploaded as a public artifact.
- Do not ask questions and do not stop early. This session is headless; there
  is nobody to answer, and stopping early is the one outcome that makes the
  measurement worthless.

## Pace

One tool call per message, always. Do not batch reads, do not issue tool calls
in parallel, and do not read two files in one step. Work one file at a time and
report on it before moving to the next.

This is not a style preference. The measurement needs a session that stays busy
for a long stretch of wall-clock time, and batching collapses that stretch to
nothing. A first run of this prompt covered thirty-nine files in forty-three
turns and finished in nine minutes, which answered nothing.

## Work

Do four passes, in order, over the same file list.

**Pass 1 — inventory.** List every file under `src/` and `tests/`, sorted
lexically by path. Report the list. This ordering is the spine of every pass
that follows; use it unchanged.

**Pass 2 — describe.** Walk the list in order, one file per step. Read each file
in full, then for every symbol it exports — function, type, interface, constant,
class — write two to four sentences covering: what it does, what it assumes
about its inputs and about the environment around it, and how it fails. Report
each file's descriptions as you finish it, rather than saving them all for the
end.

**Pass 3 — verify.** Walk the same list again in the same order, one file per
step. Re-read each file and check every description you wrote in pass 2 against
the code it describes. For each one, report either that it holds or what
specifically is wrong with it and what the corrected description is. Do not take
pass 2 on trust; the point of this pass is to look again.

**Pass 4 — cross-reference.** Go through every exported symbol you catalogued in
pass 2, in the same file order, one symbol per step. Search the repository for
its call sites, and report: how many there are, which layers they sit in
(`core`, `adapters`, `app`, `cli`, or tests), whether the symbol is covered by a
test that exercises it directly, and whether any call site contradicts the
description you settled on in pass 3. Keep going until every symbol has been
looked up. Do not sample, do not stop at the interesting ones, and do not
shorten the pass because it is repetitive — the repetition is the point.

Keep every description, correction, and cross-reference in your replies. Write
nothing to disk.

If you complete all four passes, close with one paragraph on what they together
say about how this codebase separates its pure core from its I/O adapters. It is
expected and fine to be stopped before you get there.
