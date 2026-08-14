---
name: t3code-self-orchestration
description: Coordinates T3 Code from within T3 Code by creating helper threads, delegating prompts, monitoring progress, reading results, and merging findings back into the current chat. Use when the user asks a chat to control T3 Code, spawn or manage other threads, parallelize agent work, delegate tasks, or review results from other T3 chats.
---

# T3 Code Self-Orchestration

Delegate work from the current T3 thread through T3's authenticated MCP control plane.

## Core rule

Create every helper with `create_nested_thread`. This one call creates the child, records the
current thread as its parent, selects Copilot, sends the first prompt, and optionally creates the
child's isolated worktree. Do not assemble those steps with terminal commands or workspace tools.

## Quick start

If the MCP tool is deferred, load it with tool search, then call `create_nested_thread` with:

```json
{
  "project": "project id, title, or workspace root",
  "title": "Short child-thread title",
  "prompt": "Self-contained task and expected result",
  "model": "gpt-5.6-sol",
  "reasoning": "low"
}
```

`project`, `title`, `prompt`, and `model` are required. `reasoning` is optional and supports
`low`, `medium`, `high`, or `xhigh` only when the selected model exposes that setting.

## Delegation workflow

1. Decide whether delegation is worthwhile; keep simple lookups and tightly coupled edits local.
2. Resolve the project and choose an available Copilot model. Pass the model explicitly.
3. Write a self-contained child prompt with the goal, context, permissions, constraints,
   validation commands, and expected report.
4. If isolation is needed, include `workspace` in the same `create_nested_thread` call.
5. Call `create_nested_thread` once and capture its returned `threadId`.
6. Monitor by `threadId` only when needed, then consolidate the result in the parent.

## Workspace ownership

- Parent stays in its current workspace.
- Child without isolation: omit `workspace`.
- Child with isolation: pass `workspace: { mode: "isolated", branch, path, baseRef? }` to
  `create_nested_thread`; `path` must be absolute.
- `create_isolated_workspace` and `switch_workspace` always move the thread that calls them. Use
  them only when the current thread itself must move, never to prepare a future child.
- Never run raw `git worktree add` or `git worktree move` for T3-managed delegation.
- Never use terminal-based `t3 chat new`; it lacks the authenticated parent and can target the
  wrong app flavor.

## Child prompt contract

Helper prompts must be self-contained:

- Goal and expected output.
- Repository, branch, PR, issue, or file context needed to begin.
- Relevant decisions and constraints from this conversation.
- Whether the helper may edit code or should only investigate.
- Required validation and whether it may commit, push, or update a PR.
- A concise reporting format.

The child cannot see the parent conversation; include every required decision and constraint.

## Monitoring

Use point-in-time commands by child `threadId`:

```sh
t3 chat list --parent <threadId>
t3 chat show <threadId> --messages
t3 diff thread <threadId>
t3 checkpoint list <threadId>
t3 approval list --thread <threadId>
t3 input list --thread <threadId>
```

`t3 chat stream` is persistent and does not exit when a turn completes. Do not use it as an
attached completion waiter. Use approval/input skills only with the user's authorization.

## Failure handling

- Tool returns a `threadId`: creation committed; use that child for all follow-up.
- Tool fails without a `threadId`: report the error. If the response says creation may have
  committed or a child worktree was preserved, inspect the parent's children before retrying.
- Copilot reports `Missing namespace for function_call` or says the conversation cannot continue:
  do not retry in that parent. Its Copilot history is poisoned. Start a fresh controlling thread,
  inspect whether a child was created, and delegate from there.
- Never assume a failed response means no child or worktree exists when the outcome is ambiguous.

## Safety

Report facts, changes, blockers, open questions, and child IDs needed for follow-up.

Keep destructive operations in the parent unless explicitly delegated. Never delegate credentials.
Stop or interrupt a child only when requested or obsolete; report failures plainly.
