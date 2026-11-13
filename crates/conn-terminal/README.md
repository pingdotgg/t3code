# conn-terminal

Shells on PTYs for the Conn Server: `terminal.*` and `subscribeTerminalMetadata`. The T3
server's `apps/server/src/terminal/Manager.ts` is the reference for behaviour; this crate is our
own design. `conn-server/src/methods/terminal.rs` serves it.

## Costs

- One tokio task per terminal, no thread. The PTY master is non-blocking and sits on tokio's
  reactor (`pty-process` with `async`). One poller task checks running terminals every second.
- Scrollback: at most 512 KiB and about 5000 lines per terminal. The T3 server keeps 8 MiB in
  memory but sends at most 512 KiB: the web client asks for 512 KiB, and a new session inherits
  at most 512 KiB from disk.
- Per subscriber: a queue of at most 1 MiB (T3: 8 MiB). A viewer further behind gets a fresh
  snapshot instead of the backlog, as in T3.
- Per stream: at most 4 values of at most 16 KiB wait for the session, so a chunk stays near the
  64 KiB ack window. The session applies the window's byte limit to pending chunks but does not
  cap one chunk's size; this keeps chunks small.

Measured on macOS arm64 with the real web client (`fixtures/recorder`, `rust-terminal`), RSS /
`footprint` of the server process:

| Moment                                | RSS      | Footprint |
| ------------------------------------- | -------- | --------- |
| Connected, no terminal                | 6.0 MiB  | 2.7 MiB   |
| One idle terminal                     | +112 KiB | +112 KiB  |
| Peak during `yes \| head -c 50000000` | +6.4 MiB | +6.5 MiB  |
| After it, and after close             | +6.4 MiB | +6.3 MiB  |

The peak is the subscriber queue, a resync snapshot and their JSON copies; the allocator keeps
the pages afterwards. The T3 server in the same run: 524 MiB idle, 1059 MiB peak.

## Lifetime

| Event                      | What happens                                                                              |
| -------------------------- | ----------------------------------------------------------------------------------------- |
| Client disconnects         | Its streams end; the shell keeps running; the shared grid may grow back                   |
| Client reconnects          | `attach` with `resume`: a snapshot with the scrollback, or `closed` if closed             |
| Shell exits                | `exited`; the terminal stays listed with its scrollback (128 kept)                        |
| `terminal.close`           | SIGHUP to the shell and the running command, SIGKILL after 1 s; `closed`                  |
| Thread deleted or archived | The engine calls `close` without `terminalId`, with `deleteHistory`                       |
| Thread settles             | The engine calls `close_on_settle`: `stopOnSettle` terminals close                        |
| Server stops or dies       | The PTY masters close; the kernel sends SIGHUP to each shell, which passes it to its jobs |
| Server restarts            | `attach` with `cwd` starts a new shell under the old scrollback, with a reset             |

`examples/hold_shell.rs` shows the last row: kill its process with SIGTERM or SIGKILL and its
shell and the shell's job are gone a second later. `TerminalManager::shutdown()` stops shells
in order (SIGHUP, then SIGKILL) and flushes scrollback; `main.rs` does not call it yet, so
scrollback written in the last 250 ms before a stop is lost.

Scrollback is kept in `<state-dir>/terminals/`, one file per terminal, at most twice the cap.
History drops terminal queries (cursor position, device attributes, colour queries), so a
client replaying it does not answer them again into the new shell. Live output is unchanged.

## Read API for agents

The T3 server gives agents and MCP tools no terminal access. For a later MCP tool:

- `TerminalManager::list() -> Vec<TerminalSummary>`: every terminal, newest first.
- `TerminalManager::read(thread_id, terminal_id, max_bytes) -> Option<TerminalSessionSnapshot>`:
  state and the last `max_bytes` of scrollback, without subscribing.
- `observe` gives a live stream without counting as a viewer.

## Differences from the T3 server

- `hasRunningSubprocess` and the label come from the PTY's foreground process group
  (`tcgetpgrp`), not from `ps` every second. A background job (`sleep 10 &`) does not count.
- `providerInstanceId` is ignored: no provider instance adds environment variables here.
- No cwd recovery: a missing worktree is `TerminalCwdNotFoundError`; T3 recreates it first.
- No `closeIdle` (setup scripts) and no `ProjectSetupScriptRunner` callers yet.
- A viewer is a client connection, taken from the session's per-socket `Principal`.
