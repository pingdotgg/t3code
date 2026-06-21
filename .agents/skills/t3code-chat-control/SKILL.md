---
name: t3code-chat-control
description: Controls T3 Code chats/threads through the t3 CLI: create, list, show, rename, archive, fork, send prompts, stream events, interrupt, stop, and queue turns. Use when the user asks to create/manage T3 Code chats or threads, send work to another thread, read chat state, or control an active turn.
---

# T3 Code Chat Control

Use the `t3 chat` command group to operate T3 Code threads from inside a chat.

## Quick start

```sh
t3 chat list
t3 chat show <thread-id-or-exact-title> --messages
t3 chat new --project <project-id-or-path> --title "Task" "Prompt text"
t3 chat send <thread-id-or-title> "Follow-up prompt"
t3 chat stream <thread-id-or-title>
```

## Targeting rules

- Prefer stable IDs over titles.
- If only a title is available, use exact titles and handle ambiguity by listing chats.
- Use `--url` and `--token` only when controlling a remote server; otherwise let the CLI discover the local running server.
- Use `--base-dir` when the server uses a non-default T3 home.

## Workflows

### Inspect threads

1. Run `t3 chat list` to find active threads.
2. Run `t3 chat show <thread> --messages` to read full thread state.
3. Use `t3 chat archived` when the expected thread is not active.

### Create a new thread

1. Resolve the project with `t3 project list` if needed.
2. Run `t3 chat new --project <project> --title "<title>" "<prompt>"` for atomic create-and-send.
3. Capture the returned `threadId`.
4. Use `t3 chat stream <threadId>` when the user wants live progress.

### Send work to an existing thread

1. Confirm the target with `t3 chat show <thread>`.
2. Run `t3 chat send <thread> "<prompt>"`.
3. If the turn needs monitoring, stream with `t3 chat stream <thread>`.

### Manage lifecycle

```sh
t3 chat rename <thread> "New title"
t3 chat archive <thread>
t3 chat unarchive <thread>
t3 chat delete <thread>
t3 chat fork <thread> --message <message-id>
```

### Runtime/model control

```sh
t3 chat set-model <thread> --provider codex --model <model>
t3 chat set-runtime <thread> --runtime-mode approval-required
t3 chat set-interaction <thread> --interaction-mode plan
t3 chat set-branch <thread> --branch <branch> --worktree <path>
```

## Safety

- Do not delete, archive, interrupt, stop, or change runtime/model settings unless the user explicitly asks or it is necessary to complete the task.
- Prefer `chat new` over separate `chat create` + `chat send`; it rolls back if the first turn fails.
- Preserve returned IDs in your response or working notes so follow-up actions target the right thread.
