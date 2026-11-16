---
name: maestro-worker
description: Implement one GitHub issue as a maestro worker, from branch to merged PR. Use when a task says to use the maestro-worker skill for an issue.
---

You are a maestro worker. Your task names the issue `<n>` and the repo. You own it end to end: implement, verify, open the PR, merge. The maestro reads GitHub, not this thread. You already run in an isolated checkout prepared for you.

## Pick up

1. `gh issue view <n>`. Read it whole, and its parent for context: `gh api repos/{owner}/{repo}/issues/<n>/parent --jq '.number, .title, .body'`. Older issues name the parent with a `Part of #<epic>` line instead.
2. Put the checkout on the task branch: `git fetch origin && git checkout -B task/<n> origin/main`. If `origin/task/<n>` exists, an earlier round left work behind: use `git checkout -B task/<n> origin/task/<n>` instead and read `gh pr view task/<n> --comments` for what went wrong.
3. If `.t3/setup-done` is missing and `.t3/setup-running` names no live PID, run the repo's install step.
4. If the issue lacks what you need to start, ask for help (below). Do not guess.

## Implement

5. Implement the issue.
6. Verify against the real artifact, per the `prove-it-works` skill, in order:
   1. The project's lint and tests, until both pass.
   2. A simplify pass over your diff: reuse, simplification, dead code, per the `laziness-protocol` skill and the subtract-before-you-add principle (`~/.agents/skills/principle-subtract-before-you-add/SKILL.md`). Do it yourself or delegate it to a subagent.
   3. Judge every test you added or changed by the `principle-test-behavior-not-implementation` skill. Rewrite or delete the ones that fail it.
   4. Delegate to a subagent (in T3 Code: `delegate_task`, `role: "review"`) that follows the `diff-review` skill against `origin/main`. Fix what it finds.
   5. Lint and tests again.
   6. If the change is visible in a UI, use the project's verification skill if it has one. Otherwise start the dev server, look at it with T3 Code's `preview_*` tools, exercise the change, read the console, and stop the server.
7. Commit and push: `git push -u origin task/<n>`.

## Merge

8. `git fetch origin && git rebase origin/main`. Resolve obvious conflicts, rerun the tests, and `git push --force-with-lease`. If a conflict touches logic you do not understand, or resolving it would drop someone else's work, stop and ask for help.
9. Open the PR and merge it. Do not wait for CI and do not watch the PR.

   ```bash
   gh pr create --fill --body "Closes #<n>. <what changed, a sentence or two>"
   gh pr merge --squash --delete-branch
   ```

   The merge closes the issue. Stop.

## Ask for help

Do not merge when the change adds or edits a database migration, when the rebase in step 8 is not safe, or when you are stuck after a real attempt. Push what you have, open the PR if there is one, and hand over:

```bash
gh issue edit <n> --add-label needs-help
gh issue comment <n> --body "<what needs a decision, and what you would do>"
```

## Final message

Exactly one line, nothing else:

- `#<n> merged <PR url>`
- `#<n> needs-help: <why>`

If the maestro tells you the issue is still open, finish it or ask for help, then end with that line again.
