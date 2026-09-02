# Engineering work artifacts

> For maintainers. Using T3 Code? See [docs/user](../user/).

Keep planned work out of the source tree. Code search should return the product as it exists, not a mix of current behavior and abandoned intentions.

## Current facts belong in the docs

Put durable architecture, constraints, and operational knowledge in `docs/internals/` or `docs/operations/`. Write these documents in the present tense and update them with the code they describe.

When the reason for a decision will matter after implementation, record it in the relevant internal document. Use a separate decision record under `docs/internals/` only when the rationale does not fit cleanly beside the current architecture.

## Planned work belongs in GitHub

Track active maintainer work in its GitHub issue or project item. The tracking item should state the outcome, constraints, and acceptance criteria, then link the pull requests that implement it. Split large efforts into one durable specification and small work items that can each close independently.

Close completed items. Update or delete invalidated work before starting the next implementation session. External proposals follow [CONTRIBUTING.md](../../CONTRIBUTING.md) and belong in Ideas discussions rather than issues.

## Temporary work stays temporary

Keep agent scratch files, exploratory research, transcripts, and session handoff notes outside the worktree. They are inputs to the work, not project documentation.

`.plans/` is gitignored as a safety net for legacy tools. Its presence does not make it an accepted project artifact. Pull requests must not add implementation plans or temporary research under another name.

A pull request records what changed and why. If a fact must survive after the pull request merges, update the relevant documentation. Otherwise, the tracking item and pull request are the record.
