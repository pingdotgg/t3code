---
description: Update all active worktrees with changes from main.
name: update-worktrees
---

Study @CUSTOMIZED.md.

The goal is to update all active worktrees with the latest changes from `upstream/main`, while preserving any intentional customizations made in their own branches, as well as any new or adapted behavior and implementations that have been added to `origin/main` since the last update.

$spawn-worktrees

To achieve this goal, your task is to instruct each subagent to fetch and merge `main` branch from `upstream` remote onto its current branch, preserving that branch's intentional customizations without blocking new upstream behavior.

Provide the subagents with all commit SHAs in `origin/main` since the last commit registered as updated, to apply the same conflict resolutions strategies to their own branches as well as any new or adapted behavior and implementations, related to their own branches, that have been added to `origin/main` since the last update. The idea is for each worktree branch to be consistent with `origin/main` but always remain focused in its own feature.

If their branch is already up to date with both `upstream/main` and customizations from `origin/main`, they can skip the verification and exit early, reporting only that their branch is already up to date.

Each worktree branch work should be individual and fully working standalone. If there is a specific md file in their own branch, update any stale or missing information in it.

As final verification, each subagent must spin up its own dev environment and use playwright to verify that branch's features. Since they will be working simultaneously, assign them unique ports for their dev environments to avoid conflicts.

When finished, each subagent is to report the status of the merge results, and you must then stop it explicitly.

Finally, update the last commit SHAs for the `main` branch of both the `origin` and `upstream` remotes in CUSTOMIZED.md, so that future updates can be tracked accurately. Also report on the update status of all branches, if anything significantly diverged from the implementation details in `origin/main` and why.
