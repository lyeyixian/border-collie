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

## `ready-for-agent` is a trust boundary, not just a workflow state

Applying `ready-for-agent` to a Ticket asserts that its text is trusted input for a Worker — an autonomous agent holding a subscription credential and write access to the repository. Whoever applies the label is vouching for its content the same way they would for a shell command they're about to run. border-collie assumes it: it targets the operator's own repositories and own Tickets, and it does nothing to make a repository safe to point at issues or pull requests from strangers. Don't apply the label to a Ticket you would not want a session with your own credentials acting on unattended.
