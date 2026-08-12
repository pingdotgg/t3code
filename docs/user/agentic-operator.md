# Operator

Operator lets one task coordinate model-specific implementation tasks without driving the T3 Code UI. It is disabled by default for the environment.

## Use Operator

1. Open **Settings > Operator** and enable **Operator**.
2. Tell the coordinator which tasks to delegate, including the provider, model, reasoning level, and whether to use the current checkout or a new worktree.
3. Keep the requested task scopes separate when they will run in parallel.

For example:

> Implement the web UI with Opus 5 at high effort and the server with GPT-5.6 Sol at max effort. Run both in one new worktree, then integrate them with GPT-5.6 Sol at high effort.

The coordinator reads the live provider inventory before spawning work, so it uses exact model slugs and supported option values from the connected environment.

## What happens

- Every delegated task is a normal durable top-level T3 Code sidebar task with its own provider session, model selection, and conversation.
- Operator tasks are separate from native provider subagents and workflows shown in **Agents**.
- Parallel tasks use the same selected checkout. Their prompts tell them to preserve concurrent edits and stay within their assigned scope.
- The Operator panel shows each task's title, provider instance, model, reasoning effort, status, and elapsed time.
- The coordinator waits on T3 Code's event stream rather than repeatedly asking models for status.
- When delegated work finishes, the coordinator receives each task's final handoff and can create a later integration task.
- Completed, failed, or stopped Operator tasks can be resumed with individual follow-up instructions. Resume reuses the same task, provider, model, checkout, branch, and conversation history.
- A new Operator worktree runs the project's configured setup script once before its task turns start.

Disabling Operator prevents new Operator actions across that environment. Existing Operator tasks remain available in the thread list.

Web and desktop show the detailed roster in the Operator right-panel surface. Operator-created tasks also appear in the normal task list on every connected client.

Operator currently follows the models and workflow named in your prompt. Model defaults and broader Operator settings are not part of this first version.
