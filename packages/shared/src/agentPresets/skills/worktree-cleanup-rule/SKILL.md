---
name: worktree-cleanup-rule
description: "Rule for disk and worktree cleanup: worktrees that are merged or have had no changes for more than 2 weeks are disposable. Remove them directly and never back them up. Read before any disk cleanup, worktree reclaim, or brief that asks for one."
---

# Worktree cleanup rule

A git worktree is disposable when either of these is true:

- **Merged:** its HEAD landed in the default branch (ancestor, patch-equivalent, the head of a merged PR, or a tree equal to the squash commit's tree).
- **Old:** it has had no commits and no file edits for more than 2 weeks (14 days). Ignore node_modules, .git and build output when checking mtimes.

Remove a disposable worktree directly.

## Never back worktrees up

Do not write patches, tars, git bundles or copies of a worktree before removing it, and never tell a child to. A backup puts the same wasted space back on the disk. Dirty or unpushed state in a worktree older than 2 weeks does not block removal.

## Still keep

- Primary checkouts, the repo's main working tree.
- Worktrees in live use: a running thread bound to it, a process with its cwd inside, or a held or stacked checkout another task still needs.
- Branches. Removing a checkout does not delete its branch; delete branches only when the user asks.

## How

- Follow the repo's AGENTS.md first when it says how to clean up.
- Ada-managed: `t3_reclaim_worktree` dry-run, then reclaim. If it refuses (it does after a squash merge), and `gh pr view <branch> --json state,headRefOid` shows MERGED with `headRefOid` equal to the worktree HEAD, or the worktree's tree equals the squash commit's tree, run `git worktree remove --force <path>` and then `git worktree prune`. Report any other refusal.
- Unmanaged: `git worktree remove --force <path>`, then `git worktree prune`.
- Build cache: remove only that worktree's own build outputs. Never clear shared caches such as `GOCACHE` or `GOMODCACHE`, model weights, databases or Docker volumes.
