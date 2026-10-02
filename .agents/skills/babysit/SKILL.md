---
name: babysit
description: Keeps a GitHub pull request moving by monitoring CI, reviews, mergeability, and scoped follow-up fixes until it is ready to merge. Use when asked to babysit, monitor, shepherd, or keep working on a GitHub pull request until it is green, review-ready, approved, mergeable, or ready to merge.
---

# Babysit

Use this skill to stay with a PR after it has been opened or while it is waiting on CI, reviews, mergeability, or small follow-up fixes.

The goal is: keep the PR moving until it is ready to merge. Do not merge the PR into its target branch unless the user explicitly asks. Merging the base branch into the PR branch to resolve conflicts is authorized maintenance and needs no separate confirmation.

## Start

1. Identify the PR.
   - Prefer the current branch's PR: `gh pr view --json number,url,title,headRefName,baseRefName,state,isDraft,mergeStateStatus,reviewDecision,statusCheckRollup`.
   - If there is no PR for the current branch, ask for the PR URL or number.
   - If the PR is closed or merged, report that and stop.
2. Declare the mode before polling (adapted from [backnotprop/pstack](https://github.com/backnotprop/pstack) `poteto-mode` babysit playbook, MIT):
   - `drive` (default): run the loop to merge-ready, for "babysit this", "get it green", "merge-ready".
   - `check`: one status pass and a report, for "check on X", "is it green", small or docs-only PRs.
   - `threads-only`: answer review comments and touch nothing else, for "address the review comments".
   - `background`: triage without blocking while other work is still executing.
3. State the current blocker in one short update:
   - draft PR
   - failing or pending checks
   - merge conflicts or stale branch
   - review requested
   - changes requested
   - ready to merge
4. If the PR is already ready to merge, report the URL and stop.

## Readiness Definition

Treat a PR as ready to merge when all of these are true:

- The PR is open and not a draft.
- Required checks are passing.
- There are no merge conflicts.
- The branch is current enough for GitHub to report it mergeable or clean.
- Reviews are approved, or the repo does not require approval.
- There are no unresolved requested changes or blocking reviewer comments.

If GitHub's mergeability is temporarily unknown, wait and re-check before calling the PR ready.

## Macroscope Monitors

Macroscope monitors are reviewers that focus on particular areas of the code. They are checks that return `conclusion: neutral`, but post a PR comment with a score and an explanation of what they found. Make sure you read the results of all the monitors and take their feedback into account.

## Loop

Repeat until the PR is ready to merge, blocked on a human decision, or the user stops you.

1. Refresh PR state.
   - `git fetch origin`
   - `gh pr view --json number,url,title,headRefName,baseRefName,state,isDraft,mergeStateStatus,reviewDecision,statusCheckRollup,reviews,comments`
   - `gh pr checks` or `gh pr checks --watch` when checks are pending.
2. Handle the highest-priority blocker first. Order is conflicts, then review threads, then CI. Batch every known fix into one push wave.
   - **Draft:** ask before marking ready for review unless the user already asked you to make it ready.
   - **Merge conflicts or stale base:** merge the base into the PR branch, resolve known conflicts, validate, commit, and push normally without another approval. Prefer this history-preserving path; rebasing or force-pushing requires explicit authorization. Ask only about ambiguous intent or narrower user restrictions. Never retarget the PR base or rewrite stack topology from inside a babysit; report rebase-shaped work upward.
   - **Failed checks:** classify before any retrigger. Flake or infra earns one fresh run, never a blind job retry; an identical second failure means it was never flake, so read the logs instead. A failure in code the diff never touches means a stale base, so check with `git merge-base --is-ancestor` before assuming flake. Only a failure in the diff's own code gets a code fix: inspect with `gh run view --log-failed`, fix the root cause, run focused local validation, commit, and push.
   - **Changes requested:** read review comments, make the requested changes when they are clear and appropriate, run focused validation, commit, and push. If a requested change is ambiguous, product-sensitive, or contradicts repo conventions, ask the user. Triage bot reviewers skeptically: verify each claim against the code, fix real findings in the lowest owning scope, and dismiss noise with the concrete disproof rather than churning code.
   - **Pending checks:** wait for the existing run instead of starting duplicate long-running validation. If a check appears stuck, report the stuck check and elapsed time before retrying or asking.
   - **Pending review:** leave a concise status for the user. Do not pester reviewers from the agent unless the user asks.
3. After each push, wait for checks to start and then continue monitoring.
4. Keep updates brief and factual: what changed, what is currently running, and the next check you are waiting for.

## Fixing Rules

- Read the relevant code before changing it.
- Keep fixes scoped to the PR blocker.
- Preserve unrelated worktree changes.
- Prefer focused validation before broad validation; run broader validation when the fix touches shared behavior.
- If a validation command is already running, wait for it or abandon it explicitly before starting another copy.
- If the same check fails twice for different reasons, keep investigating. If it fails twice for the same unclear reason, summarize the evidence and ask for help.
- If the PR requires a secret, external account, paid service, protected branch action, or reviewer decision that the agent cannot access, stop with the exact blocker.
- If an agent (e.g. Macroscope) commented on the PR and you believe it was mistaken, you can reply to its comment (signing the reply with your name).

## Useful Commands

```bash
git status --short
git fetch origin
gh pr view --json number,url,title,headRefName,baseRefName,state,isDraft,mergeStateStatus,reviewDecision,statusCheckRollup,reviews,comments
gh pr checks
gh pr checks --watch
gh run view <run-id> --log-failed
```

## Stopping States

Stop and report when:

- The PR is ready to merge.
- A human decision is required.
- A protected action is required.
- CI or GitHub is unavailable long enough that waiting is no longer useful.
- The user asks you to stop.

Final response format:

- PR URL.
- Current state: ready to merge, blocked, or still failing.
- What you fixed or verified.
- Any remaining human action.
