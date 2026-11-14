# SDK host protocol

The Conn Server and the SDK host speak JSON lines on the host's stdin and stdout, one object
per line. One host process serves every SDK driver and every session; today the only driver is
`claude` (`drivers/claude.mjs`, the official Claude Agent SDK). A driver module is imported the
first time a message names it. The host keeps state only for open sessions.

Every message that belongs to a driver names it (`driver`) and the provider instance
(`instanceId`); every message that belongs to a session carries its `sessionId`, chosen by the
server. Requests go both ways with ids: the server's `call`/`input`/`fn` get a `reply`; the
host's `request` (a callback the SDK made) gets a `response`.

## Server → host

| `t`        | Fields                                                             | Meaning                                                                                                     |
| ---------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `open`     | `driver`, `instanceId`, `sessionId`, `options`, driver extras      | Opens a session. `claude`: `query({prompt, options})` in streaming-input mode; `options` is the whole SDK option object as JSON. Extras: `subagentStartContext`, `wrap`. |
| `input`    | `sessionId`, `id`, `message`                                       | Pushes input into the open session (`claude`: an `SDKUserMessage`, a prompt or a steer with `priority`). Bounded queue (64); a `reply` acknowledges it. |
| `call`     | `sessionId`, `id`, `method`, `args`                                | A session method. `claude`: `interrupt`, `setModel`, `setPermissionMode`, `applyFlagSettings`, `setMcpServers`, `stopTask`, `backgroundTasks`, `initializationResult`, `mcpServerStatus`. |
| `response` | `sessionId`, `id`, `value` or `error`                              | Answers a host `request`.                                                                                   |
| `close`    | `sessionId`                                                        | Closes the session (`claude`: ends the prompt stream, `Query.close()`). An `end` follows.                  |
| `fn`       | `driver`, `instanceId`, `id`, `name`, `args`, driver extras        | A call with no session. `claude`: `forkSession`, `getSessionMessages`, `getSubagentMessages`, `resolveSettings`; extra `configDir` runs it with that `CLAUDE_CONFIG_DIR` (such calls run one at a time). |
| `shutdown` |                                                                    | Closes every session and exits once they ended (at most 15 s). EOF on stdin, SIGTERM and SIGINT do the same. |

## Host → server

Each line has a channel `ch`. New channels can be added; the server ignores ones it does not
know.

| `ch`    | `t`       | Fields                                                    | Meaning                                                                    |
| ------- | --------- | --------------------------------------------------------- | -------------------------------------------------------------------------- |
| `host`  | `ready`   | `protocol`, `node`                                        | Started. `protocol` is 1; the server stops a host that speaks another and ends its sessions with the reason. |
| `sdk`   | `msg`     | `driver`, `instanceId`, `sessionId`, `m`                  | One SDK message, as the SDK yields it.                                     |
| `sdk`   | `request` | `driver`, `instanceId`, `sessionId`, `id`, `kind`, `args` | The SDK asks the server. `claude` kinds: `canUseTool` (`args` = `{toolName, input, options}`, the SDK's options without `signal`), `elicitation`, `userDialog` (the SDK's request object). `id` is the CLI's request id. |
| `sdk`   | `cancel`  | `driver`, `instanceId`, `sessionId`, `id`                 | The SDK withdrew a request. No response is needed.                         |
| `sdk`   | `end`     | `driver`, `instanceId`, `sessionId`, `error?`, `exit?`, `stderr?`, `spawnError?` | The session ended. `claude`: after the CLI exited (or 10 s); `error` holds the SDK's `message`, `errorClass`, `telemetryMessage`; `stderr` the last 2 KiB of a CLI that failed before its first message. |
| `reply` |           | `id`, `ok`, `value` or `error` (`{message}`)              | Result of `input`, `call` or `fn`.                                         |
| `log`   |           | `level`, `text`                                           | The host's own log lines (the SDK's stderr stays on stderr).               |

## Adding a driver

Write `drivers/<name>.mjs` exporting `createDriver({describeError})`, which returns
`open(session, command)`, `input(session, message)`, `call(session, method, args)`,
`close(session)` and `fn(name, args, extra)`. The host gives each session `emit(message)`,
`request(kind, id, args, signal)` and `end(info)`. Add the module to `DRIVER_MODULES` in
`index.mjs`.

## What the `claude` driver adds to `options`

- `canUseTool`, `onElicitation`, `onUserDialog`: forwarded to the server as `request`.
- `hooks.SubagentStart` returning `subagentStartContext`, when given (T3's device-tool text).
- `spawnClaudeCodeProcess`, unless `wrap` is `false`: the T3 server's spawn. The CLI runs as
  `/bin/sh -c <watch script> t3-claude <claude> <args...>` in its own process group, with a
  fourth pipe (fd 3) that only the host holds: when it closes (also when the host dies), the
  watcher sends SIGTERM to the group and SIGKILL 5 s later. When the CLI exits, its group gets
  SIGKILL. While the CLI runs, its process tree is recorded every second, and what is still
  alive after it exits is killed (T3's descendant tracker).

## Bounds and failure rules

- A line may hold at most 16 MiB, both ways. The server drops a longer one; the host drops a
  longer command, and in place of a longer frame it writes a `log` line (or an error `reply`).
- At most 64 queued inputs per session, 256 open sessions.
- `close` cancels the session's open requests at once; an ended session rejects them too.
- When the host dies, every open session ends (`end` is synthesized by the server with "The
  SDK host exited"), the turn fails, and each `claude` child loses its fd 3 pipe: its watcher
  sends SIGTERM to the CLI's group and SIGKILL 5 s later. Jobs that left the group are not
  caught then (the descendant tracker lived in the host). Tested by
  `host_death_ends_sessions_and_children` in `conn-provider-support` (`sdk_host`).
- Each `msg` write waits while stdout is full, so a slow server slows the SDK and the CLI.
