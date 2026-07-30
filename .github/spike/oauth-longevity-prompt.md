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

## Work

Do three passes, in order, over the same file list.

**Pass 1 — inventory.** List every file under `src/` and `tests/`, sorted
lexically by path. Report the list. This ordering is the spine of the next two
passes; use it unchanged.

**Pass 2 — describe.** Walk the list in order. Read each file in full, then for
every symbol it exports — function, type, interface, constant, class — write
two to four sentences covering: what it does, what it assumes about its inputs
and about the environment around it, and how it fails. Report each file's
descriptions as you finish it, rather than saving them all for the end.

**Pass 3 — verify.** Walk the same list again in the same order. Re-read each
file and check every description you wrote in pass 2 against the code it
describes. For each one, report either that it holds or what specifically is
wrong with it and what the corrected description is. Do not take pass 2 on
trust; the point of this pass is to look again.

Keep every description and correction in your replies. Write nothing to disk.

When all three passes are complete, close with one paragraph on what the three
passes together say about how this codebase separates its pure core from its
I/O adapters.
