---
description: Address all PR comments from worktrees that are not yet merged into main.
name: comments-from-worktrees
---

Study @CUSTOMIZED.md.

$spawn-worktrees

Your task is to simply instruct each subagent to use the $piz-comments skill. **You do not load this skill yourself**, its instructions are not meant for you, the skill will provide the subagents with the necessary task information.

This process will likely take a long time, possibly hours. There is no need to explicitly ask subagents for their current status; just wait patiently until they finish.

When all subagents finish, if at least one of them reported changes made, you use the $port-from-worktrees skill.
