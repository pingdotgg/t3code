# Subagents and delegation

T3 Code supports running parallel agents—either spawned natively by a provider or delegated through T3 Code's orchestration tools—so a parent thread can split up research, implementation, or reviews across models, worktrees, or machines.

## Two kinds of subagents

| Type                         | How it starts                                                                                                                                                        | Interactive?                                | Where approvals go                                       |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | -------------------------------------------------------- |
| **T3-delegated subagent**    | Agent calls `delegate_task` (supports choosing another provider/model, an isolated git worktree, or a [linked machine](./remote-access.md#link-another-environment)) | Yes—has its own composer                    | In the child thread (and surfaced via parent)            |
| **Provider-native subagent** | Spawned internally by Claude, Codex, Cursor, Antigravity, fx, or Pi                                                                                                  | Read-only—message the parent thread instead | Bubbles up to the parent thread with the subagent's name |

> Tip: Type `@` and part of a model name (such as `@opus` or `@opus:opencode`) in your prompt to tell the agent which model to delegate to without changing the current thread's model.

## Follow and manage subagents

- **Inspect**: Click a subagent card in the conversation or open **Agents** in the thread to view its timeline.
- **Side panel vs. main view**: On web and desktop, subagents open as a tab in the right panel by default (`Cmd`/`Ctrl`-click or middle-click opens in the main view). Change the default in **Settings → Chat → Open subagents and side chats in**.
- **Stopping & archiving**: Pressing **Stop** on a parent thread also stops its delegated subagents. Wait for or cancel active delegated tasks before archiving the parent thread.
- **Permissions**: A delegated subagent can never exceed its parent thread's [permission mode](./permission-modes.md).
- **PR watching**: Subagents cannot watch pull requests—the parent thread watches PRs instead.
- **Linked machines**: Delegating to a linked machine runs a regular thread on that host and wakes the parent when done; you can watch it live (read-only) without pairing directly ([Read a linked machine's threads](./remote-access.md#read-a-linked-machines-threads)).
