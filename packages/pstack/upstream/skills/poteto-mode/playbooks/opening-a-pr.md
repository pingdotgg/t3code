### Opening a PR

Open a PR when authorized. For independent child edits, use `delegate_task` with `isolation: "worktree"`. Arrange the committed base in the parent first and give each branch one writer. Stack follow-ups on their parent branches. Rebase into small, landable commits and simplify the diff before committing. Run **no-comments** before review.

Use `type(scope): subject` for the title. Write a body under 40 lines with these headings in order, omitting empty sections:

- `## Why`
- `## What changed`
- `## Scope`
- `## Tradeoffs`
- `## Blast Radius`
- `## Verification`

Use **technical-writing** and **unslop** for the prose. Link longer evidence, such as logs, screenshots, and recordings.

Use `gh` by default or `origin pr` when Origin's CLI resolves the repository. Open the PR ready for review. With Origin, pass `--status open`. With `gh`, omit `--draft`. Immediately after creating, taking over, or pushing to a PR, call `link_pull_request` with the full URL, once per stack layer. Report a linking failure.

Opening a PR does not start a babysit or authorize merging. A delegated child returns the PR URL, head SHA, and pending checks and reviews. The parent owns PR watches and sends any follow-up as a fresh `delegate_task` brief.
