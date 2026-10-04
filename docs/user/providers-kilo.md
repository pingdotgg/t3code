# Kilo

Add **Kilo** in Settings > Providers, select the Kilo CLI 7.8.3 binary and an
account profile, then refresh the provider. Profiles isolate credentials and native
session storage. Sign in with the official Kilo CLI separately; T3 never signs in
automatically. Changing credentials retires the old runtime and requires a new
thread. Saved history remains available.

## Local configuration and approvals

Like T3's OpenCode provider, Kilo trusts native runtime configuration, plugins and
MCP servers. Only open repositories and profiles whose configuration you trust.
Trusted native configuration and plugins can access this profile's credentials.
Configured MCP processes or connections can start before a model tool call or
approval. Supervised and Plan modes govern supported tool calls; they are not an
OS sandbox and do not isolate native configuration or MCP initialization.

Kilo 7.8.3 loads legacy `.kilo/mcp.json` and `.kilocode/mcp.json` even when
`KILO_DISABLE_PROJECT_CONFIG` is enabled. `KILO_PURE` suppresses external plugins,
not all MCP loading. T3 does not force either flag as a security boundary, rewrite
configuration, or patch the installed runtime. Explicit native settings remain
trusted. Background subagents stay disabled. Foreground child agents require Full
access with the default interaction mode. Plan mode disables them, even with Full
access, because Kilo does not inherit parent `ask` rules reliably.

T3 stops owned processes on normal shutdown. On Linux and macOS, it records their
process identity in T3's state directory and reaps processes from a dead T3 owner
on server startup, including when that account profile was removed or moved. Cleanup checks the recorded PID, start time, command and owner;
it never kills by executable name. Crash recovery on macOS and native Windows
process cleanup have not been verified in this environment. Older profile-local
records are recovered only if that original profile is reopened. Deleting or moving
T3's own state directory can lose cleanup records; T3 never guesses ownership from
a process name.

| Capability                                 | Local Kilo                                                           | Kilo Cloud                                                                              |
| ------------------------------------------ | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Prompts and follow-up                      | Native streaming, tools and reasoning                                | Full access; history updates, no token-streaming claim                                  |
| Concurrent sessions                        | Separate processes and account profiles                              | Separate task identities and remote worktrees; runs alongside local sessions            |
| History and recovery                       | Native history and resume                                            | Durable admission and result recovery; no blind paid resubmission                       |
| Stop                                       | Native abort and owned-process cleanup                               | Inference interrupt while running; local retrieval cancellation after remote completion |
| Approvals and questions                    | Native supported tool approvals and questions                        | Handles emitted interactions; cannot enforce restricted policy                          |
| Rewind, fork, checkpoints, text generation | Integrated with native sessions and T3 checkpoints                   | Not supported                                                                           |
| Subagents                                  | Foreground Full access and default mode only; restricted/Plan denied | Remote Full access may run them; child history not integrated                           |
| Clients                                    | Web/desktop/mobile selection, models, status and controls            | Account/repository/model settings and task status; local workspace actions disabled     |

## Cloud execution and costs

Add a separate **Kilo Cloud** instance in Settings > Providers. Select a profile
signed in through the official Kilo login, an accessible GitHub repository, its
branch and a model. Personal accounts are supported. Enabling paid cloud execution
allows prompts and that remote repository to be sent to Kilo. T3 never uploads
local checkout files or uncommitted changes. Each cloud thread has a remote worktree.

Cloud requires **Full access**. The deployed runtime does not apply custom agent
permissions, so T3 rejects restricted and Plan modes before paid admission. Remote
shell commands, edits and subagents can run. Automatic commits are disabled, but
this is not a read-only execution policy. Profiles with inherited setup commands,
MCP, skills, agents or environment variables are rejected before a new cloud task.
The local trust choice does not relax this cloud restriction.

A cloud thread cannot use local attachments, terminals, Git actions, checkpoints,
rewind, forks or background text generation. Switching accounts does not transfer
existing tasks or stop them. Reconnecting uses the saved task identity. Uncertain
admission is reconciled through paginated customer APIs, never automatically resent.

Cloud tasks spend Kilo credit for inference and sandbox use. Inference interruption,
a closed stream, remote completion and sandbox sleep are separate events. Task,
result, sandbox and compute status are shown separately. Compute estimates can cover
a shared account sandbox and are not a per-task invoice. Unknown or settling status
does not mean billing has stopped. T3 does not top up credit or force sandbox sleep.

## Results after remote completion

The customer `workspace_` API reports execution status separately from history.
T3 marks a completed task `awaiting_result` until it retrieves output correlated to
the original message, account, worktree and native session. A completed, textless
assistant or terminal tool-only outcome is valid; unrelated replies, unfinished
tools and outstanding interactions cannot finish the local turn.

Retrieval reads at most four pages per attempt, with a 100-cursor cycle limit,
backoff up to 30 seconds and a five-minute recovery window. Progress, next attempt
and deadline survive restart. A confirmed outstanding interaction gives the user
time to respond and renews that window. Missing output after the window produces a
specific local result-retrieval failure while preserving remote `completed`.
Reopening history can retrieve a late result without restarting the failed turn,
duplicating its messages or submitting a new paid task.

Stop while `awaiting_result` cancels local result retrieval. It does not send a
remote interrupt or claim the sandbox is sleeping. Stop during running inference
requests remote interruption and waits for confirmation; billing remains separate.

Local/cloud concurrency and recovery are covered by actual local CLI sessions and
loopback customer-contract tests. These do not replace live verification of every
deployed cloud behavior or native platform testing.

If preflight fails before the paid request is attempted, T3 ends that turn locally
and permits an explicit new turn. Interrupted or older admission records without
proof of that boundary remain uncertain. A timeout or an incomplete search never
permits automatic resubmission. Repeatedly unreadable admission candidates pause
automatic scanning; reopening history retries only reads. Remote task and billing
status remain unknown until Kilo confirms the original operation.
