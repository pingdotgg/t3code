---
name: t3code-threads
description: >-
  Create, inspect, message, and hand off T3 Code threads and managed worktrees.
  Use when the user asks for a new T3 thread, another agent with independent
  ownership, a worktree handoff, or work on an existing thread. For supervised
  background delegates, use t3code-orchestration. Ordinary coding needs no T3 tools.
license: MIT
---

# T3 Code threads

Use T3's MCP tools so conversations and checkouts stay visible in the user's
clients. Tool schemas and the running server's instructions take precedence over
these examples. Try a tool by name before declaring it unavailable; if it cannot
be used, report the error. Do not substitute Orca commands or start a provider CLI
outside T3.

## Choose the ownership boundary

| Request                                                      | Action                         |
| ------------------------------------------------------------ | ------------------------------ |
| Independent new thread or ownership handoff                  | `t3_thread_launch`             |
| Several independent threads in the current checkout          | `create_threads`               |
| Supervised background child or a child with its own checkout | `delegate_task`                |
| Move this conversation into a new worktree                   | `t3_worktree_handoff`          |
| Continue an existing conversation                            | Read it, then `t3_thread_send` |

Only create top-level threads when the user asks for them. A request for
subagents or parallel work alone does not ask for top-level threads. Preserve
T3's native-subagent routing for ordinary work that finishes within this turn;
use `delegate_task` when T3's runtime instructions require it.

## Start a thread in the right checkout

`t3_thread_launch` inherits the caller's project, model, and modes when omitted.
Outside a thread, pass a real `projectId` from `t3_project_list`, or `scratch:true`
for a new Scratch folder. Omit `message` for an idle thread.

```json
{
  "title": "Investigate upload failures",
  "message": "Find the cause of upload failures. Inspect only; report evidence and a proposed fix.",
  "workspaceStrategy": { "type": "root" }
}
```

For a new worktree, replace `workspaceStrategy` with:

```json
{
  "type": "worktree",
  "baseRef": "feature/uploads",
  "branch": "fix/upload-retry",
  "startFromOrigin": false
}
```

Verify the base ref in the actual project first. To stack work on the current
branch, use that branch as `baseRef` and `startFromOrigin:false`. Uncommitted
edits are not copied. A dependency on those edits needs integration first; do
not silently commit them. With no strategy, the new thread uses the **project
root**, even when this thread is in a worktree.

For an existing project worktree, use
`{"type":"existing_worktree","worktreePath":"<actual path>"}` after checking
`t3_worktree_list`. Creating a checkout in the shell does not bind a T3 thread to
it. Folder projects can use the root strategy without Git.

Keep the returned `threadId`, `runId`, and `link`. A launch has no retry key:
after an error or lost reply, inspect `t3_thread_list` before attempting another
launch. A matching title alone does not establish which run succeeded.

## Read, send, and wait

- Given a thread ID, call `t3_thread_read` before answering about its state or
  deciding what to send. Start with `view:"messages"`, a small `limit`, and a
  bounded `maxCharsPerItem`. Use `view:"activity"` for tool failures.
- Follow `nextPosition` with `afterPosition` while `hasMore` when more history is
  needed. For truncated text, use `itemId` and `textOffset:nextTextOffset`.
- `t3_thread_send` with `mode:"auto"` starts idle work, steers a running turn,
  or queues. Use `queue` for a separate follow-up turn, `steer` for a running
  turn's correction, and `restart` only when interruption is intended. A send
  receipt proves delivery, not completion. Retain its returned `runId`.
- For explicit supervision of a top-level thread, `t3_thread_wait` with that
  `runId` waits for the intended run. Read the result afterward. A timeout is
  not a failure. Follow `next` when present; it means end this turn and let T3
  wake it. Without `next`, another bounded wait is appropriate.
- Use `t3_thread_interrupt` for a top-level turn and `task_cancel` for a
  delegate. Neither operation deletes its worktree. Do not delete branches,
  checkouts, or conversations as routine cleanup.

Mention a thread with its returned `link` verbatim. Without one, use
`[title](t3-thread://v1/<exact threadId>)`. Report whether it was created, started,
queued, blocked, or completed, based on observed results. An ownership handoff
does not also authorize monitoring it to completion.

## Move this conversation

Call `t3_worktree_status` first. If already attached, report that state; handoff
cannot create another worktree for this thread. Otherwise call
`t3_worktree_handoff` **last in the turn** with a new `branch` and, if work should
resume immediately, a self-contained `continuationPrompt`. The move ends the
current provider session. Setup runs by default; inspect the returned
`setupScript` and `continuation` statuses instead of claiming success from the
path alone. Without a continuation prompt, the thread waits for the user.

## Shell entry point

Inside T3, prefer MCP. For a user explicitly operating an installed server from
the shell, `t3 thread --help` documents `list`, `start`, `send`, and `show`.
`start` and `send` accept a message of `-` from stdin and `--json`; `--wait`
prints the run result. `send` queues rather than interrupts. This is not an
alternate delegation or orchestration API. Use the configured environment;
do not start a second server or guess a home directory to bypass an error.

Adapted from [Orca's CLI skill](https://github.com/stablyai/orca/tree/main/skills/orca-cli)
for T3 Code's thread and worktree tools. See [LICENSE](LICENSE).
