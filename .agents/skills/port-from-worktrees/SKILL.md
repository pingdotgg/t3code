---
description: Port any extra customizations or fixes from worktrees into the current branch.
name: port-from-worktrees
---

Study @CUSTOMIZED.md.

$spawn-worktrees

Instruct each subagent to report any extra customizations or fixes from its branch that do not yet exist in the current main branch.

When all subagents finish, analyse their findings, and update the current main branch with the extra customizations or fixes that need to be ported.
