---
name: t3code-thread-review
description: Reviews and summarizes T3 Code threads through the t3 CLI, including messages, activities, checkpoints, diffs, exports, and archived threads. Use when the user asks to read another thread, summarize previous work, inspect a thread's state, compare changes, or export a conversation.
---

# T3 Code Thread Review

Use chat, checkpoint, diff, and export commands to understand work happening in another T3 Code thread.

## Quick start

```sh
t3 chat list
t3 chat show <thread-id-or-title> --messages
t3 checkpoint list <thread>
t3 diff thread <thread>
t3 export markdown <thread>
```

## Review workflow

1. Resolve the thread with `t3 chat list`, `t3 chat archived`, or a provided ID.
2. Read the thread with `t3 chat show <thread> --messages`.
3. Inspect checkpoints when file-change history matters: `t3 checkpoint list <thread>`.
4. Inspect changes when code/file output matters: `t3 diff thread <thread>`.
5. Export markdown only when the user needs a shareable artifact or long-form review.

## What to extract

When reporting back, include:

- Current status: active, archived, latest turn/session state if visible.
- User intent and latest assistant action.
- Important decisions, IDs, paths, commands, and unresolved questions.
- Pending approvals or user-input requests if present.
- Diffs/checkpoints only when they affect the answer.

## Diff and checkpoint commands

```sh
t3 diff turn <thread> <turn-count>
t3 diff thread <thread> --to-turn <turn-count>
t3 diff state <thread>
t3 checkpoint list <thread>
t3 checkpoint revert <thread> --turn-count <n> --yes
```

Only revert checkpoints when explicitly instructed. Reverts can discard later work.

## Export

```sh
t3 export markdown <thread> --editor cursor
```

Use export for durable handoff artifacts. For quick summaries, prefer `chat show --messages`.

## Safety

- Review is read-only unless the user explicitly asks for revert/export side effects.
- Do not infer completion from a thread title; inspect messages and latest turn state.
- If multiple threads match a title, stop and resolve by ID.
