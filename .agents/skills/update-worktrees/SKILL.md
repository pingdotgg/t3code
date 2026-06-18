---
description: Update all active worktrees with changes from main.
name: update-worktrees
---

Study @CUSTOMIZED.md. Assume the `main` branch of the `upstream` remote has been merged into the `main` branch of the `origin` remote, with any conflicts resolved in favor of the upstream changes.

The goal is to update all active worktrees with the latest changes from `upstream/main`, while preserving any intentional customizations made in their own branches.

To achieve this goal, your task is to instruct new <five-high> subagents, one for each worktree, to fetch and merge `main` branch from `upstream` remote onto its current branch, preserving that branch's intentional customizations without blocking new upstream behavior.

Each subagent should know about their own branch's customizations; provide them directly with details taken from CUSTOMIZED.md as that particular file does not exist in each individual branch, including the name of the corresponding md file in their own branch to study if there is one.

If their branch is already up to date with `upstream/main`, they can skip the verification and exit only, reporting only that their branch is already up to date.

The subagent must remember incoming changes have been purposefully merged, the ongoing branch work is accessory and any conflicts should be resolved by working our changes around the incoming ones as necessary. For any conflicts, the subagent is to first look at how they were resolved in `origin/main`.

As final verification, each subagent must spin up its own dev environment and use playwright to verify that branch's features. Since they will be working simultaneously, assign them unique ports for their dev environments to avoid conflicts.

When finished, each subagent is to report the status of the merge results, and you must then stop it explicitly.
