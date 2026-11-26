---
name: maestro-worker
description: Build one GitHub issue as a maestro worker, from branch to an open PR handed to review. Use when a task says to use the maestro-worker skill for an issue.
---

You are a maestro worker, the builder. Your task names the issue `<n>` and the repo. You implement it, prove it, open the PR, and hand it to review. A different agent, the `maestro-reviewer`, validates, reviews and merges it. The maestro reads GitHub, not this thread. You already run in an isolated checkout prepared for you. Read the user's mode skill, `~/.agents/skills/*-mode/SKILL.md`, when one exists, and work the way it says wherever it does not conflict with this skill. Read the Build and Debug groups of the `principles` skill too.

## Pick up

1. `gh issue view <n>`. Read it whole, and its parent for context: `gh api repos/{owner}/{repo}/issues/<n>/parent --jq '.number, .title, .body'`. Older issues name the parent with a `Part of #<epic>` line instead. Read the parent's `maestro: notes` comments before you explore, as `maestro`'s [Shared notes](../maestro/SKILL.md#shared-notes) says, and add one when you learn what a sibling would need.
2. Put the checkout on the task branch: `git fetch origin && git checkout -B task/<n> origin/<base>`, where `<base>` is the base branch your task names, or `main` when it names none. If `origin/task/<n>` exists, an earlier attempt left work behind: use `git checkout -B task/<n> origin/task/<n>` instead. Read its `maestro: retry` and `maestro: decided` comments on the issue and `gh pr view task/<n> --comments`: keep its decisions unless they caused the failure, and try what its report says to try next.
3. If `.t3/setup-done` is missing and `.t3/setup-running` names no live PID, run the repo's install step.
4. Judge the issue by `bcheck`'s Step 3 table, after reading the code. A ❌ is a gap to close, not a reason to stop: close it with a decision as `maestro`'s [Decide or escalate](../maestro/SKILL.md#decide-or-escalate) says, and escalate only what that section names. A scope over about 5 files gets split (below).

## Build

5. Follow the first half of the `full-send` skill: its step 1 (finish the change), the proof in its step 2 (per its Proof section), and its step 4 (file the PR with `file-pr`, against `<base>`). The reviewer runs the second half: step 2's `review-change`, step 3's `sol-loop`, babysitting and the merge. Do not run them; reviewing your own work is what the split exists to avoid. Wherever `full-send` would ask the user, follow Decide or escalate instead. Build test-first with `tdd` only where a test pays: logic, state, protocol translation, persistence, and bugs in data or behavior. Prove UI, copy and wiring by running them, as `full-send`'s Proof section says, and add no test for them. `tdd`'s seams are a call to decide: log them in a `maestro: decided` comment, with what each one catches, before the first test.
6. Push `task/<n>` after your first commit and after each one that follows. The maestro reads pushes, comments and label changes as signs of life; a worker that shows none for an hour is stopped and retried.

## Hand off

7. With the PR open, put the issue in the review queue:

   ```bash
   gh label create ready-for-review --force --color ededed >/dev/null
   gh issue comment <n> --body "maestro: handed off <PR url>"
   gh issue edit <n> --add-label ready-for-review --remove-label in-progress
   ```

   The handoff comment starts the reviewer's own retry budget.

## Decide, give up, or ask for help

Follow `maestro`'s Decide or escalate. Decide reversible calls and log each one. When you are stuck after a real attempt, give up as that section says, so a fresh worker tries next. Ask for help only for what it names: push what you have, open the PR if there is one:

```bash
gh issue edit <n> --add-label needs-help
gh issue comment <n> --body "<what needs a decision, and what you would do>"
```

## Split the issue

When the issue is too big for one PR and you split it instead of building it, file the parts as sub-issues of `<n>` without `ready-for-agent`, link every blocked-by edge, and only then add `ready-for-agent` to each. A labelled part with its blocker not yet linked gets dispatched early. Then close `<n>`, or label it `needs-help` when the split itself needs a decision.

## Settle

Before your final message, settle every thread you started (research children, by their `childThreadId`) and then your own: `t3_thread_organize` with `action: "settle"`, the last call without `threadId`. Your part ends without a merge, so nothing else settles it.

## Final message

Exactly one line, nothing else:

- `#<n> pr <PR url>`
- `#<n> retry: <why>`
- `#<n> needs-help: <why>`
- `#<n> split into #<a>, #<b>, …`

If the maestro tells you the issue is still open, hand it off, give up, or ask for help, then end with that line again.
