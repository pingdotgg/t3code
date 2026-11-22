# Live reload of the label and the Orbit Instance facts

The Conn Server re-reads its label and `/etc/orbit/instance` while it runs. Orbit can rename
an Instance (finalize of a pre-warmed clone) without a server restart. Clients keep their
socket, their pairing and their sessions. Code: `crates/conn-server/src/reload.rs` and
`Environment::reload` in `crates/conn-server/src/environment.rs`.

## Triggers

| Trigger | When it fires | Use |
| --- | --- | --- |
| `SIGHUP` to the server process | at once | Orbit sends it after it writes the new file and hostname. This is the fast path for finalize. |
| inotify on `/etc/orbit/` (Linux only) | at once after a write, create, delete or rename in the folder | Catches an atomic `rename(2)` of `/etc/orbit/instance`. The folder must exist when the server starts; otherwise only the other triggers work. |
| A poll every 2 s | always | Picks up hostname changes and hosts without inotify (macOS). |

Each trigger reads the label and the file again. A reload with no change sends nothing.

**Before this change, `SIGHUP` stopped the server** (the default action). Send it only to a
Conn Server that has this feature: the first `conn-server` release after 0.4.0 (0.4.0 and
older stop on it), or check for the `environment reloaded` line in its log after a test
signal on a copy. The handler is registered as soon as the command is `serve`, before the
desktop bootstrap read, the login-shell PATH read and the state load, so a `SIGHUP` during
startup no longer stops the server; only one sent before the process reaches `main` (its
first few milliseconds) still does.

## What is re-read

- `/etc/orbit/instance`: the same parse as at start (`ORBIT_PROJECT_ID` and
  `ORBIT_INSTANCE_ID` required, the rest optional, 64 KiB cap). A missing or invalid file
  removes `orbitInstance` from the descriptor.
- The label: `--label` when given (then it never changes), else `HOSTNAME` from the
  server's environment (fixed for the process), else `/etc/hostname`, else the kernel's host
  name up to the first dot. For a label that follows a rename, start the server without
  `--label` and without `HOSTNAME`, and change `/etc/hostname` (or the kernel host name).
- The environment id, capabilities and version never change.

## What clients see

- `GET /.well-known/t3/environment` answers the new descriptor.
- Every open `subscribeServerConfig` stream gets a new `snapshot` event with the whole
  config. The contract has no event for the environment alone; Conn clients replace their
  config with each snapshot (`applyServerConfigProjection`), as after a reconnect.
- `server.getConfig`, the `welcome` and `ready` events of a new `subscribeServerConfig` or
  `subscribeServerLifecycle`, `/mcp` (`conn_environment_read`, project tools) and peer links use
  the new label from then on. An open lifecycle stream does not get a second `welcome`.

The T3 server reads both only at start; a rename there needs a restart.

## Proof

`cargo test -p conn-server --lib reload`: a reload publishes only a changed descriptor; the
folder watch (Linux) or `SIGHUP` (macOS) reloads within seconds; and a client on a real
socket receives the new label and `orbitInstance` on its open config stream, with its session
still connected.
