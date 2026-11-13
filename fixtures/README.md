# Session recordings

Real client sessions against the TypeScript server at the pinned contract commit, and against
the Conn Server (`rust-*`). They are the ground truth for what a Conn client sends and
expects, and the first replay input for `conn-server`. [CONNECT.md](CONNECT.md) reads them for you.

## Files

| Path                              | Holds                                                                         |
| --------------------------------- | ----------------------------------------------------------------------------- |
| `sessions/<scenario>.ndjson`      | One wire frame per line: `{"dir","ms","ws","frame"}`, plus `"parts"` if split |
| `sessions/<scenario>.http.ndjson` | HTTP calls to the same server, the `/ws` upgrade URLs, and socket closes      |
| `recorder/record.mjs`             | Starts a server and headless Chromium, drives the web client, writes files    |
| `recorder/scenarios.mjs`          | One driver per scenario                                                       |
| `recorder/redact.mjs`             | Redaction applied before anything is written                                  |
| `recorder/summarize.mjs`          | Prints one recording as a timeline of HTTP calls and RPCs                     |
| `decode-check/`                   | Rust test: every frame decodes with `conn_wire`                               |

Line format, as the workspace README fixes it, with two additions:

- `dir`: `in` is client → server (`FromClient`), `out` is server → client (`FromServer`).
- `ms`: milliseconds since the first recorded `/ws` socket opened. HTTP entries before it are
  negative.
- `ws` (added): which socket of the page carried the frame (0, 1, ...). The `.http.ndjson` file
  has the upgrade URL for each index. A page opens a new socket after a full navigation.
- `parts` (added): the server sent this frame as that many
  [frame parts](../README.md#the-wire); the line holds the joined frame.

## Scenarios

| Scenario                                                        | What happens                                                                                                                                            |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pairing`                                                       | A fresh browser opens `/pair#token=…` on a fresh server and lands in the app                                                                            |
| `reconnect`                                                     | The same browser (session cookie) opens `/` again                                                                                                       |
| `turn`                                                          | New thread in the project, Claude Haiku 5.5, one short message, one full turn                                                                           |
| `permission`                                                    | New thread in Supervised mode; Claude asks to run `echo conn-recording`; the user approves once                                                         |
| `interrupt`                                                     | New thread; Claude runs `ping -c 30 127.0.0.1` (approved); the user stops the turn while it runs                                                        |
| `remote`                                                        | From Settings › Connections, pair a second fresh server as a remote environment                                                                         |
| `terminal`                                                      | On a draft: terminal drawer, `echo`, resize, reload (scrollback returns), 50 MB `yes`, close                                                            |
| `rust-attachment`, `rust-worktree`, `rust-mcp`, `rust-subagent` | Claude names an uploaded image's colour; a launch into a new worktree; Claude calls `t3_thread_list` over `/mcp`; a subagent row opens its child thread |
| `rust-*`                                                        | As `remote`, with the Rust `conn-server` as the remote environment (`--rust <binary>`)                                                                  |
| `ts-*`                                                          | The same drivers as `rust-follow-up`, `rust-queue`, `rust-search`, with a paired TypeScript server, for side-by-side comparison                         |
| `*-files`                                                       | Favicon, `@` search, image upload, content search, open a file; no model call                                                                           |

The server starts with `--auto-bootstrap-project-from-cwd` in a scratch git repo, so it has one
project and one empty thread before the client arrives. `pairing` therefore lands on that thread,
not on an empty list. `remote` records only the second server's traffic.

## Rerun

Run the recorder from this repository. `CONN_MONOREPO` names a Conn monorepo checkout after
`vp i`: the recorder runs its TypeScript server and serves its web build, and takes
Playwright from its `node_modules`. Build the web client there once:

```sh
export CONN_MONOREPO=/path/to/conn
(cd "$CONN_MONOREPO/apps/web" && vp build)
node fixtures/recorder/record.mjs
```

`CONN_RECORDER_SHOTS=<dir>` keeps the screenshots after the run. `--out <dir>` writes the
recordings to `<dir>` instead of `sessions/`, for a proof run that must not change them.

Without scenario names it rewrites every non-`rust-*` file in `sessions/`. It takes about two
minutes and spends four Haiku turns. Name scenarios to record only those, in order:
`record.mjs pairing turn`. Every scenario after `pairing` needs the cookie `pairing` earns, so
always name `pairing` first.

Then check the result:

```sh
cargo test --manifest-path fixtures/decode-check/Cargo.toml -- --nocapture
node fixtures/recorder/summarize.mjs turn
git diff --stat fixtures/sessions
```

The `rust-*` scenarios run only when named, after `pairing`, with `--rust <binary>`. They
record only the Rust server's traffic and always write a screenshot per checkpoint. With
`--rust target/release/examples/replay_server` the Rust server runs the engine's scripted fake
provider, so no model is called. These work on it: `rust-turn`, `rust-restart`, `rust-vcs`,
`rust-files`, `rust-terminal`, `rust-settings`, `rust-search`, `rust-worktree`:

```sh
cargo build --release --examples
node fixtures/recorder/record.mjs pairing rust-turn rust-restart rust-vcs rust-files \
  rust-terminal rust-settings rust-search rust-worktree \
  --rust target/release/examples/replay_server --out /tmp/conn-recordings
```

`rust-permission`, `rust-stop`, `rust-mcp`, `rust-attachment` and `rust-subagent` need
Claude to act (a prompt, a tool call, a subagent): use `--rust target/release/conn-server`,
which runs the `claude` CLI. `rust-follow-up`, `rust-queue` and `rust-load` were recorded with
Haiku; they are not yet tried on the fake provider. `rust-terminal` runs the
`terminal` steps on the Conn Server; `recorder/compare-terminal.mjs <recording>` prints either
as a timeline. `rust-restart` stops and restarts the Rust server on the same state and waits
for the client to reconnect without a reload. `rust-load` runs 11 turns in three threads, then
idles two minutes.

`--rust-url <pairingUrl>` uses a Rust server that already runs (for example on another host,
through `ssh -L` on the same port) instead of starting one. `--rust-sample <command>` measures
it: the recorder runs `<command> <label>` at each checkpoint and expects one JSON line with a
`server` object of numbers. `rust-restart` needs `--rust`, since it must stop the server.

Ids, timings and Claude's wording change on every run, so every file changes. Read the
redaction checklist below before you commit.

`--explore` keeps the temp folders, writes a screenshot per step, and logs the visible controls:
use it to fix a driver after a UI change. A failed scenario writes `<scenario>.partial.ndjson`
and a `failure.png`, and the run exits 1. Do not commit partial files.

### What the recorder does

- Builds `apps/web` in `CONN_MONOREPO` first if `apps/web/dist` is missing. The server serves
  that build.
- Runs `apps/server/src/bin.ts` from `CONN_MONOREPO` under `env -i` with only `HOME`, `USER`,
  `PATH` and `T3CODE_HOME` set, on a free port, with its base directory in a new temp folder.
  It never touches `~/.t3` or a running T3 server. It stops the servers it started by their
  PIDs and deletes the temp folders.
- Captures traffic through Chromium's own protocol (Playwright `websocket` and request events),
  not a proxy, and joins frame parts the way `joinSocketFrameParts` does.

### Host requirements and traps

- **Claude must be logged in for the user who runs it.** The server uses the real `HOME`, so the
  Claude CLI finds its credentials. With an isolated `HOME`, Claude reports "Not logged in".
- **The host's user Claude settings apply.** The scratch project gets `.claude/settings.json`
  with `{"permissions":{"ask":["Bash"]}}`. Without it, a user setting that allows all `Bash`
  skips the prompt that `permission` needs. An ask rule wins over allow, even in full access, so
  `interrupt` also gets a prompt, which its driver approves.
- **Host hooks apply.** A hook that rejects bare `sleep` is why `interrupt` runs `ping`.
- **Provider status reflects the host.** `subscribeServerConfig` lists the host's installed
  providers, skills and plugins, with home paths rewritten to `/Users/user`.

## Redaction

`redact.mjs` runs on every line before it is written. It keeps shapes and lengths:

- Values under secret-like keys become `<redacted:N>` (N is the original length): tokens,
  tickets, credentials, cookies, `authorization` (the scheme stays: `Bearer <redacted:N>`), DPoP
  proofs, `clientDevice`, and account ids (`workspaceId`, `accountId`, `organizationId`,
  `userId`).
- Each such value, the pairing token, and every browser cookie value is also replaced wherever
  else it appears, URL-encoded or not, such as `wsTicket=` on a `/ws` URL or a form body.
- The home directory becomes `/Users/user`, the login name and host label become `user`, and
  email addresses become `user@example.com`. JWT-shaped strings and `sk-…` keys are removed.

A redacted value no longer matches its schema (a redacted id is not a UUID), so contract
round-trips must skip those fields.

Before you commit a refresh, search the new files for: the login name, `/Users/` followed by
anything but `user`, `eyJ`, `sk-`, `Bearer ` or `DPoP ` followed by anything but `<redacted`,
and `wsTicket=` followed by anything but `<redacted>`.
