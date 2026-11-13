# Helper protocol

The Conn Server and the helper speak JSON lines on the helper's stdin and stdout, one object
per line. stderr carries the helper's own log lines. One helper serves every Claude query of a
server; each query has an id `s` chosen by the server. The helper keeps state only for open
queries and drops it when a query ends.

## Server → helper

| `t`        | Fields                                     | Meaning                                                                                                                                                             |
| ---------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `open`     | `s`, `options`, `subagentStartContext?`, `wrap?` | Calls `query({prompt, options})` in streaming-input mode. `options` is the whole SDK option object as JSON; the helper adds only functions (below). |
| `call`     | `s`, `id`, `method`, `args`               | Calls `Query[method](...args)`: `interrupt`, `setModel`, `setPermissionMode`, `applyFlagSettings`, `setMcpServers`, `stopTask`, `backgroundTasks`, `initializationResult`, `mcpServerStatus`. `offer` queues a prompt (`args[0]`, an `SDKUserMessage`). |
| `answer`   | `s`, `id`, `value` or `error`             | Settles a callback (`canUseTool`, `onElicitation`, `onUserDialog`) with its result, or rejects it.                                                                 |
| `close`    | `s`                                        | Ends the prompt stream and calls `Query.close()`. The SDK closes stdin, waits about 2 s, then signals the CLI. An `end` follows.                                     |
| `fn`       | `id`, `name`, `args`, `configDir?`        | Calls a session-file function: `forkSession`, `getSessionMessages`, `getSubagentMessages`, `resolveSettings`. With `configDir` it runs with that `CLAUDE_CONFIG_DIR` (calls run one at a time). |
| `shutdown` |                                            | Closes every query and exits once they ended (at most 15 s). EOF on stdin, SIGTERM and SIGINT do the same.                                                          |

## Helper → server

| `t`        | Fields                                             | Meaning                                                                                       |
| ---------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `ready`    | `node`                                             | Started.                                                                                      |
| `msg`      | `s`, `m`                                           | One SDK message, as the query yields it.                                                      |
| `callback` | `s`, `id`, `kind`, `args`                          | The SDK called a callback. `kind` `canUseTool`: `args` = `{toolName, input, options}` (the SDK's options without `signal`). `elicitation`, `userDialog`: the SDK's request object. `id` is the CLI's request id. |
| `cancel`   | `s`, `id`                                          | The SDK aborted that callback (the CLI withdrew its request). No answer is needed.            |
| `reply`    | `id`, `ok`, `value` or `error` (`{message}`)       | Result of a `call` or `fn`.                                                                   |
| `end`      | `s`, `error?`, `exit?`, `stderr?`, `spawnError?`   | The query ended and its CLI exited (or 10 s passed). `error` holds the SDK's `message`, `errorClass`, `telemetryMessage`; `stderr` the last 2 KiB of a CLI that failed before its first message. |

## What the helper adds to `options`

- `canUseTool`, `onElicitation`, `onUserDialog`: forward to the server as `callback`.
- `hooks.SubagentStart` returning `subagentStartContext`, when given (T3's device-tool text).
- `spawnClaudeCodeProcess`, unless `wrap` is `false`: the T3 server's spawn. The CLI runs as
  `/bin/sh -c <watch script> t3-claude <claude> <args...>` in its own process group, with a
  fourth pipe (fd 3) that only the helper holds: when it closes (also when the helper dies),
  the watcher sends SIGTERM to the group and SIGKILL 5 s later. When the CLI exits, its group
  gets SIGKILL. While the CLI runs, its process tree is recorded every second, and what is still
  alive after it exits is killed (T3's descendant tracker).

## Bounds

- At most 64 queued prompts per query, 256 open queries.
- Callbacks wait only while their query is open; an ended query rejects them.
- Each `msg` write waits while stdout is full, so a slow server slows the SDK and the CLI.
