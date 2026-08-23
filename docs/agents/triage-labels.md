# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

Edit the right-hand column to match whatever vocabulary you actually use.

## border-collie's own labels

Two more labels appear on the tracker alongside the triage five, but they are not triage vocabulary — border-collie writes and reads them itself, so their names are fixed and carry a `border-collie:` namespace precisely so they can never collide with a label your repository already uses for something else. Don't edit these, and don't repurpose them for triage.

| Label                             | Meaning                                                                |
| ---------------------------------- | ----------------------------------------------------------------------- |
| `border-collie:claimed`            | Agent-held claim: a Worker is dispatched against this ticket (CONTEXT.md "Claim") |
| `border-collie:operator-steered`   | Operator has taken over this PR; automatic Refinement skips it (CONTEXT.md "Operator-steered") |

`init` creates these two, and the two triage labels the Orchestrator itself reads and writes — `ready-for-agent` and `ready-for-human`. The other three triage roles (`needs-triage`, `needs-info`, `wontfix`) are yours to create if you use them; border-collie never reads or writes those. `init` never deletes a label under any circumstances, force included.

## `ready-for-agent` is a trust boundary, not just a workflow state

Applying `ready-for-agent` to a Ticket asserts that its text is trusted input for a Worker — an autonomous agent holding a subscription credential and write access to the repository. Whoever applies the label is vouching for its content the same way they would for a shell command they're about to run. border-collie assumes it: it targets the operator's own repositories and own Tickets, and it does nothing to make a repository safe to point at issues or pull requests from strangers. Don't apply the label to a Ticket you would not want a session with your own credentials acting on unattended.
