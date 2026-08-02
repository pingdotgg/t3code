---
name: t3code-self-orchestration
description: Coordinates T3 Code from within T3 Code by creating helper threads, delegating prompts, monitoring progress, reading results, and merging findings back into the current chat. Use when the user asks a chat to control T3 Code, spawn or manage other threads, parallelize agent work, delegate tasks, or review results from other T3 chats.
---

# T3 Code Self-Orchestration

Use T3's authenticated MCP control plane for running work in other T3 Code threads.

## Quick start

Call `create_nested_thread` with the project, title, prompt, model, and reasoning level.
The tool supplies the authenticated current thread as the parent and routes through the
correct flavor-scoped CLI.

## Delegation workflow

1. Resolve the project from current context or with the flavor-scoped CLI when necessary.
2. Choose `gpt-5.6-sol` or `gpt-5.6-terra` and a reasoning level based on the delegated task.
3. Create a nested helper thread with the `create_nested_thread` MCP tool. Never use
   terminal-based `t3 chat new` for delegation: shell environment does not carry an
   authoritative current thread id and a globally installed CLI can target another app flavor.
4. Capture the returned `threadId`.
5. Monitor only when needed:
   - Use `t3 chat show <threadId> --messages` for a point-in-time result and to confirm
     the latest turn state.
   - `t3 chat stream <threadId>` is a persistent subscription. Never run it as an
     attached command to wait for completion; it does not exit when a turn completes.
6. If blocked, use approval/input skills only under the user’s authorization.
7. Summarize findings back in the current chat with thread IDs and decisive outcomes.

## Model selection

- `create_nested_thread` always uses the GitHub Copilot provider; never use a terminal CLI fallback.
- Choose between `gpt-5.6-sol` and `gpt-5.6-terra` by assessing the task rather than using a fixed default.
- Choose `low`, `medium`, `high`, or `xhigh` reasoning based on the task's complexity, ambiguity, and risk.
- Pass the selected model and reasoning explicitly to every `create_nested_thread` call.

## Prompting helper threads

Helper prompts must be self-contained:

- Goal and expected output.
- Repository/project context.
- Relevant constraints from the current conversation.
- Whether the helper may edit code or should only investigate.
- Required validation commands, if any.
- How to report results concisely.

Do not assume helper threads can see the current conversation.

## Parallel work selection

Good delegation targets:

- Independent investigations across unrelated modules.
- Long-running experiments or builds that do not block current reasoning.
- Code review / rubber-duck style checks of a plan or change.
- Reading and summarizing old T3 threads.

Do not delegate:

- Simple lookups that take a few direct tool calls.
- Edits requiring tight, local context unless the helper thread receives complete instructions.
- Sensitive approvals or credential decisions.

## Monitoring and consolidation

Use:

```sh
t3 chat show <thread> --messages
t3 diff thread <thread>
t3 checkpoint list <thread>
t3 approval list --thread <thread>
t3 input list --thread <thread>
```

When consolidating, distinguish:

- Facts established by helper output.
- Changes the helper made.
- Open questions or blocked work.
- Any thread IDs needed for follow-up.

## Safety

- Keep destructive operations in the current controlling thread unless explicitly delegated.
- Prefer creating a new helper thread over reusing an unrelated old thread.
- Create helper threads with `create_nested_thread` so nesting and flavor routing are enforced.
- Stop or interrupt helper threads only when the user asks or the task is clearly obsolete.
- Do not hide helper failures; report blocked or inconclusive results plainly.
