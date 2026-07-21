---
name: t3code-self-orchestration
description: Coordinates T3 Code from within T3 Code by creating helper threads, delegating prompts, monitoring progress, reading results, and merging findings back into the current chat. Use when the user asks a chat to control T3 Code, spawn or manage other threads, parallelize agent work, delegate tasks, or review results from other T3 chats.
---

# T3 Code Self-Orchestration

Use the T3 CLI as a control plane for running work in other T3 Code threads.

## Quick start

```sh
t3 project list
t3 chat new \
  --project <project> \
  --parent "$T3_MCP_THREAD_ID" \
  --provider copilot \
  --model <gpt-5.6-sol|gpt-5.6-terra> \
  --reasoning <low|medium|high|xhigh> \
  --title "<delegated task>" \
  "<complete prompt>"
t3 chat stream <thread-id>
t3 chat show <thread-id> --messages
```

## Delegation workflow

1. Resolve the project with `t3 project list` unless the user provided a project ID/path.
2. Choose `gpt-5.6-sol` or `gpt-5.6-terra` and a reasoning level based on the delegated task.
3. Create a nested helper thread with `t3 chat new --project <project> --parent "$T3_MCP_THREAD_ID" --provider copilot --model <model> --reasoning <level> --title "<short task>" "<full prompt>"`.
4. Capture the returned `threadId`.
5. Monitor only when needed:
   - `t3 chat stream <threadId>` for live progress.
   - `t3 chat show <threadId> --messages` for a point-in-time result.
6. If blocked, use approval/input skills only under the user’s authorization.
7. Summarize findings back in the current chat with thread IDs and decisive outcomes.

## Model selection

- Always use the GitHub Copilot provider with `--provider copilot`; never use the Codex provider for helper threads.
- Choose between `gpt-5.6-sol` and `gpt-5.6-terra` by assessing the task rather than using a fixed default.
- Choose `low`, `medium`, `high`, or `xhigh` reasoning based on the task's complexity, ambiguity, and risk.
- Pass the selected model and reasoning explicitly to every `t3 chat new` invocation.

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
- Keep helper threads nested under the controlling thread with `--parent "$T3_MCP_THREAD_ID"`.
- Stop or interrupt helper threads only when the user asks or the task is clearly obsolete.
- Do not hide helper failures; report blocked or inconclusive results plainly.
