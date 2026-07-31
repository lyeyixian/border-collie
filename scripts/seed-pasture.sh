#!/usr/bin/env bash
#
# seed-pasture.sh — create or reset the border-collie pasture.
#
# The pasture is a private throwaway sandbox repo used for manual verification
# runs of the orchestrator: triage labels, a parent (Scope) issue, and a small
# ticket DAG with a diamond dependency shape, wired via GitHub's native issue
# dependencies. Every ticket is trivially implementable so a full herd
# completes in minutes. Verification merges land here, never in border-collie.
#
# Usage:
#   scripts/seed-pasture.sh [owner/repo]
#
# With no argument the pasture is <your gh login>/border-collie-pasture.
# Re-running wipes the target back to a clean seeded state: all issues are
# deleted, open PRs closed, non-default branches, tags, and labels outside
# border-collie's fixed set deleted, and the default branch force-reset to a
# fresh seed commit.
#
# Refuses to target border-collie's own repo.

set -euo pipefail

FORBIDDEN_REPO="lyeyixian/border-collie"

log() { printf '==> %s\n' "$*"; }
die() { printf 'seed-pasture: %s\n' "$*" >&2; exit 1; }

lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

# owner/repo from a git remote URL (git@github.com:o/r.git or https://github.com/o/r)
repo_from_url() {
  printf '%s' "$1" | sed -E 's#^(git@[^:]+:|https?://[^/]+/)##; s#\.git$##'
}

# Print the header comment block (from line 2 down to the first non-comment line).
usage() { sed -n '2,${/^#/!q; s/^# \{0,1\}//p;}' "$0"; }

refuse_own_repo() {
  [ "$(lower "$TARGET")" != "$(lower "$1")" ] \
    || die "refusing to target border-collie's own repo ($TARGET)"
}

case "${1:-}" in
  -h|--help) usage; exit 0 ;;
esac

TARGET="${1:-}"
if [ -z "$TARGET" ]; then
  TARGET="$(gh api user --jq .login)/border-collie-pasture"
fi

printf '%s' "$TARGET" | grep -Eq '^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?/[A-Za-z0-9._-]+$' \
  || die "target must be owner/repo, got: $TARGET"

# --- Guard: never target border-collie's own repo ---------------------------

refuse_own_repo "$FORBIDDEN_REPO"

script_dir=$(cd "$(dirname "$0")" && pwd)
origin_url=$(git -C "$script_dir" remote get-url origin 2>/dev/null || true)
if [ -n "$origin_url" ]; then
  refuse_own_repo "$(repo_from_url "$origin_url")"
fi

OWNER=${TARGET%%/*}
NAME=${TARGET#*/}

README_CONTENT="# border-collie pasture

Throwaway sandbox repo seeded by border-collie's \`scripts/seed-pasture.sh\`
for manual verification runs. Everything here — issues, branches, file
contents — is wiped and re-seeded on every run. Keep nothing here.
"

# --- Ensure the repo exists -------------------------------------------------

if gh repo view "$TARGET" --json name >/dev/null 2>&1; then
  log "Pasture $TARGET exists — resetting it"
else
  log "Creating private pasture repo $TARGET"
  gh repo create "$TARGET" --private --add-readme \
    --description "Throwaway sandbox for border-collie verification runs" >/dev/null
fi

# A just-created repo can lag before the API sees its default branch.
default_branch=""
for _ in 1 2 3 4 5 6 7 8 9 10; do
  default_branch=$(gh repo view "$TARGET" --json defaultBranchRef \
    --jq '.defaultBranchRef.name // empty' 2>/dev/null || true)
  [ -n "$default_branch" ] && break
  sleep 2
done
[ -n "$default_branch" ] || die "could not determine default branch of $TARGET"

# --- Wipe: PRs, branches, tags, issues, tree --------------------------------

log "Closing open pull requests"
gh pr list --repo "$TARGET" --state open --limit 100 --json number --jq '.[].number' |
  while read -r n; do
    gh pr close "$n" --repo "$TARGET" >/dev/null
  done

log "Deleting non-default branches and tags"
gh api "repos/$TARGET/branches" --paginate --jq '.[].name' |
  while read -r branch; do
    [ "$branch" = "$default_branch" ] && continue
    gh api --method DELETE "repos/$TARGET/git/refs/heads/$branch" >/dev/null
  done
gh api "repos/$TARGET/tags" --paginate --jq '.[].name' |
  while read -r tag; do
    gh api --method DELETE "repos/$TARGET/git/refs/tags/$tag" >/dev/null
  done

log "Deleting all issues"
while :; do
  issue_ids=$(gh api graphql \
    -f query='query($o: String!, $n: String!) {
      repository(owner: $o, name: $n) {
        issues(first: 50, states: [OPEN, CLOSED]) { nodes { id } }
      }
    }' -f o="$OWNER" -f n="$NAME" --jq '.data.repository.issues.nodes[].id')
  [ -n "$issue_ids" ] || break
  for issue_id in $issue_ids; do
    gh api graphql \
      -f query='mutation($id: ID!) {
        deleteIssue(input: {issueId: $id}) { clientMutationId }
      }' -f id="$issue_id" >/dev/null
  done
done

log "Resetting $default_branch to a fresh seed commit"
blob_sha=$(gh api --method POST "repos/$TARGET/git/blobs" \
  -f content="$README_CONTENT" -f encoding=utf-8 --jq .sha)
tree_sha=$(gh api --method POST "repos/$TARGET/git/trees" --input - --jq .sha <<EOF
{"tree": [{"path": "README.md", "mode": "100644", "type": "blob", "sha": "$blob_sha"}]}
EOF
)
commit_sha=$(gh api --method POST "repos/$TARGET/git/commits" --input - --jq .sha <<EOF
{"message": "Seed pasture", "tree": "$tree_sha", "parents": []}
EOF
)
gh api --method PATCH "repos/$TARGET/git/refs/heads/$default_branch" \
  -f sha="$commit_sha" -F force=true >/dev/null

# --- Labels: the five triage labels plus border-collie's own claim label ----

TRIAGE_LABELS="needs-triage needs-info ready-for-agent ready-for-human wontfix"
CLAIM_LABEL="claimed"
KEEP_LABELS="$TRIAGE_LABELS $CLAIM_LABEL"

log "Ensuring triage labels"
ensure_label() {
  gh label create "$1" --repo "$TARGET" --color "$2" --description "$3" --force
}
ensure_label needs-triage    e4e669 "Maintainer needs to evaluate this issue"
ensure_label needs-info      d876e3 "Waiting on reporter for more information"
ensure_label ready-for-agent 0e8a16 "Fully specified, ready for an AFK agent"
ensure_label ready-for-human 1d76db "Requires human implementation"
ensure_label wontfix         ffffff "Will not be actioned"

log "Ensuring the claim label"
ensure_label "$CLAIM_LABEL" 5319e7 "border-collie: an agent Claim is held (CONTEXT.md \"Claim\")"

log "Deleting labels outside the fixed set"
gh label list --repo "$TARGET" --json name --jq '.[].name' |
  while read -r label; do
    case " $KEEP_LABELS " in
      *" $label "*) ;;
      *) gh label delete "$label" --repo "$TARGET" --yes ;;
    esac
  done

# --- Seed the ticket DAG ----------------------------------------------------
#
#   t1 ──▶ t2 ──▶ t4        t5 (independent root)
#    └───▶ t3 ────┘
#
# t1..t4 form the diamond; t5 exercises parallel dispatch of two roots.

# create_issue <title> <label-or-""> — body on stdin; prints the new issue number
create_issue() {
  local url
  if [ -n "$2" ]; then
    url=$(gh issue create --repo "$TARGET" --title "$1" --label "$2" --body-file -)
  else
    url=$(gh issue create --repo "$TARGET" --title "$1" --body-file -)
  fi
  printf '%s\n' "${url##*/}"
}

db_id() { gh api "repos/$TARGET/issues/$1" --jq .id; }

link_sub_issue() { # parent child
  gh api --method POST "repos/$TARGET/issues/$1/sub_issues" \
    -F sub_issue_id="$(db_id "$2")" >/dev/null
}

add_blocked_by() { # child blocker
  gh api --method POST "repos/$TARGET/issues/$1/dependencies/blocked_by" \
    -F issue_id="$(db_id "$2")" >/dev/null
}

log "Creating parent issue"
parent=$(create_issue "Spec: pasture phrasebook" "" <<EOF
A tiny phrasebook, built as a ticket DAG for border-collie verification runs.

This is the Scope parent: its sub-issues are the tickets. Four of them form a
diamond (create greetings → farewells / thanks → index), and one is an
independent root, so a run exercises parallel dispatch, dependency gating,
and the join at the bottom of the diamond.

Seeded by \`scripts/seed-pasture.sh\` — re-running that script resets this
repo and recreates this issue and its sub-issues from scratch.
EOF
)
log "Parent is #$parent"

log "Creating tickets"
t1=$(create_issue "Create the phrasebook with a greeting" ready-for-agent <<EOF
## Parent

Part of #$parent (Spec: pasture phrasebook).

## What to build

Create a \`phrasebook/\` directory at the repo root containing a single file
\`greetings.txt\` whose entire content is the line \`hello\`.

## Acceptance criteria

- [ ] \`phrasebook/greetings.txt\` exists and contains exactly one line: \`hello\`

## Blocked by

- None — can start immediately.
EOF
)

t2=$(create_issue "Add farewells to the phrasebook" ready-for-agent <<EOF
## Parent

Part of #$parent (Spec: pasture phrasebook).

## What to build

Add \`phrasebook/farewells.txt\` containing the single line \`goodbye\`,
following the one-word-per-line format established in #$t1.

## Acceptance criteria

- [ ] \`phrasebook/farewells.txt\` exists and contains exactly one line: \`goodbye\`

## Blocked by

- #$t1 (establishes the phrasebook directory and format)
EOF
)

t3=$(create_issue "Add thanks to the phrasebook" ready-for-agent <<EOF
## Parent

Part of #$parent (Spec: pasture phrasebook).

## What to build

Add \`phrasebook/thanks.txt\` containing the single line \`thanks\`,
following the one-word-per-line format established in #$t1.

## Acceptance criteria

- [ ] \`phrasebook/thanks.txt\` exists and contains exactly one line: \`thanks\`

## Blocked by

- #$t1 (establishes the phrasebook directory and format)
EOF
)

t4=$(create_issue "Index the phrasebook" ready-for-agent <<EOF
## Parent

Part of #$parent (Spec: pasture phrasebook).

## What to build

Create \`INDEX.md\` at the repo root: a heading \`# Phrasebook index\` followed
by a bullet list naming each file in \`phrasebook/\` with its first line, e.g.
\`- greetings.txt: hello\`.

## Acceptance criteria

- [ ] \`INDEX.md\` exists with a bullet per phrasebook file (greetings, farewells, thanks)
- [ ] Each bullet shows the file name and its first line

## Blocked by

- #$t2 (farewells must exist to be indexed)
- #$t3 (thanks must exist to be indexed)
EOF
)

t5=$(create_issue "Describe the pasture" ready-for-agent <<EOF
## Parent

Part of #$parent (Spec: pasture phrasebook).

## What to build

Create \`NOTES.md\` at the repo root containing a single sentence explaining
that this repo is a throwaway sandbox for border-collie verification runs.

## Acceptance criteria

- [ ] \`NOTES.md\` exists and says this is a throwaway border-collie sandbox

## Blocked by

- None — can start immediately.
EOF
)

log "Linking tickets as sub-issues of #$parent"
for t in "$t1" "$t2" "$t3" "$t4" "$t5"; do
  link_sub_issue "$parent" "$t"
done

log "Wiring the diamond via native issue dependencies"
add_blocked_by "$t2" "$t1"
add_blocked_by "$t3" "$t1"
add_blocked_by "$t4" "$t2"
add_blocked_by "$t4" "$t3"

log "Pasture ready: https://github.com/$TARGET"
log "Scope parent: #$parent — tickets #$t1 #$t2 #$t3 #$t4 (diamond) + #$t5 (independent)"
