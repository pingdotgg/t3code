---
name: t3code-workspace-handoff
description: Moves the current T3 Code thread into a new or existing Git worktree using durable workspace handoff tools. Use when a task needs an isolated checkout, another branch or PR worktree, raw git worktree commands are blocked, or before attempting git worktree add, move, or remove.
---

# T3 Code Workspace Handoff

Use T3's workspace tools instead of mutating Git worktrees directly.

## Choose the operation

- Stay in the current workspace when isolation is unnecessary.
- Use `create_isolated_workspace` for a new worktree and new local branch.
- Use `switch_workspace` when the desired worktree already exists.
- Use `git worktree list --porcelain` only for read-only discovery.
- If a workspace tool is deferred, load its definition with tool search first. Never substitute a raw `git worktree add`, `move`, or `remove` command.

## Create an isolated workspace

1. Inspect the current branch, status, repository root, and existing worktrees without changing them.
2. Choose a descriptive, unique branch name.
3. Choose an unused absolute sibling path whose parent already exists. A good shape is `<repo-parent>/<repo-name>-<branch-slug>`.
4. Choose `baseRef` explicitly when the new branch must start from a PR head, remote branch, or ref other than the current branch.
5. Call:

```text
create_isolated_workspace({
  "branch": "fix/pr-75-review-feedback",
  "path": "/absolute/path/t3code-fix-pr-75-review-feedback",
  "baseRef": "origin/pr-head-branch"
})
```

6. After success, end the turn immediately. Do not read, edit, test, or run commands in the new worktree, and do not explain the handoff. T3 queues the continuation in the rebound workspace.

## Switch to an existing workspace

1. Find the exact absolute path with `git worktree list --porcelain`.
2. Confirm it belongs to the same repository and has a checked-out branch.
3. Call:

```text
switch_workspace({
  "path": "/absolute/path/to/existing-worktree"
})
```

4. After success, end the turn immediately under the same rules as creation.

## Edge cases

- If the desired branch is already checked out in a worktree, use `switch_workspace`.
- If the desired local branch exists but has no worktree, do not improvise with raw Git. Create a uniquely named branch from it with `baseRef`, continue in the current workspace, or report the limitation when the exact branch identity is required.
- If creation reports an uncertain binding failure, preserve the worktree and retry the binding with `switch_workspace` using the same path.
- If the target path exists but is not a valid same-repository worktree, choose a different path; never delete it automatically.
- Do not use `t3 chat set-branch` for the active thread's handoff. The workspace tools atomically bind the workspace and queue continuation.

## Non-negotiable safety

- Never run raw `git worktree add`, `git worktree move`, or `git worktree remove`.
- Never edit another checkout before T3 has rebound the thread to it.
- Never continue the current turn after a successful handoff tool call.
