---
name: update-with-patch-md
description: Update a customized T3 Code fork from upstream without losing intent. Use for update, upgrade, rebase, sync, upstream conflicts, or retiring patches when root PATCH.md exists.
---

# Update with PatchMD

Rebase ordinary fork commits onto upstream, resolve conflicts from `PATCH.md`
intent, preserve displaced content, and verify before handoff.

## Hard rules

1. Never discard uncommitted work.
2. Create a recoverable Git ref before rewriting history.
3. Preserve conflicted downstream files as exact Git blob bytes before choosing
   upstream.
4. Reconstruct intent, not old text.
5. Ask before reconstruction, retirement, push, or deployment.
6. Roll back when required verification fails.

## Preflight

Read `AGENTS.md` and `PATCH.md`. Confirm the repository root, branch, clean
working tree, upstream remote and branch, active entries, and verification
commands. Stop if dirty. Fetch upstream and stop if it has no new commits.
Create `backup/pre-patchmd-update-<timestamp>` at `HEAD`; do not continue if the
ref cannot be created.

## Rebase

Rebase downstream commits onto upstream. For each content conflict:

1. Record `REBASE_HEAD`, its subject, and unmerged paths.
2. Save each path's exact downstream bytes from conflict stage 3 outside the
   worktree with `git cat-file -p :3:<path>`. Record downstream deletions
   explicitly. The backup ref remains the whole-branch rollback point; its
   branch-tip blob is not a substitute for the commit currently replaying.
3. Keep the upstream-based side (`--ours`) as the safe baseline. During rebase,
   `--theirs` is the downstream patch.
4. Continue, or skip an empty commit.

Write a manifest containing the repository, upstream ref, backup ref, conflict
paths, patch commits, subjects, and backup locations. Abort and restore the
backup ref on an unsupported rebase state.

## Audit intent

Review every active entry, including cleanly replayed work. Classify it as
preserved, satisfied upstream, needs reconstruction, or ambiguous. Evaluate
`Retire when` first. Show evidence and obtain approval before changing code or
retiring an entry. Compare new upstream code, backed-up downstream code,
`PATCH.md`, and the original commit. Never guess.

## Verify or roll back

Run all applicable `PATCH.md` verification commands. If a required check fails
while a rebase is active, abort it. Otherwise reset the branch to the backup
ref. Preserve recovery files and report the failure and locations.

## Review

Report upstream commits received, downstream commits replayed or skipped, every
customization's classification, checks, recovery locations, and branch state.
Stop before push or deployment unless explicitly approved. Re-fetch and use
`--force-with-lease`, never `--force`, for rewritten history.
