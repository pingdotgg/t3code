# conn-server

> [`docs/status.md`](docs/status.md) says where the work stands: what is proven, what is not,
> and what is left, in order. Nothing uses this server yet.

The Conn Server: our own Rust server for Conn clients. It serves the same client contract as
the T3 server (`apps/server` in the Conn monorepo, TypeScript on Effect) with a far smaller
memory footprint. We reproduce behaviour at three boundaries (the client contract, `/mcp`, the
provider protocols). We do not translate the TypeScript.

**Base:** the Conn monorepo this folder sits in (`apps/conn-server` of `nckrtl/conn`). The tools
read the contract, the web client and `apps/server` from the same tree.
**Contract:** `crates/conn-contract/methods.json` records `contractDigest`, the sha256 of the
tracked contract inputs, so a contract change fails `gen-contract.mjs --check`.

## Run

```sh
cargo build --release
./target/release/conn-server serve --host 127.0.0.1 --port 3773 --base-dir /tmp/conn-home
./target/release/conn-server --state-dir /tmp/conn-state --project ~/code/my-repo   # short form
```

The command line follows the T3 server's (`t3 serve`, `t3 pair`, `t3 auth …`,
`t3 project add`, `t3 thread list|start|send|show`); [`crates/conn-server/DROP-IN.md`](crates/conn-server/DROP-IN.md) lists what
Orbit and Conn desktop run and what the Conn Server does with it. `conn-server --help` prints
every command.

| Flag or variable                            | Default                                                | Meaning                                                            |
| ------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------ |
| `--host`, `--port` (`T3CODE_HOST`, `_PORT`) | `127.0.0.1`, first free from 3773                      | Listen address; `--listen <host:port>` sets both                   |
| `--base-dir` (`T3CODE_HOME`)                | `~/.t3`                                                | T3 home; state lives in `<home>/userdata`, shared with T3's format |
| `--state-dir`                               | `<home>/userdata`                                      | The state directory itself (`$CONN_SERVER_HOME` still works)       |
| `--project <dir>` (repeatable)              | the current folder in the short form; none with `serve` | Folders offered as projects, plus `projects.json` (`project add`)  |
| `--label <name>`                            | the host name                                          | Environment label in clients                                       |
| `--mode desktop`, `--bootstrap-fd <fd>`     | web                                                    | Conn desktop's start: reads its bootstrap line, accepts its token  |
| `CONN_MODEL_MANIFEST_URL` (test seam)       | unset: T3 Code's manifest on GitHub                    | Where `model-manifest.json` is fetched from; `off` (or any value that is not an `http(s)` URL) never fetches. Every check sets `off` (`tools/check.sh`, `tools/sealed-env.mjs`); `orbit-flow.mjs` points it at a loopback stub |

The default home is `~/.t3`, the T3 server's. To try the server next to a running T3 server,
always pass `--base-dir` or `--state-dir` with a folder of its own.

At start it takes the home's ownership lock (exit 78 when another server holds it), prints the
address, the environment id, the method coverage and a `pairingUrl`, and writes
`server-runtime.json`. SIGTERM or SIGINT stops it cleanly. A turn that was running when the
server stopped continues on the next start in the same provider thread (at most 3 restarts in
a row within 5 minutes).

## Pair a client

The server serves the remote-environment path: bearer token plus WebSocket ticket. In Conn,
open **Settings › Connections › Add environment › Remote link** and paste the `pairingUrl`
(`http://<host>:<port>/pair#token=<code>`). The code is single use and valid 24 hours; each
start prints a new one, and `conn-server pair` or `auth pairing create` issue more while it
runs. Sessions and pairing links persist in `<state-dir>/auth.json`, so a paired client
reconnects after a restart without pairing again; **Settings › Sharing & access** lists and
revokes them. There are no browser cookie sessions, so the server's own origin (`/pair` in a
browser) does not work; use Connections.

## Checks

Run every check from `apps/conn-server`. One command runs all checks that need no model:

```sh
(cd ../.. && vp i)                    # once: the monorepo's node_modules
(cd helpers/sdk-host && npm ci)       # once: else the Claude checks are skipped
tools/check.sh
```

The Node tools load the contract, the client code and the TypeScript server from the monorepo
two levels up (`tools/monorepo.mjs`), and resolve `effect`, `@t3tools/*` and Playwright from its
`node_modules`. The Conn Server has no `node_modules` of its own. `tools/check.sh` stops with
one line when the monorepo has no `node_modules`.

CI path filters and sync triggers are listed in [`docs/upkeep.md`](docs/upkeep.md#when-the-checks-run).

`tools/check.sh` runs, in order:

| Check               | Command                                                                                                                         | Proves                                                                                               |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Toolchain pin       | `rust-toolchain.toml` against `RUST_TOOLCHAIN` in the monorepo's `.github/workflows/conn-server-*.yml`                          | CI builds with the pinned toolchain                                                                  |
| Format, lint, tests | `cargo fmt --check`, `cargo clippy --workspace --all-targets --all-features -- -D warnings`, `cargo test --workspace`           | All crates, offline, under the lint set (`CRATES.md`, "Lint set")                                    |
| Release build       | `cargo build --release --workspace --bins --examples`                                                                           | The binaries below build                                                                             |
| Recordings decode   | `cargo test --manifest-path fixtures/decode-check/Cargo.toml`                                                                   | Every recorded frame decodes with `conn_wire`                                                        |
| Contract current    | `node crates/conn-contract/tools/gen-contract.mjs --check`                                                                      | Generated types match `packages/contracts`                                                           |
| MCP tools current   | `node crates/conn-mcp/tools/gen-tools.mjs --check`                                                                              | Served tool definitions match `apps/server`                                                          |
| GitHub GraphQL current | `node crates/conn-source-control/tools/gen-graphql.mjs --check` | GitHub's GraphQL operation texts match T3's generated modules, printed by `effect/graphql` |
| Keybinding defaults | `node crates/conn-server/tools/gen-keybindings.mjs --check`                                                                     | The compiled-in defaults match `packages/shared`                                                     |
| Effect client       | `node crates/conn-server/tools/effect-client.mjs target/release/conn-server`                                                    | Pairing, ticket, connect streams decode in Effect's `RpcClient`                                      |
| Ack window          | same, with `target/release/examples/effect_fixture --fixture`                                                                   | Ack window and `Interrupt`                                                                           |
| Client reducers     | `cargo run -p conn-engine --features fake-provider --example export_turn -- x.json`, then `crates/conn-engine/tools/client-check.mjs x.json` | Shell and thread streams rebuild the right state in the client's reducers                            |
| Replay              | `node crates/conn-server/tools/replay.mjs target/release/examples/replay_server`                                                | Every call in the `remote` and `turn` recordings gets a decodable answer or the not-supported defect |
| Text generation     | `node crates/conn-server/tools/textgen-diff.mjs target/release/examples/text_generation` | Text generator requests and answers, title prompts, contexts and titles equal T3's own code, on a loopback stub |
| Registry            | `node crates/conn-source-control/tools/registry-diff.mjs target/release/examples/registry_cases` | GitHub and unknown-host fallback match T3's core registry with its GitHub definition, on every GitHub test literal and a fixed grid (8,901 cases) |
| MCP parity          | `node crates/conn-mcp/tools/parity.mjs target/release/examples/replay_server`                                                   | `/mcp` answers as the T3 server's does, on the same calls                                            |
| Orbit idle check    | `node crates/conn-server/tools/idle-diff.mjs target/release/conn-server` | `/api/orchestration/shell` as Orbit's idle sleep and thread index read it equals the T3 server's in 14 states (no thread to a restart mid-turn) and 5 refusals; `/transcript` matches in status, refusals and decode, and is each server's own thread snapshot cut down, in 6 states and 4 refusals, and a run fork's transcript matches T3's outline and fork marker; Codex on the conformance stub; differences listed in its `KNOWN` must stay exactly those |
| Provider sign-in    | `node crates/conn-server/tools/provider-auth-diff.mjs target/release/conn-server` | every `provider.auth.*` reply for `claudeAgent`, `codex`, `grok` and an unknown id equals the T3 server's, and neither server runs a CLI for them (recording stubs) |
| Codex instructions  | `node crates/conn-provider-codex/tools/gen-instructions.mjs --check`                                                             | T3's Codex `additionalContext` text is current, byte for byte                                         |
| Codex conformance   | `node crates/conn-provider-codex/tools/conformance.mjs`                                                                         | Codex argv, environment, every stdin frame and shutdown equal the T3 server's, on a stub `codex`; also the `codex mcp list` and `codex exec` runs of a thread title |
| ACP instructions    | `node crates/conn-provider-acp/tools/gen-instructions.mjs --check` | T3's ACP prompt wrapper and runtime notes are current, byte for byte |
| ACP conformance     | `node crates/conn-provider-acp/tools/conformance.mjs` | Grok argv, environment, every stdin line and shutdown equal the T3 server's, on a stub agent |
| Grok probe conformance | `node crates/conn-provider-acp/tools/probe-conformance.mjs` | Grok's `ServerProvider` entry and every CLI run of its status probe equal the T3 server's, on a stub CLI |
| Codex model catalog | `node crates/conn-provider-codex/tools/gen-model-catalog.mjs --check` | The Codex model catalog the status probe applies matches T3's bundled `model-manifest.json` |
| Codex probe conformance | `node crates/conn-provider-codex/tools/probe-conformance/run.mjs` | Codex's `ServerProvider` entry and every run of its status probe (argv, environment, folder, every stdin line, how it ended) equal the T3 server's `checkCodexProviderStatus`, on a stub `codex` (17 scenarios) |
| Claude catalog      | `crates/conn-provider-claude/tools/gen-catalog/run.sh --check`                                                                   | The Claude model catalog matches T3's bundled catalog                                                |
| Claude conformance  | `crates/conn-provider-claude/tools/conformance/run.sh` (skipped, with one line, without `npm ci` in `helpers/sdk-host`)          | The `claude` CLI gets the same argv, environment and stdin as from the T3 server, on a stub CLI      |
| Claude probe conformance | `node crates/conn-provider-claude/tools/probe-conformance/run.mjs` (skipped with the Claude conformance) | Claude's `ServerProvider` entry and every CLI run of its status probe equal the T3 server's `checkClaudeProviderStatus`, and its thread titles equal `generateThreadTitle`, on a stub CLI |
| T3 replay (Claude)  | `node crates/conn-provider-claude/tools/t3-replay/check.mjs`                                                                    | The T3 server's Claude transcripts: exactly the scenarios in `expected-failures.txt` fail            |
| T3 fixture replay   | `node crates/conn-engine/tools/t3-fixture-replay/check.mjs`                                                                     | T3's testkit fixtures through this engine and our Claude, Codex and Grok providers pass T3's own assertions, except the variants in its `expected-failures.txt` (69 of 159 pass) |
| Thread CLI diff     | `node crates/conn-server/tools/thread-cli-diff.mjs target/release/conn-server` | Orbit's task-turn commands (`t3 thread` start, send, list and show, `t3 auth session issue --scope … --json`, revoke, and `t3_copy_rpc.mjs`'s calls) give the same stdout, stderr and exit code as the T3 server's own `t3` CLI, on a stub `codex` with T3's transcripts |
| Model manifest diff | `node crates/conn-server/tools/model-manifest-diff.mjs target/release/examples/model_manifest_cache` | `model-manifest.json` as this server writes it equals T3's `encodeManifestCache`, byte for byte |
| Orbit flow          | `node crates/conn-server/tools/orbit-flow.mjs target/release/examples/replay_server`                                            | Orbit's container flow: start, project add, session issue, launch over `/mcp`, revoke, clean stop; then its task-turn path: the model check, `t3 thread` start, list, show, send, a turn that asks, and `t3_copy_rpc.mjs`'s read and interrupt   |
| Instances flow      | `node crates/conn-server/tools/instances-flow.mjs target/release/conn-server` (skipped without `npm ci` in `helpers/sdk-host`)  | Claude and Codex instances from `providerInstances` written before start: a turn on each starts its stub with its settings; a change and a removal through `server.updateSettings` apply to the next session; disabled instances refused and listed disabled |
| Canary (last)       | `node tools/canary.mjs verify` (set up by `tools/check.sh` before the first check) | No check read a decoy file of the home, changed the home, let a marker variable or file reach any output or written file, ran a provider or host CLI, or connected outside loopback; no passwd home lookup in our code |

**The canary.** `tools/check.sh` runs every check with a decoy HOME (marker files where
`~/.claude`, `~/.codex`, `~/.grok`, `~/.config/gh`, `~/.gitconfig`, `~/.netrc` and `~/.t3` would
be; the credential files mode 000), marker values in `ANTHROPIC_*`, `OPENAI_API_KEY`,
`CODEX_HOME`, `XAI_API_KEY`, `GH_TOKEN`, `GITHUB_TOKEN`, `GITLAB_TOKEN`, `T3CODE_HOME` and
`CONN_CANARY`, a stand-in `SHELL`, and a `TMPDIR` that the canary scans twice a second. Cargo
and rustup keep their real folders (`CARGO_HOME`, `RUSTUP_HOME`), and cargo runs without the
global git configuration. Reads are seen by access time (a self-test fails the check on a
`noatime` file system), opens of a mode-000 file only when the error names the decoy path, and
a stat or a file that lived less than half a second without printing a marker not at all. Marker
executables named after the provider and host CLIs (`claude`, `codex`, `grok`, `gh`, `glab`, `fj`, `tea`, `az`, `cafe`) go first on `PATH` and fail the canary when run; a Node hook
(`NODE_OPTIONS=--import`) and `CONN_NETWORK_LOG` in our server refuse and record any
connection outside loopback. `mark` names the check behind each record.

`replay_server` is `conn-server` with the engine's scripted fake provider, so these checks call
no model. Each server they start gets a temp state folder; `parity.mjs` gives the T3 server a
temp `T3CODE_HOME` and a free port.

Checks that call a model are not in `tools/check.sh`:

- `cargo test -p conn-provider-claude live_ -- --ignored --test-threads=1` (real CLI, Haiku),
  and the same for `conn-provider-codex`.
- `parity.mjs --model`: one Haiku turn on the T3 server.
- `orbit-flow.mjs target/release/conn-server`: one Haiku turn.
- The recorder with `--rust target/release/conn-server`.

**Real web client.** The recorder (`fixtures/recorder`) drives the monorepo's web client in
headless Chromium. On the fake provider:

```sh
(cd ../web && vp build)
node fixtures/recorder/record.mjs pairing rust-turn rust-restart rust-vcs rust-files \
  rust-terminal rust-settings rust-search rust-worktree \
  --rust target/release/examples/replay_server --out /tmp/conn-recordings
```

See [`fixtures/README.md`](fixtures/README.md) for every scenario and which need a model.

## Upkeep

The Conn Server follows the Conn commit it is part of. When Conn moves (an upstream sync, a
contract change), `tools/follow-conn.sh` regenerates every generated file, runs
`tools/check.sh` and prints what changed since the Conn Server last followed. It does not
commit. See [`docs/upkeep.md`](docs/upkeep.md).

Releases: push a tag `conn-server-v<version>` (the `conn-server` crate's version) to
`nckrtl/conn`. `.github/workflows/conn-server-release.yml` builds
`conn-server-<version>-linux-x64.tar.gz` and its `.sha256` and attaches them to a GitHub
Release, which Orbit downloads.

## Crates

| Crate                   | Holds                                                                 |
| ----------------------- | --------------------------------------------------------------------- |
| `conn-wire`             | Effect RPC frame types and JSON codec                                 |
| `conn-contract`         | Generated contract types (`tools/gen-contract.mjs`), method list, ids |
| `conn-engine`           | `Engine` trait; SQLite event store, projections, streams, turn runner |
| `conn-provider`         | `Provider` and `Session` traits, `ProviderEvent`, `ProviderSet` (the instances, changed as the settings change) |
| `conn-provider-claude`  | The Claude provider, through the official Agent SDK in the SDK host (see [Claude](#claude)) |
| `conn-provider-codex`   | The Codex provider over `codex app-server` (JSON-RPC on stdio)        |
| `conn-provider-acp`     | The ACP provider (Grok so far, offered by the server; off until settings enable it) |
| `conn-provider-support` | Ids, line framing, the process supervisor, the SDK host client (`sdk_host`), a rooted file host, and a provider instance's settings envelope (`instance`: enabled rule, identity, environment with T3's `~` expansion), shared by providers |
| `conn-mcp`              | `/mcp`: T3 tools over MCP Streamable HTTP; see its README             |
| `conn-vcs`              | Git status, refs, review diffs, worktrees and their setup             |
| `conn-files`            | Project files, search, asset URLs, attachments                        |
| `conn-terminal`         | Shells on PTYs: sessions, scrollback, viewers (`terminal.*`)          |
| `conn-source-control`   | GitHub source control: discovery, sign-in, stars, repositories, the host definition registry, provider detection, GitHub's GraphQL operations; later pull requests |
| `conn-server`           | Binary: HTTP, `/ws` session, pairing, method table, handlers          |
| `conn-support`          | Helpers several crates share: time, hex, base64, SHA-256 and HMAC, atomic writes, v4 ids, the T3 secret store, URL text |
| `conn-features`         | Scheduled tasks (webhook tasks too) and the Conn-only areas beside the engine; see its README |

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
    fn abandon_turn_start(&self, input: AbandonTurnStartInput) -> BoxFuture<'_, ()>; // default: nothing
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
(`setPermissionMode`). `abandon_turn_start` is new too: a Stop before the provider accepted the
turn ends the run in the engine, and the provider stops the start in flight as T3's effect
worker interrupts it (Claude aborts a booting CLI; ACP sends nothing more; Codex sends nothing
more, and stops a turn that its `turn/start`, already written, still started: a deliberate
difference, `crates/conn-provider-codex/README.md`). Left out
until needed: compact, rollback, fork, thread snapshots, history
injection, background tasks, subagent stop.

Adding a provider: one new crate that implements both traits.

**Instances.** As in the T3 server, a driver has a default instance whose id is the driver
kind (`claudeAgent`, `codex`), and each `providerInstances` entry of that driver is one more
instance (Orbit's `claudeLow` … `claudeMax`). `conn-server/src/instances.rs` builds them
from the settings at start and again on every change: an entry that changes gives a new
provider for that id, a removed one is dropped, and open sessions keep the provider they
opened with, as T3's open sessions keep their adapter. The engine, titles, `/mcp` and the
server share one `ProviderSet`. Grok's default instance follows its settings itself.

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
- Registration also panics on a tag with no entry in the scope table. That table holds the
  auth scope T3 requires per method (T3 leaves none unguarded). It is generated from the T3
  server's `RPC_REQUIRED_SCOPES` into `src/scopes/generated.rs` by `tools/gen-upstream.mjs`;
  the payload-dependent rules stay by hand in `scopes.rs`, and a test holds their list to the
  T3 server's. The table checks the scope before the handler runs and fails with
  `EnvironmentAuthorizationError`. Handlers do not check scopes.
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
- **rusqlite** with `bundled` SQLite for the event store; `tokio::process` for provider CLIs;
  `getrandom` and `sha2` for credentials.
- **flate2** (`rust_backend`: miniz_oxide) decodes text generator answers sent gzip or
  deflate encoded, which the T3 server's `fetch` asks for and this server now asks for too.
- **Settings secrets** live in the T3 server's secret store, `<state>/secrets/<name>.bin`
  (0700 folder, 0600 files); `settings.json` holds `••••••` in their place
  (`docs/conn-only-areas.md`, "Settings secrets").
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
revocation). Not served: browser cookie sessions, `/api/auth/session` (SSH only),
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
| `panels.requests` (fork)        | at boot in web (`apps/web/src/panels/agentPanelRequests.ts`)       | Re-subscribes after a delay; nothing visible. Not served, as the T3 server leaves it unmounted (`wsFork.ts`).                                                                               |
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
thread deleted. `/transcript` is served as T3 serves it: the whole visible turn items, the
same header and bearer, `thread_transcript_too_large` past `PROVIDER_SEND_TURN_MAX_FILE_BYTES`,
and T3's structured `thread_not_found`. `/bounded` and `/history` are not routed; the client
falls back to the socket.

### Opt-in flags

- **Thread stream:** the client sends `acceptBoundedSnapshot`, `acceptDeferredWork`,
  `acceptCompactTurnItems` and `acceptCompactIds` whenever it has an HTTP client and a history
  controller (`state/threads.ts`), whatever the server advertises. So it sends them to this
  server too. The engine ignores them: full bodies, plain ids, never an `idTable`.
- **Shell stream:** `omitIdleSubagents` and `omitOlderSettled` are sent only when the descriptor
  advertises `shellThreadFamilies` / `shellOlderSettled` (`state/shell.ts`). This server
  advertises both (`environment::capabilities`, the one place for capabilities), and the
  engine serves the matching methods.

## Status

The method table reports coverage at startup. Every
registered method checks the scope the T3 server requires (`src/scopes.rs`, its table
generated). `assets.createUrl`, `terminal.open` and `terminal.attach` also get the contract's
length, pattern and range limits before decode (`crates/conn-support/src/input.rs`, its table generated). Every registered method but two has a run that decodes its answer with the real
client (`tools/decode-coverage.mjs`; the rest are in `decode-coverage.pending`). The engine's
`dispatchCommand` coverage is in `crates/conn-engine/README.md`; each other area's crate README
lists what it serves.

| Area            | Served by                                                                                       |
| --------------- | ----------------------------------------------------------------------------------------------- |
| Connect, config | `methods/server.rs`: config and lifecycle streams, settings, keybindings, access, diagnostics. `docs/server-area.md` maps all 42 `server.*` methods |
| Threads         | `conn-engine`: dispatch (43 of 56 commands), launch, streams, reads, search, families, projects, checkpoints |
| Agents          | `conn-provider-claude`, `conn-provider-codex`, `conn-provider-acp` (Grok); `/mcp` (`conn-mcp`, 20 tools) |
| Workspace       | `conn-vcs` (status, refs, review, worktrees), `conn-files` (files, search, assets, uploads)     |
| Terminals       | `conn-terminal`                                                                                 |
| Source control  | `conn-source-control`: GitHub discovery, all 9 `sourceControl.*` (GitHub repositories)  |
| Text generators | `src/text_generation/`: `server.listTextGeneratorModels` and thread titles through the user's own model API (`docs/server-area.md`, "Text generators") |

The server joins them in `src/host.rs`: each provider session gets a `/mcp` credential, messages
claim their uploads, a `worktree` launch provisions a worktree, archive and delete close the
thread's terminals, and a turn's end refreshes VCS status. One idle rule closes provider
sessions (`--session-idle-timeout`, default 30 minutes, held up to 4 hours by background work).
SIGTERM and SIGINT stop terminals and close every provider session before the server exits.

**Proven with the real web client** (headless Chromium; `fixtures/README.md`): pairing, a turn,
a restart with reconnect, an approved prompt, Stop during a tool call, settings and access,
search, VCS views and the diff, files and uploads, terminals, a launch into a new worktree, and
a turn that calls `/mcp`. `crates/conn-server/tools/orbit-flow.mjs` runs Orbit's container
flow and its task-turn path against a binary.

**Memory on Linux**, measured 2026-11-14 (Conn pin `b12470dcad`) on the Orbit container host (x86_64, Ubuntu, kernel
7.0). Figures are MiB from `/proc/<pid>/smaps_rollup`. The server is the musl release build of
`examples/replay_server` (`conn-server` with the engine's fake provider, so no model and no
`claude` process), with the binary on ext4. `crates/conn-server/tools/memory-flow.mjs` drives
it: it pairs, opens the web client's boot streams over `/ws`, opens one thread stream per
thread, and runs turns through `/mcp`.

| Server (musl, fake provider) | Rss  | Pss  | Pss_Anon | Private_Dirty |
| ---------------------------- | ---- | ---- | -------- | ------------- |
| Just started                 | 8.7  | 8.7  | 1.4      | 1.4           |
| Client connected, streams open | 10.0 | 10.0 | 1.9    | 1.9           |
| After 20 turns in 3 threads  | 13.1 | 13.1 | 4.3      | 4.3           |
| After 2 idle minutes         | 12.3 | 12.3 | 4.1      | 4.2           |

Five container T3 servers (`/opt/orbit-agent/current/agent/bin/t3 serve`), read at the same
moments: `Pss_Anon` 354, 283, 285, 299 and 285 MiB (mean 301), unchanged through the run. The
server's anonymous memory after 20 turns is about 70 times smaller. The rest of its `Rss` is the
binary's file pages, which every container on the host shares through the page cache.

| SDK host (Node 26.12.1 single executable, stub `claude`) | Rss   | Pss   | Pss_Anon | Private_Dirty |
| -------------------------------------------------------- | ----- | ----- | -------- | ------------- |
| Idle after start, no driver loaded                       | 66.3  | 60.3  | 20.9     | 20.9          |
| In a session, turn 1 running                             | 81.1  | 74.9  | 32.0     | 32.0          |
| After 10 turns                                           | 91.7  | 85.5  | 38.5     | 38.5          |
| After the last session closed                            | gone  | gone  | gone     | gone          |

The SDK host runs only while a Claude session is open. Measured with
`crates/conn-provider-claude/examples/helper_memory` and
`crates/conn-provider-claude/tools/conformance/stub-claude` replaying a 10-turn transcript. Its
152 MB executable is mostly file pages, and how many are resident varies: a run before the
2026-11-14 pin bump read 94 to 117 MiB `Rss` with the same `Pss_Anon` (21 to 41). Only
`Pss_Anon` is private to one container. A real
session also has the `claude` CLI (about 140 MiB `Pss_Anon` in an earlier run) and the MCP
helpers from the user's Claude settings. The T3 figures do not count those either.

Build for `x86_64-unknown-linux-musl`: in an earlier run the glibc build used slightly more
(`Pss_Anon` 3.0 against 2.6 MiB after 11 Haiku turns).

On macOS arm64 (release, `ps` RSS / `footprint`, one Haiku turn): `opt-level = "z"` gave a
4.8 MiB binary and 5.7 / 2.5 MiB idle, 7.5 / 3.4 MiB peak; `opt-level = 3` gave 7.5 MiB and
6.5 / 2.8, 9.4 / 3.9. The release profile keeps `"z"`.

**Linux build:** on a Linux host, `cargo build --release -p conn-server` takes about a minute
from clean with 4 jobs; add `--target x86_64-unknown-linux-musl` (with `musl-gcc` installed)
for a static binary (15.7 MB on 2026-11-14; 7.2 MB in the early spike). From macOS the build needs a C
cross-compiler for bundled SQLite, such as `cargo zigbuild`.

## Known gaps

What a real Conn session hits that this server does not do:

- **Not supported (error in that view):** previews, annotations, devices, pull requests,
  scheduled-task edits, provider sign-in and install, peer links, discovered local servers and
  the other methods the startup coverage line lists as missing.
- **No checkpoints:** turns are not captured as git refs, so no turn diff or restore.
- **Titles through a text generator or Codex:** a thread title is generated when the title
  model is a text generator (`crates/conn-server/src/text_generation/`) or a Codex instance,
  the default (`codex exec`, as T3; `crates/conn-provider-codex/README.md`). With Claude as
  the title model the thread keeps the client's seed title until the Claude provider
  implements `Provider::generate_text` (`docs/server-area.md`, "Text generators").
- **`/mcp` serves 28 of 87 T3 tools** (`crates/conn-mcp/README.md`).
- **Worktree launch:** the worktree is made before the thread exists; `prepared-run.*` stays
  refused and no project setup script runs.
- **Providers:** Claude, Codex and Grok (Grok with `/compact`, background work and subagents; not subagents carried over to a later turn). Their gaps are in each crate's README. Claude and Codex instance settings apply (binary, home, launch arguments, environment, enabled, identity); Codex is probed as T3 probes it (its `app-server`, account, models, skills, config, usage) and reads `customModels`; not yet: Claude's `customModels` and `autoCompactWindow`, Codex's `shadowHomePath` and managed setup.
- **Auth:** bearer and ticket only. No cookie sessions, DPoP or relay (`DROP-IN.md` §4).
- **Desktop-local backend:** the `--bootstrap-fd` start works; the desktop itself still
  spawns the T3 server (`DROP-IN.md` §2).
- **Each start prints a new pairing code**; unspent ones expire after 24 hours.

## Claude

Claude runs through Anthropic's official Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`, at
the T3 server's version), as in the T3 server. The SDK runs in the SDK host
(`helpers/sdk-host`), a small Node program that the Rust server starts with the first Claude
session and stops after the last. An idle server runs no Node. A Claude session adds one SDK
host for all sessions: about 44 MB of private memory on macOS arm64.

- **From a checkout:** run `npm ci` in `helpers/sdk-host` once. The server then runs
  `helpers/sdk-host/index.mjs` with `node` from `PATH`.
- **In a container:** the release tarball (`tools/release-tarball.mjs`) puts
  `sdk-host/index.mjs` with its production `node_modules` beside the `conn-server` binary; the
  server runs it with `node` from `PATH` (Orbit's runtime folder gives Node 24.22.1). See
  `crates/conn-server/DROP-IN.md`, "Release tarball for Orbit". A `conn-sdk-host` single
  executable (`helpers/sdk-host/build-sea.sh`) beside the binary wins over it.
  `--sdk-host <path>` or `CONN_SDK_HOST` names another place.
- **Proofs, with no model call:** `crates/conn-provider-claude/tools/conformance/run.sh`
  proves that the `claude` CLI gets the same argv, environment and stdin from the Conn Server
  as from the T3 server. `crates/conn-provider-claude/tools/t3-replay/run.sh` replays the T3
  server's own Claude transcripts against our session (18 of 39 pass, all that it drives; its
  README lists the rest with reasons). `tools/check.sh` runs both.
- **Live:** `cargo test -p conn-provider-claude live_ -- --ignored --test-threads=1` runs
  11 tests on Claude Haiku through the SDK host.

Known gaps are in `crates/conn-provider-claude/README.md`: stopping background tasks, some
settings, and a Linux build of the SDK host.
