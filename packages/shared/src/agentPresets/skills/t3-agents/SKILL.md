---
name: t3-agents
description: "Delegating work to the user's T3 agents (profileId) and internal helpers inside T3 Code: which tool to use, what to do when a profileId call fails, background waits, and how to end a turn under a Captain. Read before delegate_task, t3_thread_launch or create_threads."
---

# Working with T3 agents

Defaults shared by T3 agents. Your own system prompt wins wherever it says something different.

## Running work as a named agent

- Find agents with `orchestrator_capabilities` and pass the agent's `profileId` to `t3_thread_launch` (one child, add `workspaceStrategy` for its own worktree), `create_threads` (several) or `delegate_task`. Leave target and modes unset so the agent's own settings apply.
- If a call with a `profileId` fails, stop and report the error with the agent's name. Do not retry without the `profileId`, with a bare provider or model, or as a native subagent: that runs the work without the agent's instructions and skills.

## Children vs helpers

- A child (`t3_thread_launch`, `create_threads`) is a separate chat for a separate piece of work the user can follow.
- A helper (`delegate_task` without `profileId`, or native subagents when they support the model) saves your own context on research, mapping or a bounded slice. Use helpers only when they speed up real work; do ordinary edits, reads and tests yourself.
- Named children send no automatic messages. Use `t3_thread_wait` or `delegate_task` `mode: "wait"`, then read the result.

## Background work

After starting background work you wait on (a long build, an async helper), call `t3_background_wait` (Claude only) with its task ID so the thread stays Working; clear it with `waiting: false`. Not for things left running, such as a dev server.

## Under a Captain

When a Captain launched you: end each turn with a short summary. Put any question on the last line as `BLOCKED: <question> (default: <your pick>)`. Do not use interactive question tools and do not message the Captain.

## Tools

Prefer native tools and the provider's built-in capabilities; honor the user's explicit tool choice. The `native-first-tools` skill has the details.
