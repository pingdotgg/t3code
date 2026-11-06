---
title: "Work with threads"
description: "Create and organize T3 Code threads, run separate tasks in worktrees, settle completed work, and understand checkpoints before restoring files."
updated: 2026-11-04
sources:
  - label: "Working with threads"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/thread-sidebar.md"
  - label: "Edit an earlier prompt"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/composer.md"
  - label: "Checkpoint behavior"
    url: "https://github.com/pingdotgg/t3code/blob/main/AGENTS.md#how-it-works"
  - label: "Vocabulary"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/internals/glossary.md"
  - label: "Sidebar archive action"
    url: "https://github.com/pingdotgg/t3code/blob/main/apps/web/src/components/Sidebar.tsx"
  - label: "Restore archived threads"
    url: "https://github.com/pingdotgg/t3code/blob/main/apps/web/src/components/settings/ArchivedThreadsPanel.tsx"
  - label: "Find the archive in settings"
    url: "https://github.com/pingdotgg/t3code/blob/main/apps/web/src/components/settings/settingsSearch.ts"
  - label: "Theo on the sidebar as an inbox"
    url: "https://www.youtube.com/watch?v=uLGxb4F3SyI&t=960s"
  - label: "Theo on background submission"
    url: "https://www.youtube.com/watch?v=NvVbCqDgfCs&t=1741s"
  - label: "Theo on settling and snoozing work"
    url: "https://www.youtube.com/watch?v=q1D90-uGvBg&t=1081s"
faq:
  - question: "How do I start a new thread in T3 Code?"
    answer: "Choose New thread in T3 Code, select the project and workspace mode, then send your task. Choose New worktree when code changes need a separate branch and directory."
  - question: "Does restoring a T3 Code thread undo my own edits?"
    answer: "T3 Code's Revert files too restores the workspace checkpoint and can undo your own edits. It is offered only in a worktree and is refused when another thread or agent session shares an overlapping directory."
  - question: "What is the difference between settling and snoozing?"
    answer: "T3 Code settles finished work into the Settled shelf without deleting the conversation. Snoozing hides a thread until its wake time."
  - question: "Can I start several T3 Code threads with the same prompt?"
    answer: "On web and desktop, Shift-click multiple models in a new T3 Code thread's model picker. Sending creates a separate thread and worktree for each selection, and requires a Git project."
---

T3 Code organizes each task as a thread with its own conversation and work history. Start separate threads for separate tasks, choose worktrees when changes need isolation, and use checkpoints when you need to compare or restore workspace files.

## Create a thread in the right workspace

1. Choose **New thread**.
2. Select the project that contains the work.
3. Check the provider, model, permission mode, base branch, and workspace mode.
4. Choose **New worktree** when the task needs a separate branch and working directory.
5. Describe the result you want and send the message.

On web and desktop, the default and project-grouped sidebars open a project picker when you have multiple projects. Shift-click starts in the current project. A project's own new-thread action also targets that project. The legacy sidebar always starts in the current project.

New threads carry your model and mode selections unless the destination project has its own model default. Branch and workspace mode follow your configured defaults. To keep using an existing worktree, choose **New thread in this worktree** from the branch toolbar.

On mobile, a new thread uses the current thread's project, then the last project chosen on that device. If neither exists, you pick a project. Disable `Settings → General → Use last project` to choose each time. Check the selected machine before sending remote work; see [remote access](/learn/remote/remote-access).

## Start a task without a project

Choose **or start without a project** under a new thread's heading, or select **No project** in the project menu. On web and desktop, `mod+alt+n` also starts this way. Each such thread gets its own folder under `~/.t3/scratch` by default.

Use this for work that does not yet belong in a repository. Branch, worktree, and diff controls stay hidden because the folder is not a Git repository. The option is unavailable when the T3 data directory itself sits inside a Git checkout.

If the task grows, choose **Turn into project** in the thread menu. Its folder becomes a project in place. You can then use **Initialize Git** for branch and diff controls. Deleting the thread leaves its scratch folder and generated files behind.

## Run several tasks without losing the next idea

From a new thread composer on web or desktop, press `Cmd+Enter` on macOS or `Ctrl+Enter` on Windows and Linux. T3 Code starts that thread and opens another draft immediately. The new draft keeps the workspace mode and base branch. Each submission in **New worktree** mode gets its own worktree.

To compare models on the same prompt, Shift-click models in the model picker. Send once to create separate threads and worktrees. This requires a Git project. See [running agents in parallel](/learn/concepts/run-agents-in-parallel) for the broader workflow.

For an existing conversation, learn how [messages and context](/learn/threads/messages-and-context) handle queued messages and steering. Those follow-up actions serve a different purpose from submitting a new background thread.

## Keep the sidebar useful

| Choose            | When to use it                                     |
| ----------------- | -------------------------------------------------- |
| **Pin**           | Keep a priority above active work                  |
| **Snooze**        | Return to work at a chosen time                    |
| **Settle thread** | Clear finished work while keeping its conversation |
| **Archive**       | Put a thread in the archive for later retrieval    |

The beta **Working** section folds running threads and work the agent says it is waiting on. Threads return to the active list when they finish, fail, or need an answer or approval. Pins remain visible. Change this per device in `Settings → General → Working section`.

When Working is enabled, active threads follow the order in which they return to you. Turn it off to restore your saved order and reorder active threads. The project-grouped beta sidebar disables Working and dragging.

Settling removes a pin. By default, inactive threads settle after three days, and merged pull requests can settle their linked threads. Pending questions, approvals, and ongoing work prevent automatic settlement. Change the rules in `Settings → Threads`, or disable **Auto-settle behavior** for one thread.

On web and desktop, archive and settle actions show **Undo** for five seconds. Undo restores the prior state. To share a prepared task or copy a conversation reference, read [prompt and thread links](/learn/threads/prompt-links). Access for another person is covered by [guest links](/learn/remote/guest-links).

To retrieve archived work on web or desktop, open Settings and search for **Archived threads**. Choose **Unarchive** on the saved thread. Use settlement for finished work you want in the sidebar's Settled shelf, or archive it when you prefer to retrieve it through settings.

## Edit an earlier prompt and restore files

A turn is one user-to-agent cycle. Each turn ends with a checkpoint, a saved workspace state T3 Code uses for diffs and restore.

1. Find the sent message and choose **Edit from here** on web or desktop.
2. Choose **Revert and keep changes** to rewind the conversation while retaining current files.
3. Choose **Revert files too** to restore the workspace checkpoint from before that message.
4. Edit the restored prompt and attachments, then send again.

File restore also undoes edits you made yourself. It is offered only for worktree threads. T3 Code refuses it when another thread or agent session uses the same directory or an overlapping folder. Threads in the main project directory rewind the conversation only.

Rewind removes the chosen message and later conversation from active thread and provider history. It requires provider support and does not undo external actions or separate provider memory.

## Next steps

- Inspect commands and changes in the [activity log](/learn/threads/activity-log), and use [issue triage](/learn/threads/triage) for app problems.
- Continue with another agent through [portable handoffs](/learn/threads/portable-handoffs), or recover older conversations through [thread migration](/learn/threads/thread-migration).
- Return to [threads and messages](/learn/threads) for the other conversation guides.
