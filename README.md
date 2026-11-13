# conn-server (spike)

A Rust server for Conn clients. It speaks the same client contract as `apps/server`, with a far
smaller memory footprint. This is a spike: we reproduce behaviour at three boundaries only (the
client contract, `/mcp`, the provider CLI protocols). We do not translate the TypeScript.

**Base:** Conn `origin/main` at `b685417bb6157408d3c3b78544dfd5bbc3e67753` (2026-11-13).
**Contract:** `packages/contracts` last changed in `415dd488bac9dee7f7d2a869595f3c8f1da26863`
(the 2026-11-13 upstream sync). `crates/conn-contract/methods.json` records it.

## Run

```sh
cd native/conn-server
cargo build --release
./target/release/conn-server --state-dir /tmp/conn-state --project ~/code/my-repo
```

| Flag                           | Default                                    | Meaning                                                      |
| ------------------------------ | ------------------------------------------ | ------------------------------------------------------------ |
| `--listen <host:port>`         | `127.0.0.1:0` (free port)                  | Use `0.0.0.0:<port>` to serve other machines                 |
| `--state-dir <dir>`            | `$CONN_SERVER_HOME`, else `~/.conn-server` | Environment id, sessions, `engine.sqlite`                    |
| `--project <dir>` (repeatable) | the current folder                         | Folders offered as projects; the first is the server's `cwd` |
| `--label <name>`               | `$HOSTNAME`, else `conn-server`            | Environment label in clients                                 |

At start it prints the address, the environment id, the method coverage and a `pairingUrl`.
Turns run the `claude` CLI from `PATH` with the user's own Claude settings, as `apps/server`
does. Stop the server with SIGTERM. A turn that was running when the server stopped ends as
failed on the next start, with a message to send it again.

## Pair a client

The server speaks the remote-environment path: bearer token plus WebSocket ticket. In Conn,
open **Settings › Connections › Add environment › Remote link** and paste the `pairingUrl`
(`http://<host>:<port>/pair#token=<code>`). The code is single use and valid 24 hours; each
start prints a new one. Pairings persist in `<state-dir>/sessions.json`, so a paired client
reconnects after a restart without pairing again. There are no browser cookie sessions, so
the server's own origin (`/pair` in a browser) does not work; use Connections.

## Tests

From `native/conn-server`:

```sh
cargo test --workspace            # all crates, offline
cargo clippy --workspace --all-targets
cargo fmt --check
cargo test -p conn-provider-claude live_ -- --ignored --test-threads=1   # real CLI, Haiku
```

From the repo root, after `vp i` and `cargo build --release --examples` in this folder:

| Check             | Command                                                                                                                                                                                               | Proves                                                                                               |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Effect client     | `node native/conn-server/crates/conn-server/tools/effect-client.mjs native/conn-server/target/release/conn-server`                                                                                    | Pairing, ticket, connect streams decode in Effect's `RpcClient`                                      |
| Ack window        | same, with `native/conn-server/target/release/examples/effect_fixture --fixture`                                                                                                                      | Ack window and `Interrupt`                                                                           |
| Client reducers   | `cargo run -p conn-engine --features fake-provider --example export_turn -- /tmp/x.json` then `node native/conn-server/crates/conn-engine/tools/client-check.mjs /tmp/x.json`                         | Shell and thread streams rebuild the right state in the client's reducers                            |
| Replay            | `node native/conn-server/crates/conn-server/tools/replay.mjs native/conn-server/target/release/examples/replay_server`                                                                                | Every call in the `remote` and `turn` recordings gets a decodable answer or the not-supported defect |
| Recordings decode | `cargo test --manifest-path native/conn-server/fixtures/decode-check/Cargo.toml`                                                                                                                      | Every recorded frame decodes with `conn_wire`                                                        |
| Contract current  | `node native/conn-server/crates/conn-contract/tools/gen-contract.mjs --check`                                                                                                                         | Generated types match `packages/contracts`                                                           |
| Real web client   | `(cd apps/web && vp build)` then `node native/conn-server/fixtures/recorder/record.mjs pairing rust-turn rust-restart rust-permission rust-stop --rust native/conn-server/target/release/conn-server` | Pair, turn, restart, approval and stop in headless Chromium; see `fixtures/README.md`                |

`replay_server` is `conn-server` with the engine's scripted fake provider, so the replay calls
no model. The `rust-*` scenarios spend about five Haiku turns.

## Crates

| Crate                  | Holds                                                                 |
| ---------------------- | --------------------------------------------------------------------- |
| `conn-wire`            | Effect RPC frame types and JSON codec                                 |
| `conn-contract`        | Generated contract types (`tools/gen-contract.mjs`), method list, ids |
| `conn-engine`          | `Engine` trait; SQLite event store, projections, streams, turn runner |
| `conn-provider`        | `Provider` and `Session` traits, `ProviderEvent`                      |
| `conn-provider-claude` | The Claude provider over the `claude` CLI's stdio                     |
| `conn-server`          | Binary: HTTP, `/ws` session, pairing, method table, handlers          |
| `conn-terminal`        | Shells on PTYs: sessions, scrollback, viewers (`terminal.*`)          |

Dependencies point one way: `conn-server` → `conn-engine` → `conn-provider` → `conn-contract`;
`conn-provider-claude` → `conn-provider`; `conn-server` → `conn-wire`. `conn-wire` and
`conn-contract` depend on nothing of ours.

The method table lives in `conn-server` (`src/table.rs`), not its own crate: every handler
module lives in `conn-server/src/methods/` anyway, one file per area.

## The three interfaces

Change one only on purpose, and list the change in the commit.

### 1. Provider (`crates/conn-provider/src/lib.rs`)

Shaped from `ProviderAdapterV2` in `packages/provider-core/src/server/ProviderAdapter.ts`, which
the Claude and Codex adapters implement.

```rust
pub trait Provider: Send + Sync {
    fn instance_id(&self) -> &ProviderInstanceId;
    fn driver(&self) -> &str;                       // "claudeAgent", "codex", ...
    fn capabilities(&self) -> BoxFuture<'_, ProviderResult<ProviderCapabilities>>;
    fn open_session(&self, input: OpenSessionInput) -> BoxFuture<'_, ProviderResult<OpenedSession>>;
}
pub struct OpenedSession { pub session: Box<dyn Session>, pub events: mpsc::Receiver<ProviderEvent> }

pub trait Session: Send + Sync {
    fn provider_session_id(&self) -> &ProviderSessionId;
    fn ensure_thread(&self, input: EnsureThreadInput) -> BoxFuture<'_, ProviderResult<ProviderThread>>;
    fn resume_thread(&self, input: ResumeThreadInput) -> BoxFuture<'_, ProviderResult<ProviderThread>>;
    fn start_turn(&self, input: TurnInput) -> BoxFuture<'_, ProviderResult<()>>;
    fn steer_turn(&self, input: SteerInput) -> ...;                        // default: Unsupported
    fn interrupt_turn(&self, input: InterruptInput) -> BoxFuture<'_, ProviderResult<()>>;
    fn apply_model_selection(&self, thread, selection) -> ...;            // default: Unsupported
    fn apply_runtime_policy(&self, thread, policy) -> ...;                // default: Unsupported
    fn respond_to_runtime_request(&self, input: RuntimeRequestResponse) -> BoxFuture<'_, ProviderResult<()>>;
    fn close(&self) -> BoxFuture<'_, ()>;
}
```

`ProviderEvent` mirrors `ProviderAdapterV2Event` (same `type` names, camelCase fields, no
`driver`): session, thread, turn, node, subagent, message, turn item, command output delta,
runtime request (permission prompts and questions), plan, `turn.terminal`.
`apply_runtime_policy` is new: it carries a permission mode change to a running Claude process
(`setPermissionMode`). Left out until needed: compact, rollback, fork, thread snapshots, history
injection, background tasks, subagent stop, MCP apps.

Adding a provider: one new crate that implements both traits.

### 2. Engine (`crates/conn-engine/src/lib.rs`)

```rust
pub type Subscription<T, E> = mpsc::Receiver<Result<T, E>>;
pub enum EngineError<E> { Rejected(E), Internal(String) }   // → Fail exit / Die exit

pub trait Engine: Send + Sync {
    fn dispatch(&self, command: Command)
        -> BoxFuture<'_, Result<DispatchCommandResult, EngineError<DispatchCommandError>>>;
    fn subscribe_shell(&self, input: SubscribeShellInput)
        -> BoxFuture<'_, Result<Subscription<ShellStreamItem, GetShellSnapshotError>, EngineError<GetShellSnapshotError>>>;
    fn subscribe_thread(&self, input: SubscribeThreadInput)
        -> BoxFuture<'_, Result<Subscription<ThreadStreamItem, GetThreadProjectionError>, EngineError<GetThreadProjectionError>>>;
    // JSON in and out; each defaults to an Internal error.
    fn launch_thread(&self, input: Value) -> BoxFuture<'_, Result<Value, EngineError<Value>>>;
    fn get_thread_projection(&self, thread_id: ThreadId) -> ...;   // getThreadProjection
    fn shell_snapshot(&self) -> ...;                               // GET /api/orchestration/shell
    fn thread_snapshot(&self, thread_id: ThreadId) -> ...;         // GET .../threads/:id, None → 404
}
```

These back `orchestration.dispatchCommand`, `launchThread`, `subscribeShell`,
`subscribeThread`, `getThreadProjection` and the two HTTP snapshot routes. Clients start every
new thread from the composer with `launchThread` (thread plus first message), and send later
messages with `dispatchCommand` `message.dispatch`. An `Err` item ends a stream with a typed
failure; a closed channel ends it successfully; dropping the receiver unsubscribes. The engine
trusts provider events to be valid contract rows; it fills in `threadId` and `runId` and
assigns ordinals.

### 3. Method table (`crates/conn-server/src/table.rs`)

```rust
table.unary("server.probe", |ctx: CallContext, input: I| async { Ok::<O, Failure>(..) });
table.stream("orchestration.subscribeShell", |ctx, input: I| async { Ok::<ItemStream, Failure>(rx) });
table.get(tag)        // Option<&Handler>; None → not_supported_exit(tag)
table.coverage()      // "15 of 235 methods (9 of 32 streams)", plus the missing tags
```

- Registration panics at startup on a tag not in the contract, a duplicate, or a unary handler
  for a stream method (or the reverse).
- A payload that does not decode into `I` ends the call with a defect, as Effect does.
- `Failure::Fail(value)` is a typed contract error; `Failure::Die(value)` is a defect.
- An unsupported method answers at once with
  `{"_tag":"Failure","cause":[{"_tag":"Die","defect":{"name":"ConnServerNotSupported","message":"conn-server does not support `<tag>` yet"}}]}`.
  The Effect client decodes that defect into an `Error` (checked with the real client).
- Each area registers from its own file: `methods/server.rs`, `methods/orchestration.rs`,
  `methods/provider.rs`. To add an area, add a file and one line in `methods/mod.rs`.

## The wire

Effect RPC over WebSocket, `RpcSerialization.layerJson`: one JSON value per text message, and a
JSON array holds several frames. Sources: `.repos/effect/packages/effect/src/rpc/` (4.1.2);
the installed `effect` is 4.1.3, whose `RpcMessage.ts` and `RpcSerialization.ts` are identical
and whose `RpcServer.ts`/`RpcClient.ts` changes do not touch the wire.

| Direction       | Frame                                                                                         | Notes                                                                                                                          |
| --------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| client → server | `Request {id, tag, payload, headers, isNotification?, discard?, traceId?, spanId?, sampled?}` | ids are numbers from a counter                                                                                                 |
| client → server | `Ack {requestId}`                                                                             | one per received `Chunk`                                                                                                       |
| client → server | `Interrupt {requestId}`                                                                       | server ends the request with an `Interrupt` exit                                                                               |
| client → server | `Ping`                                                                                        | every 5 s; Conn fails the connection after 15 s without any frame (`packages/client-runtime/src/rpc/protocol.ts`)              |
| client → server | `Eof`                                                                                         | end after in-flight requests finish                                                                                            |
| server → client | `Chunk {requestId, values[]}`                                                                 | non-empty batch of stream items                                                                                                |
| server → client | `Exit {requestId, exit}`                                                                      | `Success {value}` or `Failure {cause: [Fail{error} \| Die{defect} \| Interrupt{fiberId}]}`; a stream's success value is `null` |
| server → client | `Defect {defect}`                                                                             | connection-level; fails every pending request                                                                                  |
| server → client | `Pong`                                                                                        |                                                                                                                                |
| server → client | `ClientProtocolError {error, requestIds?}`                                                    | decoder accepts it; servers do not send it                                                                                     |
| server → client | `Request`                                                                                     | server-originated; unused by T3                                                                                                |

T3 adds on top (`apps/server/src/ws.ts`): the `/ws` URL must carry `orchestrationProtocol=2`
(else 426); auth on upgrade (`authenticateWebSocketUpgrade`); frame parts when the URL has
`frameParts` (`packages/shared/src/socketFrameParts.ts`; Conn always sets it); an ack window of 8 chunks for
`subscribeServerConfig`, `subscribeShell`, `subscribeThread`, and 8 chunks / 64 KiB for
`terminal.attach`/`observe` (`apps/server/src/terminal/OutputProtocol.ts`); server options
`disableTracing` and `disableFatalDefects`. Constants are in `conn_wire::frame_parts` and
`conn_wire::ack_window`.

## Dependencies and runtime

- **tokio, current-thread runtime.** One thread, no work-stealing pool. A container serves one
  or two clients; each extra worker thread costs a stack and allocator arenas. Blocking work
  (SQLite, file reads) goes to `spawn_blocking` or one dedicated thread.
- **axum 0.8** with `default-features = false` (`http1`, `ws`, `json`, `query`, `tokio`). It
  is hyper plus a router and WebSocket upgrade; writing those by hand saves little memory.
- **serde / serde_json** for all wire and contract values.
- Release profile: `opt-level = "z"`, thin LTO, one codegen unit, `panic = "abort"`,
  stripped. See [Status](#status) for its memory.
- **rusqlite** with `bundled` SQLite for the event store; `tokio::process` for the `claude` CLI;
  `getrandom` and `sha2` for credentials.
- No `async-trait`, no `futures`: traits return `BoxFuture`, streams are `tokio::sync::mpsc`.

## What clients need (read from the code)

Read from `packages/client-runtime` and `apps/web` at the pinned commit. References are to
`packages/client-runtime/src` unless noted.

### Pairing and connect

No DPoP: it is only used on the T3 Connect relay path (`authorization/service.ts`
`authorizeDpop`). Direct pairing is bearer token + WebSocket ticket.

1. **Pairing URL** `<origin>/pair#token=<code>`, printed at startup (`apps/server/src/startupAccess.ts`).
   Code: 12 chars from `23456789ABCDEFGHJKLMNPQRSTUVWXYZ`, case-insensitive, single use, 5 min
   TTL, scopes `AuthStandardClientScopes` (`packages/contracts/src/auth.ts`). The desktop reads
   the token from the URL; it never loads `/pair`.
2. **`GET /.well-known/t3/environment`**, no auth → `ExecutionEnvironmentDescriptor`
   (`contracts/src/environment.ts`). Must carry `orchestrationProtocolVersion: 2` (else the
   client blocks, `connection/compatibility.ts`) and a stable `environmentId` (persist it).
3. **`POST /oauth/token`**, form-encoded token exchange:
   `grant_type=urn:ietf:params:oauth:grant-type:token-exchange`, `subject_token=<code>`,
   `subject_token_type=urn:t3:params:oauth:token-type:environment-bootstrap` → `{access_token,
   issued_token_type, token_type:"Bearer", expires_in, scope}` with `cache-control: no-store`.
   No refresh token. Errors: 400 `invalid_request`, 401 `auth_invalid`
   (`contracts/src/environmentHttp.ts`).
4. **`POST /api/auth/websocket-ticket/rpc`**, `Authorization: Bearer` → `{ticket, expiresAt}`,
   5 min.
5. **`GET /ws?wsTicket=…&orchestrationProtocol=2&clientCapabilities=…&frameParts=1&client…`**.
   426 with `{code:"orchestration_protocol_incompatible", …}` unless `orchestrationProtocol=2`;
   then the ticket authenticates. `client*` params are analytics only.

The token format is ours to choose; the client treats it as opaque. To stay paired across
restarts, persist the environment id, the signing key and the sessions (with scopes and
revocation). Not needed for the spike: browser cookie sessions, `/api/auth/session` (SSH only),
access-management endpoints, MCP OAuth, relay, DPoP.

### Calls a client makes, and what a failure does

| Method                          | When                                                               | If it fails                                                                                                                                                                                  |
| ------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `subscribeServerConfig`         | first, on every connect (`rpc/session.ts`)                         | **Never connects.** Its first item must be `{version:1, type:"snapshot", config}` with `config.environment.environmentId` equal to the descriptor's. If the stream ends, the session closes. |
| `orchestration.subscribeShell`  | after connect (`state/shell.ts`)                                   | **No sidebar.** A defect ends it with no retry.                                                                                                                                              |
| `subscribeServerLifecycle`      | at boot (`apps/web/src/routes/__root.tsx`, `FirstRunGate.tsx`)     | A client that never finished onboarding waits on the `welcome` event. Send `{version:1, sequence:0, type:"welcome", payload:{environment, cwd, projectName, bootstrapStatus:"complete"}}`.   |
| `orchestration.subscribeThread` | when a thread opens (`state/threads.ts`)                           | Thread shows "Could not synchronize"; retries.                                                                                                                                               |
| `orchestration.launchThread`    | new thread with first message (`operations/commands.ts`)           | Send fails.                                                                                                                                                                                  |
| `orchestration.dispatchCommand` | `message.dispatch`, `thread.create`, …                             | Send fails.                                                                                                                                                                                  |
| `server.probe`                  | on wake, network change, long silence (`connection/supervisor.ts`) | **Tears the session down and reconnects.** Implemented.                                                                                                                                      |
| `panels.requests` (fork)        | at boot in web (`apps/web/src/panels/agentPanelRequests.ts`)       | Re-subscribes after a delay; nothing visible.                                                                                                                                                |
| everything else                 | from a specific view or user action                                | That feature shows an error.                                                                                                                                                                 |

`server.getConfig` is never called by clients. Of the fork methods, only `panels.requests` runs
without a user action; the rest belong to the credentials, test-login and annotation views.

`ServerConfig` (`contracts/src/server.ts`) needs `environment`, `auth`, `cwd`,
`keybindingsConfigPath`, `keybindings`, `issues`, `providers`, `availableEditors`,
`observability` and `settings`. Advertise only capabilities the server really serves: an
absent capability hides its feature, and `shellThreadFamilies` or `shellOlderSettled` make the
client send `omit*` shell flags and call methods we would then need.

### Streams

- **Shell:** full `snapshot`, then `synchronized`, then `project.*`/`thread.*` items with an
  increasing `sequence` above `snapshotSequence`. Clients always send
  `requestCompletionMarker: true`; without `synchronized` the sidebar stays "synchronizing". A
  full snapshot is a valid answer to any `afterSequence`, `httpSnapshotFallback` or
  `knownProjectIdentities`.
- **Thread:** `snapshot {snapshotSequence, projection}`, then `synchronized`, then
  `event {sequence, event}` with a per-thread sequence. Clients always send
  `requestCompletionMarker` and `acceptDedupedBodies`, and send `acceptBoundedSnapshot`,
  `acceptDeferredWork`, `acceptCompactTurnItems`, `acceptCompactIds` whenever they have an HTTP
  client, whatever the server advertises. All of these may be ignored: full bodies, plain ids,
  no `idTable`, no history cursor. Without a history cursor the client never calls `/history`.
- **Also emit `thread.updated` on the shell** as a turn runs, so the sidebar status moves.

### HTTP orchestration routes

`GET /api/orchestration/shell` and `GET /api/orchestration/threads/:id` are served. Both need
`x-t3-orchestration-protocol: 2` (else 400) and a bearer with `orchestration:read` (else 401 or
403). The shell route ignores its query and always sends the full snapshot. An unknown thread
is a plain 404, never `EnvironmentResourceNotFoundError`, which would make the client mark the
thread deleted. `/bounded`, `/history` and `/transcript` are not routed; the client falls back
to the socket.

### Opt-in flags

- **Thread stream:** the client sends `acceptBoundedSnapshot`, `acceptDeferredWork`,
  `acceptCompactTurnItems` and `acceptCompactIds` whenever it has an HTTP client and a history
  controller (`state/threads.ts`), whatever the server advertises. So it sends them to this
  server too. The engine ignores them: full bodies, plain ids, never an `idTable`.
- **Shell stream:** `omitIdleSubagents` and `omitOlderSettled` are sent only when the descriptor
  advertises `shellThreadFamilies` / `shellOlderSettled` (`state/shell.ts`). This server
  advertises neither, so the client does not send them. If a client sent them anyway, the full
  snapshot it gets is still valid.

## Status

**Coverage:** 15 of 235 methods (9 of 32 streams), from the method table at startup.

| Area          | Methods                                                                                                                                                |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Connect       | `subscribeServerConfig`, `subscribeServerLifecycle`, `server.probe`, `server.reportClientActivity`                                                     |
| Threads       | `orchestration.subscribeShell`, `subscribeThread`, `launchThread`, `dispatchCommand`, `getThreadProjection`                                            |
| Empty answers | `subscribeTerminalMetadata`, `subscribeProjectClones`, `subscribeDeviceState`, `panels.requests`, `scheduledTasks.subscribe`, `preview.reportProfiles` |

`dispatchCommand` handles `thread.create`, `message.dispatch`, `run.interrupt`, `thread.stop`,
`runtime-request.respond`, `thread.archive`/`unarchive`/`delete`/`visit`,
`thread.metadata.update`, and the runtime-mode, interaction-mode and model-selection setters.

**Proven with the real web client** (headless Chromium, Haiku): pairing through Settings ›
Connections, the project in the sidebar, a new thread with one full answer, an approved Bash
prompt in Supervised mode, Stop during a tool call, and a server restart on the same state: the
client reconnects by itself, shows the thread, and runs a second turn.

**Memory on Linux** (x86_64, Ubuntu, kernel 7.0; the Orbit container host). Read with
`smaps_rollup`, the server process only, in MiB. One client, real Claude Haiku turns from the web
client; binary on ext4 (on tmpfs the binary would count as `Pss_Shmem` and dirty pages).

| Sample (musl build)         | Rss | Pss | Pss_Anon | Pss_File | Private_Dirty |
| --------------------------- | --- | --- | -------- | -------- | ------------- |
| Just after start            | 4.2 | 4.2 | 0.5      | 3.7      | 0.6           |
| Connected, streams open     | 5.2 | 5.2 | 0.8      | 4.3      | 0.9           |
| Peak during the first turn  | 6.3 | 6.3 | 1.2      | 5.1      | 1.3           |
| After the first turn        | 6.4 | 6.4 | 1.3      | 5.1      | 1.3           |
| After 11 turns in 3 threads | 7.7 | 7.7 | 2.6      | 5.1      | 2.6           |
| After 2 idle minutes        | 7.7 | 7.7 | 2.6      | 5.1      | 2.6           |

At the same moments the 55 container T3 servers had `Pss_Anon` mean 302 MiB (min 284, max 360) and RSS mean 335 MiB: about 115 times the Rust server's anonymous memory after 11 turns.
The glibc build used slightly more (`Pss_Anon` 3.0 MiB and RSS 10.6 MiB after 11 turns), so
build for `x86_64-unknown-linux-musl`. Each open thread keeps its `claude` child (about
140 MiB `Pss_Anon`) and the MCP helpers from the user's Claude settings; those are separate
processes and not counted above, as they are not in the T3 figures.

On macOS arm64 (release, `ps` RSS / `footprint`, one Haiku turn): `opt-level = "z"` gave a
4.8 MiB binary and 5.7 / 2.5 MiB idle, 7.5 / 3.4 MiB peak; `opt-level = 3` gave 7.5 MiB and
6.5 / 2.8, 9.4 / 3.9. The release profile keeps `"z"`.

**Linux build:** on a Linux host, `cargo build --release -p conn-server` takes under a minute
from clean with 4 jobs (7.1 MB binary); add `--target x86_64-unknown-linux-musl` (with
`musl-gcc` installed) for a static binary of 7.2 MB. From macOS the build needs a C
cross-compiler for bundled SQLite, such as `cargo zigbuild`.

## Known gaps

What a real Conn session hits that this server does not do:

- **Not supported (error in that view):** VCS (`subscribeVcsStatus`, `subscribeVcsBranch`,
  `vcs.listRefs`, `server.discoverSourceControl`), diffs (`review.getDiffPreview`), files
  (`projects.readFile`, `assets.createUrl`, so no project favicon), previews, annotations,
  discovered local servers, archived and older-settled shell reads, terminals, provider
  refresh, settings writes, and every other method not listed above.
- **No checkpoints:** turns are not captured as git refs, so no diff or restore.
- **One project set at start:** clients cannot add projects.
- **Busy thread:** a message sent while a turn runs is refused, not queued or steered.
- **No title generation:** `generateTitle` is ignored; the title is the first message.
- **No `/mcp`:** agents cannot reach T3 tools.
- **Claude only:** no Codex or other providers. Gaps in the Claude provider are listed in
  `crates/conn-provider-claude/README.md` (subagents, attachments, todo lists, retries).
- **Auth:** bearer and ticket only. No cookie sessions, DPoP, relay or access management.
  `pairing-token` issues standard codes only.
- **Desktop-local backend:** Conn desktop's own `--bootstrap-fd` start is not implemented.
- **Each start prints a new pairing code**; unspent ones expire after 24 hours.
