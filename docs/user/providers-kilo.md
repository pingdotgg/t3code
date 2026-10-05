# Kilo

T3 Code supports two Kilo providers: **Kilo** runs the Kilo CLI on the machine
running your environment, and **Kilo Cloud** runs tasks in Kilo's hosted sandboxes.
Add either one in **Settings > Providers**.

## Local Kilo

Install Kilo CLI 7.8.3, then add **Kilo** with its binary path and an account
profile. Each profile keeps its own credentials and session history. Sign in with
the official Kilo CLI against that profile; T3 Code never signs in for you. Refresh
the provider after signing in to load your models and agents.

Changing a profile's credentials ends its running sessions. Start a new thread to
continue with the new account; saved history stays readable.

Like [OpenCode](./providers-opencode.md), Kilo trusts its native configuration,
plugins, and MCP servers. Only open repositories and profiles whose configuration
you trust. Kilo 7.8.3 also loads `.kilo/mcp.json` and `.kilocode/mcp.json` from the
project. Configured MCP servers can start before any approval, so
[permission modes](./permission-modes.md) govern tool calls, not what Kilo loads.

Subagents run only with **Full access** in the default interaction mode. Restricted
modes and Plan mode disable them, because Kilo does not pass approval rules on to
child agents reliably.

## Kilo Cloud

Add **Kilo Cloud** with a profile directory signed in through the official Kilo
CLI, a GitHub repository Kilo can access, its branch, and a model. Then turn on
**Allow paid cloud execution**. Personal accounts are supported.

Prompts and the selected repository go to Kilo. T3 Code never uploads local files
or uncommitted changes, and each cloud thread works in its own remote worktree.
Start cloud threads at the project root. Local attachments, terminals, Git
actions, checkpoints, rewind, forks, and generated titles are unavailable in cloud
threads.

Cloud tasks require **Full access**: Kilo Cloud cannot apply restricted permissions
or Plan mode, so remote shell commands, edits, and subagents can run. Automatic
commits are disabled. Profiles with inherited setup commands, MCP servers, skills,
agents, or environment variables are rejected before a task starts.

### Costs

Cloud tasks spend Kilo credit on inference and sandbox time. The thread shows task,
result, sandbox, and billing status separately. A compute estimate can cover a
sandbox shared across your account, so it is not a per-task invoice. Closing T3 Code
does not stop a remote task, and **Stop** does not put the sandbox to sleep. T3 Code
never tops up credit.

### Stop, reconnect, and results

**Stop** asks Kilo to interrupt a running task and waits for confirmation. Once Kilo
reports the task complete, T3 Code keeps retrieving its result for up to five
minutes; **Stop** then cancels only that retrieval. If the result does not arrive in
time, the turn fails with a result-retrieval error. Reopening the thread's history
can still retrieve a late result without submitting the task again.

T3 Code never resends a prompt automatically. If it cannot confirm that Kilo
accepted a prompt, the thread keeps checking Kilo's history for it instead. When
that check cannot finish, the thread pauses and explains why; reopening history
retries the check. Switching accounts does not move or stop existing tasks.
