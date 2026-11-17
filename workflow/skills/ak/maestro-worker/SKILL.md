---
name: maestro-worker
description: Implement one GitHub issue as a maestro worker, from branch to merged PR. Use when a task says to use the maestro-worker skill for an issue.
---

You are a maestro worker. Your task names the issue `<n>` and the repo. You own it end to end, through `full-send`: implement, prove, validate, open the PR, merge. The maestro reads GitHub, not this thread. You already run in an isolated checkout prepared for you.

## Pick up

1. `gh issue view <n>`. Read it whole, and its parent for context: `gh api repos/{owner}/{repo}/issues/<n>/parent --jq '.number, .title, .body'`. Older issues name the parent with a `Part of #<epic>` line instead.
2. Put the checkout on the task branch: `git fetch origin && git checkout -B task/<n> origin/main`. If `origin/task/<n>` exists, an earlier round left work behind: use `git checkout -B task/<n> origin/task/<n>` instead and read `gh pr view task/<n> --comments` for what went wrong.
3. If `.t3/setup-done` is missing and `.t3/setup-running` names no live PID, run the repo's install step.
4. If the issue lacks what you need to start, ask for help (below). Do not guess.
5. If the issue is a bug, find its cause with the `diagnosing-bugs` skill before fixing, and write the failing test first with the `tdd` skill.

## Ship it with full-send

6. Follow the `full-send` skill from its step 1 to its merge. It runs `validate-change` and `sol-loop`, files the PR with `file-pr`, and merges once its merge gate passes. The issue's request is the user's request, and its merge closes the issue. Three overrides, because you are a delegated child:
   - **Waiting.** Never call `watch_pull_request`. When the repo runs CI or review bots on the PR, wait with `~/.agents/skills/babysit-pr/scripts/pr-wait`, as `babysit-pr` describes. With neither, the gate needs only your proof, validation, and a mergeable branch.
   - **Asking.** Wherever `full-send` would ask the user, ask for help (below) instead.
   - **Reporting.** End with the final message below, not `full-send`'s report.

7. After the merge, if the issue's parent `epic` has no open sub-issues left, close it: `gh issue close <epic> --comment "every sub-issue is closed."`

## Ask for help

Do not merge when the change adds or edits a database migration, when a rebase conflict touches logic you do not understand or would drop someone else's work, or when you are stuck after a real attempt. Push what you have, open the PR if there is one, and hand over:

```bash
gh issue edit <n> --add-label needs-help
gh issue comment <n> --body "<what needs a decision, and what you would do>"
```

## Final message

Exactly one line, nothing else:

- `#<n> merged <PR url>`
- `#<n> needs-help: <why>`

If the maestro tells you the issue is still open, finish it or ask for help, then end with that line again.
