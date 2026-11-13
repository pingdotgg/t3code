# conn-server (spike)

A Rust server for Conn clients. It speaks the same client contract as `apps/server`, with a far
smaller memory footprint. This is a spike: we reproduce behaviour at three boundaries only (the
client contract, `/mcp`, the provider CLI protocols). We do not translate the TypeScript.

**Base:** Conn `origin/main` at `b685417bb6157408d3c3b78544dfd5bbc3e67753` (2026-11-13).
**Contract:** `packages/contracts` last changed in `415dd488bac9dee7f7d2a869595f3c8f1da26863`
(the 2026-11-13 upstream sync). `crates/conn-contract/methods.json` records it, and every track
works against it.

## Build and test

```sh
cd native/conn-server
cargo build
cargo test
cargo clippy --all-targets
cargo run -p conn-server                         # 127.0.0.1, free port; prints the address
cargo run -p conn-server -- --listen 0.0.0.0:3773
```

With `vp i` done in the repo root:

```sh
# Regenerate the method list after a contract change:
node native/conn-server/crates/conn-contract/tools/dump-methods.mjs
# Call a running server with Effect's own RpcClient:
node native/conn-server/crates/conn-server/tools/effect-client.mjs http://127.0.0.1:<port>
```

The stub answers `GET /health` and, on `/ws`, `server.probe` (→ `{}`). Every other method
returns a `ConnServerNotSupported` defect. The stub has **no auth**: keep it on localhost.

## Crates

| Crate                  | Holds                                                        | Owner                                                                          |
| ---------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `conn-wire`            | Effect RPC frame types and JSON codec                        | track (a)                                                                      |
| `conn-contract`        | Contract types: method list, ids, placeholders for schemas   | track (b)                                                                      |
| `conn-engine`          | `Engine` trait; event store, projections, streams            | track (d)                                                                      |
| `conn-provider`        | `Provider` and `Session` traits, `ProviderEvent`             | fixed (integrator)                                                             |
| `conn-provider-claude` | The Claude provider                                          | track (c)                                                                      |
| `conn-server`          | Binary: HTTP, `/ws` session, pairing, method table, handlers | track (a), except `methods/orchestration.rs` (d) and `methods/provider.rs` (c) |

Dependencies point one way: `conn-server` → `conn-engine` → `conn-provider` → `conn-contract`;
`conn-provider-claude` → `conn-provider`; `conn-server` → `conn-wire`. `conn-wire` and
`conn-contract` depend on nothing of ours.

The method table lives in `conn-server` (`src/table.rs`), not its own crate: every handler
module lives in `conn-server/src/methods/` anyway, one file per area.

## The three interfaces

These are fixed. Change one only with the integrator, and say so in your report.

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
    fn launch_thread(&self, input: ThreadLaunchInput)
        -> BoxFuture<'_, Result<ThreadLaunchResult, EngineError<ThreadLaunchError>>>;
    fn subscribe_shell(&self, input: SubscribeShellInput)
        -> BoxFuture<'_, Result<Subscription<ShellStreamItem, GetShellSnapshotError>, EngineError<GetShellSnapshotError>>>;
    fn subscribe_thread(&self, input: SubscribeThreadInput)
        -> BoxFuture<'_, Result<Subscription<ThreadStreamItem, GetThreadProjectionError>, EngineError<GetThreadProjectionError>>>;
}
```

These back `orchestration.dispatchCommand`, `orchestration.launchThread`,
`orchestration.subscribeShell` and `orchestration.subscribeThread`. Clients start every new
thread from the composer with `launchThread` (thread plus first message), and send later
messages with `dispatchCommand` `message.dispatch`. An `Err` item ends a stream with a typed failure; a closed
channel ends it successfully; dropping the receiver unsubscribes.

### 3. Method table (`crates/conn-server/src/table.rs`)

```rust
table.unary("server.probe", |ctx: CallContext, input: I| async { Ok::<O, Failure>(..) });
table.stream("orchestration.subscribeShell", |ctx, input: I| async { Ok::<ItemStream, Failure>(rx) });
table.get(tag)        // Option<&Handler>; None → not_supported_exit(tag)
table.coverage()      // "1 of 235 methods (0 of 32 streams)", plus the missing tags
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
- Release profile as in `native/resource-monitor`: thin LTO, one codegen unit, `panic = "abort"`,
  stripped. The release stub is 1.1 MB; on macOS arm64 its RSS was 2.6 MB idle and 3.2 MB
  after two calls. That is total RSS on a Mac, not the container measure the spike must prove.
- Track (d) will add `rusqlite` with the `bundled` feature. Track (c) uses `tokio::process`.
- No `async-trait`, no `futures`: traits return `BoxFuture`, streams are `tokio::sync::mpsc`.

## Tracks

Every track branches from `spike/rust-server`, works in its own worktree, and commits only in
the folders it owns. Every track keeps `cargo test` and `cargo clippy --all-targets` green.

### (a) Wire and pairing

- **Owns:** `crates/conn-wire`, `crates/conn-server` except `methods/orchestration.rs` and
  `methods/provider.rs`.
- **Implements:** the `/ws` session (replace the stub in `src/session.rs`): ack window,
  `Interrupt`, `Eof`, notifications, `discard`, frame parts, the `orchestrationProtocol` check,
  per-method scopes; the pairing flow and connect methods listed under
  [What clients need](#what-clients-need-read-from-the-code), in `methods/server.rs`.
- **Tests alone:** frame tests in `conn-wire`; session tests against `MethodTable` with fake
  handlers; `tools/effect-client.mjs` with the real Effect client; then Conn desktop.
- **Must not touch:** `conn-engine`, `conn-provider*`, `conn-contract`, the two files above.

### (b) Contract types

- **Owns:** `crates/conn-contract`.
- **Implements:** generated Rust types from `packages/contracts` at the pinned commit. Replace
  `src/placeholder.rs` with generated types of the same names; keep `src/ids.rs` names. Extend
  `tools/dump-methods.mjs` (or a sibling script) to emit what you need, such as JSON Schema.
- **Tests alone:** round-trip real payloads: shell and thread snapshots, domain events and
  commands from `apps/server` tests and the track (e) recordings.
- **Must not touch:** other crates. If a name must change, list every call site for the
  integrator.

### (c) Claude provider

- **Owns:** `crates/conn-provider-claude`, `crates/conn-server/src/methods/provider.rs`.
- **Implements:** `Provider` and `Session` for the `claude` CLI over stdio. Reference:
  `ClaudeAdapterV2.ts`, the recordings in `apps/server/src/orchestration-v2/testkit`, and the
  probe in `~/apps/conn-rust-claude-probe`. T3's MCP tools reach Claude over HTTP
  (`type: "http"`), not in-process.
- **Tests alone:** feed recorded CLI output through the session and assert the
  `ProviderEvent`s; one live turn on the cheapest model.
- **Must not touch:** `conn-provider` (the trait), the engine, the wire.

### (d) Engine

- **Owns:** `crates/conn-engine`, `crates/conn-server/src/methods/orchestration.rs`.
- **Implements:** `Engine`: event store on SQLite, shell and thread projections, the streams,
  `launchThread`, and driving `Provider` sessions from `message.dispatch` and `launchThread`.
  The stream rules are in the trait docs and below.
- **Tests alone:** dispatch commands into an in-memory or temp-file store; assert stream items;
  a fake `Provider` (see the test in `conn-provider`) stands in for Claude.
- **Must not touch:** `conn-provider` (the trait), `conn-provider-claude`, the wire.

### (e) Session recording

- **Owns:** `native/conn-server/fixtures/`.
- **Implements:** a recording of a real Conn desktop session against the TS server: connect,
  shell stream, new thread, one Claude turn. Store one file per session,
  `fixtures/sessions/<name>.ndjson`, one wire frame per line:
  `{"dir":"in"|"out","ms":<since connect>,"frame":<frame as sent>}` (`in` = client → server),
  joined from frame parts. Also note the HTTP calls the client made around it.
- **Tests alone:** every line decodes with `conn_wire` (`FromClient` for `in`, `FromServer`
  for `out`).
- **Must not touch:** any crate.

## What clients need (read from the code)

Read from `packages/client-runtime` and `apps/web` at the pinned commit. References are to
`packages/client-runtime/src` unless noted.

### Pairing and connect (track a)

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

### Streams (track d)

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

### HTTP orchestration routes: none needed

- **`GET /api/orchestration/shell`:** a failure falls back to the socket snapshot
  (`state/shellSnapshotHttp.ts`).
- **`GET /api/orchestration/threads/:id/bounded`:** tried on a cold thread open. Any failure
  except a structured `EnvironmentResourceNotFoundError` falls back to the socket
  (`state/boundedThreadSnapshotHttp.ts`). That structured error marks the thread deleted, so
  never send it for an unimplemented route. Axum's plain 404 is safe.
- **`/history`, `/transcript`:** feature routes only.
- **Advertising `threadSnapshotPagination: true`** in `ServerConfig` skips the bounded attempt
  entirely.

## Still open

- **Placeholder switch.** Code that reads placeholder internals (`.0["field"]`) breaks when (b)
  lands. Build and read contract values through `from_json` / `to_json`.
