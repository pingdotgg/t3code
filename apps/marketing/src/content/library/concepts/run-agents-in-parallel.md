---
title: "Run several coding agents in parallel"
description: "Organize parallel agent work in T3 Code with separate threads, worktrees, explicit file ownership, and a review process you can follow."
updated: 2026-11-04
sources:
  - label: "Theo demonstrates separate threads and a remote execution machine"
    url: "https://www.youtube.com/watch?v=q1D90-uGvBg&t=300s"
  - label: "Theo explains file ownership and bounded delegation"
    url: "https://www.youtube.com/watch?v=e1snsuY4lTI&t=481s"
  - label: "Theo demonstrates multi-provider review"
    url: "https://www.youtube.com/watch?v=uLGxb4F3SyI&t=361s"
  - label: "Working with threads and worktrees"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/thread-sidebar.md"
  - label: "Source control and review"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/source-control.md"
  - label: "Permissions"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/permission-modes.md"
  - label: "Portable handoffs"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/portable-handoffs.md"
faq:
  - question: "Can T3 Code run agents in parallel?"
    answer: "T3 Code supports separate tasks in separate threads and worktrees. It also lets you follow delegated work through Agents on web and desktop."
  - question: "How do I send one prompt to several models?"
    answer: "In a new T3 Code thread on web or desktop, Shift-click models in the model picker. Sending starts a separate thread and worktree for each selection; this requires a Git project."
  - question: "Does each agent need its own worktree?"
    answer: "T3 Code recommends New worktree when a task needs a separate branch and working directory. Independent worktrees separate edits, but you still need to review how changes combine."
  - question: "Where do I answer a subagent question?"
    answer: "T3 Code presents subagent approvals and questions through the parent conversation. Message the parent rather than trying to send messages to an agent-started subagent thread."
---

T3 Code lets you run separate coding tasks in parallel through threads and worktrees. Give each task a clear result, isolate changes when they need separate branches, and review the outputs before combining them. You can also send the same prompt to several models from a new thread on web or desktop.

## What work should you split between agents?

In [You're using AI agents wrong](/learn/videos/using-ai-agents-wrong), Theo demonstrates a workflow built around separate tasks, a dedicated execution machine, and worktrees. His example starts with a specific user problem and explicit priorities for the fix.

His later AGENTS.md discussion adds a constraint: state file ownership before several agents work in parallel so they do not collide. He also recommends matching delegation to the task instead of creating a panel for work one agent can finish in one pass.

Use those ideas to choose a split:

| Work to do                               | Suggested approach                                      |
| ---------------------------------------- | ------------------------------------------------------- |
| Fix unrelated problems in separate areas | Use separate threads and worktrees                      |
| Compare approaches to the same request   | Send one prompt to several models in isolated worktrees |
| Investigate a question without editing   | Ask for findings with a clear evidence requirement      |
| Change the same tightly coupled code     | Keep ownership with one implementation task             |

These are workflow recommendations drawn from Theo's examples. T3 Code provides the controls; you decide which tasks can proceed independently.

## How do you start independent tasks?

1. Choose the project and confirm its environment.
2. Start a new thread for the first task.
3. Select `New worktree` when it needs a separate branch and working directory.
4. Describe the intended result and the files or area the agent owns.
5. State how the agent should verify the change.
6. Start another thread for the next independent task.

On web and desktop, `Cmd+Enter` on macOS or `Ctrl+Enter` on Windows and Linux starts a new thread and opens another draft. The next draft keeps the chosen workspace mode and base branch. With `New worktree`, each submission creates its own worktree.

[Working with threads](/learn/threads/working-with-threads) covers the selection and navigation details. Confirm the project and environment each time, especially when you have the same project on several machines.

## How do you compare several models on one prompt?

In a new thread's model picker on web or desktop, Shift-click models to add or remove selections. Choose a base branch and send the prompt. T3 Code starts a separate thread and worktree for each selection while you stay in the new-thread composer.

This requires a Git project. A regular click in the model picker returns to a single selection.

For a useful comparison, give every model the same goal and verification requirement. Ask each to report the files changed, checks run, and remaining uncertainty. Compare the evidence and resulting diffs before deciding which approach to keep.

## How do you follow delegated work?

T3 Code's `Agents` view on web and desktop follows work delegated to subagents. On mobile, open a subagent from its conversation card or `Agents`. Stopping a thread also stops the subagents it delegated to.

Agent-started subagent threads do not take messages directly. Send your correction to the parent. If a subagent needs an approval or answer, the parent conversation asks for it.

Choose [permission modes](/learn/safety/permission-modes) deliberately for the work. Parallel execution does not remove approval requirements, and providers enforce modes differently. Subagent approval requests include the subagent's name so you can identify the request.

## How do you combine and review the results?

A worktree separates a checkout. It does not establish that two changes will work together. Review each change against its task, then check their combined behavior before considering the work complete.

T3 Code provides two useful comparisons. A turn diff shows the turn's own changes, excluding changes brought in by pulls, merges, or rebases. The branch comparison shows the broader change against the base branch. Use [source control and pull requests](/learn/workspace/source-control) for that review.

When you bring another provider into an existing task, inspect the context boundary as well. [Portable handoffs](/learn/threads/portable-handoffs) carry selected history, with limits. They do not copy the outgoing provider's reasoning, tool-call state, or attachments. Repeat any constraint that the next agent must retain.

Theo's demonstrated machine setup is one way to keep work separate from the laptop he uses for other tasks. It is an example, not a requirement to buy a particular computer or run a particular number of agents. Start with the concurrency you can review well.

## Next steps

Practice with two independent tasks using [threads](/learn/threads/working-with-threads) and [source-control review](/learn/workspace/source-control).

Return to [Ideas behind T3 Code](/learn/concepts) for the concepts behind the workflow.
