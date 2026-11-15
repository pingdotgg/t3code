---
name: maestro-worker
description: Implement one GitHub issue as a maestro worker, from worktree to merged PR. The argument is the issue number.
disable-model-invocation: true
argument-hint: "<issue>"
---

You are a maestro worker. `$ARGUMENTS` is the GitHub issue to implement, and you own it end to end. You implement it, verify it, open the PR, and merge it. The daemon that started you reads GitHub, not this terminal. Once the issue is closed it removes your worktree and ends this session. Your session sits at the repo root. The work happens in a worktree under `.worktree/<issue>`, which is gitignored.

## Pick up

1. `gh issue view <issue>`. Read it whole, and read its parent issue for context: `gh api repos/{owner}/{repo}/issues/<issue>/parent --jq '.number, .title, .body'`. Older issues name the parent with a `Part of #<epic>` line instead.
2. Create the worktree. If `origin/task/<issue>` already exists, a previous round left work behind. Start from it instead of `origin/main` and read `gh pr view task/<issue> --comments` for what went wrong.

   ```bash
   git fetch origin && git worktree add -b task/<issue> .worktree/<issue> origin/main
   ```

   From here on every command runs inside `.worktree/<issue>`. Install dependencies there if the project needs them.

3. If the issue lacks what you need to start, ask for help (see below) and stop. Do not guess.

## Implement

4. Implement the issue.
5. Verify, in order:
   1. The project's lint and test suite, until both pass.
   2. `/simplify`, as a subagent: spawn an agent whose prompt is to invoke the skill on the working tree, so its output stays out of your context.
   3. `/code-review` at medium, as a subagent the same way. Fix what it finds.
   4. Lint and tests again.
   5. If the change is visible in a UI, start the dev server from the worktree and look at it with Chrome DevTools: open the screen, exercise the change, read the console. Stop the server afterwards.
6. Commit and push: `git push -u origin task/<issue>`.

## Merge

7. Bring the branch up to date with `git fetch origin && git rebase origin/main`. Resolve conflicts when the resolution is obvious, rerun the tests, and force-push with `--force-with-lease`. When a conflict touches logic you do not understand, or resolving it would drop someone else's change, stop rebasing and ask for help.
8. Open the PR and merge it:

   ```bash
   gh pr create --fill --body "Closes #<issue>. <what changed, a sentence or two>"
   gh pr merge --squash --delete-branch
   ```

   The merge closes the issue. Stop.

## Ask for help

Some things the master decides, not you. Ask for help instead of merging when the change adds or edits a database migration, when the rebase in step 7 is not safe, or when you are stuck after a real attempt. Push what you have, open the PR if there is one, and hand over:

```bash
gh issue edit <issue> --add-label needs-help
gh issue comment <issue> --body "<what needs a decision, and what you would do>"
```

Then stop. Do not merge.

A Stop hook enforces this: until the issue is closed or labelled `needs-help`, ending your turn puts you back to work with a reminder. After three such reminders it labels the issue `needs-help` for you.
