---
title: "Threads and messages in T3 Code"
description: "Use T3 Code threads to organize agent work, attach the right context, share prompts, switch providers, and recover older conversations."
updated: 2026-11-04
sources:
  - label: "Working with threads"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/thread-sidebar.md"
  - label: "Messages and context"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/composer.md"
  - label: "Portable handoffs"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/portable-handoffs.md"
  - label: "Prompt links"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/prompt-links.md"
  - label: "Files in question answers"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/question-attachments.md"
  - label: "Thread migration"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/thread-migration.md"
  - label: "Triage an issue"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/triage.md"
  - label: "Activity log"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/activity-log.md"
  - label: "Vocabulary"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/internals/glossary.md"
faq:
  - question: "What is a thread in T3 Code?"
    answer: "A T3 Code thread is a durable conversation and work history. A provider process can exit without deleting the thread."
  - question: "Can I switch agents without starting over?"
    answer: "T3 Code uses portable handoffs to transfer selected conversation history when you switch providers. It does not transfer the outgoing agent's reasoning, tool-call state, or attachments."
  - question: "How do I keep several T3 Code threads organized?"
    answer: "T3 Code lets you pin active priorities, snooze work until later, and settle finished threads. The Working section can fold work that does not need your attention."
---

T3 Code keeps agent conversations and work history in threads, so you can return to a task after the provider process exits. Use separate threads for separate tasks, attach evidence where it matters, and carry selected context between agents when the work changes hands.

## Start and organize a task

Begin with [working with threads](/learn/threads/working-with-threads) to choose a project, create a worktree, and manage active work. A project identifies a workspace directory on a particular environment. A worktree provides a separate Git checkout for a thread's code changes.

Keep those choices separate from the conversation itself. One turn is a user-to-agent cycle inside the thread. Checkpoints save workspace states for comparison and restore. Editing an earlier prompt can rewind the conversation, while restoring files has additional workspace restrictions.

Use pins for priorities you want to keep visible. Snooze a thread when you cannot act on it yet. Settle finished work to preserve the conversation while clearing the active list. These choices help you review the work that needs an answer without keeping every completed task in view.

## Give the agent the evidence it needs

Read [messages, files, and context](/learn/threads/messages-and-context) to attach screenshots, quote a response, reference another thread, and control follow-up messages. Context chips place a reference beside the instructions that explain it. A file upload goes to the environment running the thread.

When the agent asks for a screenshot or document inside a question, use [question attachments](/learn/threads/question-attachments). The answer's uploads stay separate from your normal prompt draft. That distinction matters when you already have another message prepared.

Use [prompt links](/learn/threads/prompt-links) when you want someone to open a prepared request. The recipient reviews a draft and sends it. Sharing a prompt and granting access to a conversation are separate tasks.

## Continue work across agents or versions

Choose a continuation path based on what changed:

| Your next task                              | Read this guide                                             |
| ------------------------------------------- | ----------------------------------------------------------- |
| Continue with another provider              | [Portable handoffs](/learn/threads/portable-handoffs)       |
| Find conversations after a V1-to-V2 upgrade | [Thread migration](/learn/threads/thread-migration)         |
| Give another thread selected evidence       | [Messages and context](/learn/threads/messages-and-context) |

A provider handoff selects saved history within a budget. It does not recreate native agent state. Migration preserves conversation text and thread metadata, but some older activity and checkpoint records do not become V2 timeline items.

## Investigate what happened

Use the [activity log](/learn/threads/activity-log) to inspect commands, output, exit codes, and file changes. A grouped summary helps you find an action; its result tells you what happened.

For a problem with T3 Code itself, start [issue triage](/learn/threads/triage). Your coding agent investigates the affected machine and asks before applying a fix or posting anything.

## Next steps

- Start a task with the [thread workflow](/learn/threads/working-with-threads), or [download T3 Code](/download) if you have not installed it.
- Read [running agents in parallel](/learn/concepts/run-agents-in-parallel) when you want several tasks underway together.
- Use the [library hub](/learn) to find provider, permission, and workspace guides.
