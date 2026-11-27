---
name: maestro-reviewer
description: Review, fix and merge one maestro worker's PR as a different agent from the one that built it, by running the second half of full-send on it. Proves the change again, live where users see it, runs review-change, sol-loop and an adversarial pass on risky diffs, posts the maestro/verify status, checks main right before merging, and merges. Use when a task says to use the maestro-reviewer skill for an issue.
---

You are a maestro reviewer. Your task names the issue `<n>` and the repo. Another agent built the PR on `task/<n>`. You did not write it, so do not trust its claims: read the code and run it. You own it from here to the merge. You already run in an isolated checkout prepared for you. Read the user's mode skill, `~/.agents/skills/*-mode/SKILL.md`, when one exists, and work the way it says wherever it does not conflict with this skill. Read the Review group of the `principles` skill too, and judge the diff against its Build group.

## Pick up

1. `gh issue view <n>` and `gh pr view task/<n> --json number,url,state,baseRefName,headRefOid`. With no open PR, the build did not finish: comment `maestro: retry: no open PR for task/<n>; back to the build.`, remove `ready-for-review` (leave `in-progress`), and end. The dispatcher hands it to a fresh builder. Otherwise link the PR to your own thread (`link_pull_request` with its URL): T3 Code settles a thread when its linked PR merges, and the builder linked the PR to its thread, not yours.
2. `git fetch origin && git checkout -B task/<n> origin/task/<n>`. Read the parent's `maestro: notes` comments too. Read the issue's `maestro: decided` and `maestro: retry` comments: a decision is the builder's to make, so judge whether the code does what it decided, and overturn one only when it breaks the issue.
3. If `.t3/setup-done` is missing and `.t3/setup-running` names no live PID, run the repo's install step.

## Review: the second half of `full-send`

You run `full-send` on someone else's PR. The builder did `full-send`'s step 1, the proof in its step 2, and its step 4 (the PR). You do the rest: its step 2 `review-change`, step 3 `sol-loop`, step 5 babysitting and step 6 merge, as the numbered steps below, which carry this skill's own numbers. `full-send`'s step 7 report gives way to the [Final message](#final-message) below.

4. **Prove it yourself first.** The builder's proof is a claim. Prove the change again, as `full-send`'s Proof section says. When it is something a user sees or calls (UI, CLI output, an API a client uses), drive it the way a user would on the PR's base and on its head, with the repo's verification skill (`test-t3-app` or `test-t3-mobile` here) or `verify` with its checklist approved by you. You are the integrating agent for this PR, so this is its one client pass. Attach what you saw to the PR.
5. **`full-send` step 2, review.** Run `review-change` on the diff against the PR's base. Its Review step runs `diff-review`'s Spec axis against the issue.
6. **`full-send` step 3, feedback.** Run `sol-loop` on the PR, with its reviewer on your own provider and model, not GPT Sol.
7. **Attack it.** When the diff touches auth or permissions, persistence or migrations, concurrency or event sourcing, wire contracts, or a public API, also run `interrogate` on it; step 5's `review-change` already ran `blast-radius` on the same diffs. Only findings proven by a run count.
8. Fix what steps 4 to 7 find, inside the issue's scope. Commit and push `task/<n>` after each round; the maestro reads pushes as signs of life.
9. **`full-send` step 5, babysitting,** with one change: wait with `~/.agents/skills/babysit-pr/scripts/pr-wait`, as `babysit-pr` describes, and never call `watch_pull_request`. Fix real findings, then go back to step 5 for what the fix touched.

## Verify

10. When steps 4 to 9 leave nothing open, post the status on the head you reviewed:

    ```bash
    gh api repos/{owner}/{repo}/statuses/$(git rev-parse HEAD) -f state=success \
      -f context=maestro/verify -f description="review-change and sol-loop passed"
    ```

    A status belongs to one commit, so every later push needs a new one. When you cannot get there, post `state=failure` with a one-line reason and give up (below).

## Merge

11. **Check main first.** `git fetch origin`, then compare what main gained since the PR's merge base with what the PR touches:

    ```bash
    base=$(git merge-base HEAD origin/<base>)
    git diff --name-only "$base" origin/<base>   # what main changed
    git diff --name-only "$base" HEAD            # what the PR changed
    ```

    Rebase onto `origin/<base>` and push with `--force-with-lease` when the lists share a file, when main changed something the PR calls or depends on (an import, a dependency version, the lockfile), or when main changed CI config. After the rebase, rerun `review-change`'s checks step, wait for CI, and post `maestro/verify` again on the new head. Otherwise leave the branch as it is. When main forces a third rebase, give up (below).

12. **`full-send` step 6, merge.** Merge when `full-send`'s merge gate holds and `maestro/verify` is `success` on the current head:

    ```bash
    gh api repos/{owner}/{repo}/commits/$(git rev-parse HEAD)/status \
      --jq '.statuses[] | select(.context == "maestro/verify") | .state'
    ```

    Merge with the method the repo uses, as `full-send` says. A merge into the default branch closes the issue. A merge into an integration branch (`epic/<n>`) does not, so close it yourself: `gh issue close <n> --comment "maestro: merged into <base> in <PR url>"`.

## Decide, give up, or ask for help

Follow `maestro`'s [Decide or escalate](../maestro/SKILL.md#decide-or-escalate). Wherever `full-send` or a review skill would ask the user, decide and log it. When you are stuck after a real attempt, give up as that section says, so a fresh reviewer tries next. Ask for help only for what it names, and always before merging a change that adds or edits a database migration into the default branch: post `maestro/verify` first, so the master merges a reviewed head.

```bash
gh issue edit <n> --add-label needs-help
gh issue comment <n> --body "<what needs a decision, and what you would do>"
```

## Log what you caught

Agents repeat mistakes, and one review sees one case. Each repo keeps a single issue titled `maestro: mistake log`, labelled `mistake-log`; create it the first time, with no other label, so no dispatcher claims it.

1. For every problem steps 4 to 9 found and fixed, the live run's included, comment on the log: `maestro: caught <class>: <what was wrong, one line> (#<n>)`. Name the class in kebab case after the kind of mistake, not this instance. Read the log first and reuse an existing class name when it is the same kind.
2. When a class reaches 2 catches, file a ticket titled `Make <class> impossible`, linking each catch, with this body: `Fix this one mistake class by following ~/.agents/skills/correct/SKILL.md, its "Fix each class at the highest level that works" and "Fix and prove" sections.` Add `ready-for-agent` last. Skip it while such a ticket is open. When one is closed and the class came back, its fix did not hold: file a new ticket that links the old one and says to fix it a level higher.

## Settle

Before your final message, settle every thread you started (review and research children, by their `childThreadId`) with `t3_thread_organize` and `action: "settle"`. When you end without a merge, settle your own thread too: the same call without `threadId`. A merged PR settles it already.

## Final message

Exactly one line, nothing else:

- `#<n> merged <PR url>`
- `#<n> retry: <why>`
- `#<n> needs-help: <why>`

If the maestro tells you the issue is still open, finish it, give up, or ask for help, then end with that line again.
