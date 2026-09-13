# Message artifacts

An artifact is an interactive HTML page named in a `t3-artifact` fence and saved with its reply. Code
and events call it a message artifact. These notes record decisions and traps.

## Setting and instructions

`enableMessageArtifacts` ("Interactive artifacts") is a server setting projects can override. A run
resolves it when it starts; with it on, runtime instructions carry a `<message_artifacts>` block.
Codex, Cursor, the ACP flavors (including Antigravity and Grok) and OpenCode send instructions with
every turn, so a change applies to the next run. Claude Code puts them in the system prompt when its
query opens, so a change applies once that query reopens. Pi is not taught the fence. Turning the
setting off stops new instructions and captures; artifacts already recorded stay with their replies
and clients can hide them.

## Captured once, when the run ends

Run end queues `message-artifact.capture` whenever the setting was on for the run, for every terminal
status. There is no in-memory "fence seen" flag: a steering restart starts an attempt with fresh state
and a server restart loses it. The attempt that finalizes the run queues, and the worker reads every
finished reply of the run, so fences from superseded attempts count. Provider runtime recovery queues
the same effect for each run it cancels, with the setting as the project resolves it now. The effect
id is per run and the capture commits `message.artifacts-recorded` under a command receipt, so a retry
records nothing twice; a run whose replies name no fence commits nothing.

Only replies a provider finished in the run capture, from the workspace of the run's own thread.
Imported v1 history has no run end. Messages the orchestrator writes, such as a delegated result
posted into its parent, keep their fences as code, and so do provider-native subagent replies routed
through a parent run.

A recorded entry keeps the `sourceOrdinal` and `sourcePath` it was captured for, and capture copies
only fences without a matching entry, so a later edit to the workspace file cannot change an old
reply. Clients render an entry only while the fence at its ordinal still names its path.

A missing, non-file, outside, empty or over-1 MB file is skipped and its fence stays code. Other read
errors, such as a file another process holds open, fail the effect so the worker retries it.

Providers re-publish messages and turn items without `artifacts`, so projections keep the stored
value when the new payload omits it, like `delegatedCompletion` on runs. The SQL upserts look for
`"artifacts"` in the stored row before calling JSON functions, so ordinary upserts never parse JSON.

## Containment and cleanup

The fence path is checked before any file I/O, so a crafted path cannot name a network share or a file
outside the workspace. A link inside the workspace is resolved before it is refused, which can touch
its target; this guards against a crafted fence, not an agent that already has shell access.

Deleting a thread adds recorded copies to its attachment cleanup. A capture that finds its thread
deleted after copying removes its copies and records nothing.

## Clients

Copies are `text/plain` attachments served as sandboxed downloads, so nothing runs on the server's
origin. Clients fetch the text once per mount and run it from `srcDoc` (web and desktop) or an HTML
string (mobile WebView). Desktop replaces the Content-Security-Policy of assets it proxies, and a
`srcDoc` frame behaves the same for local and remote environments; it inherits the app policy, which
excludes `unsafe-eval`.

Pages speak the
[MCP Apps](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx)
protocol, so a page written for another MCP Apps host works unchanged; T3 Code adds
`t3/notifications/state-changed` because MCP Apps has no state API. The host keeps form values,
`window.t3.setState` data and the last height in memory and injects them into the rebuilt document,
rather than keeping frames mounted off screen against the virtualized timeline.

CSP cannot stop a sandboxed frame from navigating itself. Web stops the artifact on a second frame
load, after that request was sent; the mobile WebView refuses navigation, with an origin whitelist of
`*` so refused URLs are not handed to the operating system. The shared rule, bridge and native
markdown split live in `@t3tools/client-runtime/message-artifacts`, used by web `MessageArtifactCard`
and mobile `MessageArtifactPreview`.
