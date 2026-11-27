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

## Custom Orchestration

Custom Orchestration saves your delegation preferences so you don't repeat them in each prompt. One model, the orchestrator, runs the thread and hands work to the models you chose.

### Set it up

In **Settings → Orchestration** (web and desktop, including a phone browser), configure each environment:

- **Orchestrator**: the model and effort that run the thread.
- **Task kinds**: work such as deep thinking or machine learning, when to treat work as that kind, and the model that should do it.
- **Review commands**: a name such as `extreme-review`, optional instructions, and one or more reviewer models. Names use lowercase letters, numbers, and hyphens, and can't replace built-in commands such as `/review`.

Then choose **Custom Orchestration** in the model picker. Picking a model there again leaves the mode. The native mobile app doesn't offer Custom Orchestration, and changing the model or its settings there can take a thread out of it.

### Review

- Asking for a review in your own words uses the orchestrator's own review command, or the orchestrator reviews the work itself if its harness has none. Nothing is delegated.
- Starting a message with one of your commands, such as `/extreme-review the auth change`, sends the same brief to every reviewer. They work independently, then the orchestrator checks their findings and reports one merged list.

### Fallback models

The orchestrator, each task kind, and each reviewer can have up to three fallbacks, tried in order. A fallback stands in while the model before it can't run: its provider is disabled, signed out, or unavailable, the model is no longer offered, or it has reached a usage limit. T3 Code only knows about limits that the provider reports.

- A standing-in orchestrator is shown above the composer. For task kinds and reviewers, the orchestrator tells you which fallback it used.
- If delegated work fails on a limit partway through, the orchestrator is told to say so and try the next fallback.
- A failed orchestrator turn isn't retried for you. Your next message uses the fallback once T3 Code sees the limit.
- Messages T3 Code sends on its own, such as resuming after a limit, stay on the thread's current model.

When nothing configured can run, a task kind is skipped and a review continues without that reviewer, and the orchestrator says so. For the orchestrator itself, if its models are only at their limits, the message goes to the first of them so the provider can report the limit; otherwise you can't send until one can run.
