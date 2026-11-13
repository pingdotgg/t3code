# Crates review

Where hand-written code in `conn-server` should give way to a maintained crate, and where it
should stay. Reviewed on 2026-11-13 against `rust/base` (`5b571fe04a`). Crate facts come from
crates.io and the source repositories on that date. Cost figures were measured, not estimated
(see [Method](#method)).

## Answer

- **Adopt now, five crates.** `rustix` (process groups), `uuid`, `lexopt`, `tracing` with
  `tracing-subscriber` (fmt only), and `rusqlite` 0.42 in place of 0.37. Together they add
  under 0.15 MB, and they remove our riskiest small hand-written pieces.
- **`/mcp`: keep our transport, not `rmcp`.** This review advised `rmcp`; the MCP track then
  measured both builds serving the same handlers (`crates/conn-mcp/README.md`, "The SDK or
  our own"). `rmcp` 3.10.0 added 0.94 MB of binary (5.31 → 6.24 MB) and about 0.12 MB per
  open session (18.8 MB against our 6.5 MB RSS at 100 sessions), because each session runs
  its own worker task, and it always answers over SSE. Ours is about 300 lines. Revisit when
  the T3 server moves to a protocol revision we do not serve.
  The tables below are the review as written: where they say a crate comes free with
  `rmcp`, or count `rmcp` in the adopt set, that no longer holds.
- **Adopt in the tracks that need them.** `pty-process` for the
  terminal, `ignore` + `nucleo-matcher` (+ `regex`) for file walking and fuzzy search,
  `tower-http` (`fs`) and axum `multipart` for static files and uploads. `notify` too, but
  only while a client watches.
- **Keep ours.** The Effect RPC wire codec, the contract generator, the Claude protocol
  mapper, auth, time formatting, JSON (`serde_json`), HTTP/WebSocket (axum 0.8), SQLite
  (`rusqlite`), the async runtime, and git through the `git` CLI.
- **The whole adopt set costs +2.48 MB of binary (5.02 → 7.50 MB on macOS arm64), +75
  crates, and +0.4 MB idle footprint.** `rmcp` (+1.03 MB) and the search set (+1.13 MB)
  make up nearly all of it. Both replace protocols and file formats we would otherwise
  maintain ourselves.

## Method

- A scratch copy of the workspace (then `native/conn-server` in the Conn monorepo) sat
  outside the repo. For each candidate, a probe
  module used the crate's real API on a path that runs only when an environment variable is
  set, so LTO could not strip it. Crates that hold state at run time ran in the idle
  server: the allocator, the logger, the `notify` watcher, and `rmcp` mounted at `/mcp` in
  the real router.
- Each variant: a clean `cargo build --release -p conn-server` with the workspace profile
  (`opt-level = "z"`, thin LTO, one codegen unit, `panic = "abort"`, stripped). Then the
  server started with an empty state dir, waited 3 s, and was read with `ps` RSS and
  `footprint`.
- **These are Mac figures** (macOS arm64, Rust 1.95, 16 cores). The binary size deltas carry
  over to Linux closely. Memory does not: macOS uses its own malloc, not musl's.
- Build times are noisy. Another agent built on the same machine during the runs, and clean
  builds varied from 39 to 61 s with no clear link to the crate.
- "Deps" counts unique packages in `cargo tree -p conn-server -e normal`.

Baseline: **5,023,024 bytes, 83 deps, idle RSS 4,768 KiB, footprint 2,000 KB, 39–42 s.**

| Variant (version)                          | Binary Δ   | Deps Δ | Idle footprint Δ | Idle RSS Δ | Notes                                                           |
| ------------------------------------------ | ---------- | ------ | ---------------- | ---------- | --------------------------------------------------------------- |
| `rustix` 1.1.6 (`process`)                 | +0.2 KB    | +1     | 0                | −80 KB     | libc already linked                                             |
| `lexopt` 0.3.2                             | +18 KB     | +1     | +16 KB           | +16 KB     |                                                                 |
| `uuid` 1.29.2 (v4, v7)                     | +18 KB     | +2     | +32 KB           | +32 KB     | free once `rmcp` is in (it depends on `uuid`)                    |
| `log` + `env_logger` 0.11 (no defaults)    | +20 KB     | +2     | +32 KB           | +48 KB     |                                                                 |
| `pty-process` 0.5.4 (`async`)              | +20 KB     | +2     | −16 KB           | −32 KB     | shares `rustix`                                                 |
| `rusqlite` 0.37 → 0.42                     | +16 KB     | −3     | +112 KB          | +128 KB    | bundled SQLite 3.54.1                                           |
| `portable-pty` 0.9.0                       | +100 KB    | +10    | 0                | +48 KB     | rejected: blocking reader per PTY                               |
| `tracing` 0.1.44 + `tracing-subscriber` fmt | +104 KB    | +8     | +112 KB          | +208 KB    | `tracing` comes free with `rmcp`                                 |
| `clap` 4.6.7 (derive, minimal)             | +174 KB    | +6     | +32 KB           | 0          | rejected for now                                                |
| `jiff` 0.2.43                              | +196 KB    | +2     | +96 KB           | +112 KB    | rejected                                                        |
| `sonic-rs` 0.5.10                          | +208 KB    | +10    | 0                | +32 KB     | rejected                                                        |
| `tower-http` 0.6.11 `fs` + axum `multipart` | +228 KB    | +11    | +128 KB          | +192 KB    |                                                                 |
| `tracing-subscriber` + `env-filter`        | +432 KB    | +11    | +112 KB          | +240 KB    | `env-filter` pulls in `regex`                                    |
| `mimalloc` 0.1.52                          | +88 KB     | +2     | **+640 KB**      | +656 KB    | rejected for now                                                |
| `tikv-jemallocator` 0.7.0                  | +231 KB    | +2     | **+560 KB**      | +768 KB    | rejected for now                                                |
| `notify` 8.2.2, recursive watch of a tree   | +61 KB     | +6     | **+928 KB**      | +4.6 MB    | its own FSEvents thread; cost grows with the tree               |
| `git2` 0.21 (vendored libgit2)             | +659 KB    | +3     | +464 KB          | +3.8 MB    | C build, +19 s build; rejected                                  |
| `rmcp` 3.10.0 (server, streamable HTTP)    | **+1.03 MB** | +46  | +80 KB           | +400 KB    | mounted in the real router                                      |
| `ignore` 0.4.34 + `regex` 1 + `nucleo-matcher` 0.3.1 | **+1.13 MB** | +14 | +176 KB  | +160 KB    | `regex` is most of it                                           |
| the same + `grep-searcher`/`grep-regex`    | +1.43 MB   | +22    | +160 KB          | +224 KB    | `grep-*` adds 0.3 MB (`encoding_rs`)                             |
| `gix` 0.90 (`status`, `sha1`)              | **+1.70 MB** | **+96** | +176 KB       | +320 KB    | rejected                                                        |
| **Adopt set combined**                     | **+2.48 MB** | +75  | +400 KB          | +1.0 MB    | everything marked adopt below                                   |

`rmcp` was also run on the current-thread runtime. `initialize`, `notifications/initialized`
and a `tools/call` all worked through the real router, and the server held a 2.9 MB footprint
after that session.

## Inventory and recommendation

Line counts are from `rust/base`, tests included where they sit in the same file.

| Part | Today | Recommendation | Measured cost | Maintenance saved | Work to switch |
| --- | --- | --- | --- | --- | --- |
| HTTP, WebSocket | axum 0.8.9 (`http1, ws, json, query, tokio, form`), hyper 1, tokio-tungstenite 0.29 via axum | **keep** | — | — | — |
| Effect RPC wire codec | ours: `conn-wire` (445 lines), `session.rs` (397) | **keep ours** | — | No crate speaks Effect RPC | — |
| Contract types | ours: `gen-contract.mjs` (1,251 lines) → `generated.rs` (25k lines) | **keep ours** | — | typify works from JSON Schema, not Effect Schema, and turns tagged unions into untagged ones | — |
| JSON | `serde_json` 1 | **keep** | `sonic-rs` +208 KB, 10 deps, much `unsafe`, flatten bug (#114) | none | — |
| SQLite, event store | `rusqlite` 0.37 `bundled`; store ours (759 lines) | **adopt** `rusqlite` 0.42 | +16 KB, −3 deps | Two use-after-free fixes reachable from safe code (0.41, 0.42), and an SQL injection fix in savepoint names (0.40.1) | Small: 0.38 turned off `u64` ToSql and made the statement cache optional; 0.41 changed `column_names` to return an iterator. MSRV 1.89, ours is 1.95 |
| Async runtime | tokio 1, current thread | **keep** | — | — | — |
| Child processes: line framing, supervision | ours: `process.rs` (372) | **keep ours** (share it with Codex) | — | No crate fits a bounded line reader plus reaper better than tokio's | Move to a shared crate when the Codex provider lands |
| Process-group kill | ours: runs `/bin/kill -KILL -<pgid>` as a child (`process.rs:80`) | **adopt** `rustix::process::kill_process_group` | +0.2 KB, +1 dep | No `kill` binary needed in a slim image, no extra fork, and failures come back typed | 15 lines |
| SIGTERM, shutdown | none: the server dies, and `claude` children in their own groups live on | **adopt** `tokio::signal` (tokio's `signal` feature) | ~0 | Clean stop of children, final writes | ~40 lines, see [Risks](#risks-of-what-we-wrote-by-hand) |
| Command line | ours: `serve.rs` (50 lines), panics on bad input | **adopt** `lexopt` | +18 KB, +1 dep | Errors instead of panics, `--flag=value`, non-UTF-8 paths | 1 hour. Move to `clap` derive (+174 KB) only when the flags need generated help or env fallbacks across many flags |
| Auth: tokens, hashing, random | ours: `auth.rs` (573) with `getrandom` 0.3 and `sha2` 0.10 | **keep ours** | — | It mirrors the TS pairing rules exactly. `getrandom` and `sha2` already do the crypto | When `rmcp` lands, align on `getrandom` 0.4 and `sha2` 0.11 to drop the duplicate copies it brings |
| Ids | ours: `uuid_v4` from std's `RandomState` hasher (`ids.rs:157`) | **adopt** `uuid` (v4) | +18 KB, free with `rmcp` | A real v4 from the OS random source; v7 when ordering helps | 10 lines |
| Time | ours: ISO-8601 formatting, three copies (`conn-engine/time.rs`, `conn-provider-claude/ids.rs`, `conn-server/auth.rs`) | **keep ours**, merge into one module | `jiff` +196 KB | Little: format only, no parsing or time zones | 1 hour to dedupe. Adopt `jiff` if a feature must parse dates or use time zones |
| Logging | `println!`/`eprintln!` (20 sites) | **adopt** `tracing` + `tracing-subscriber` (fmt, no `env-filter`) | +104 KB, 8 deps; `tracing` is free with `rmcp` | Levels, fields, one place to route output; captures `rmcp`'s own events | Half a day. Use `RUST_LOG`-style filtering only if needed (+432 KB with `env-filter`) |
| Errors | `Result<_, String>` in engine, store and session; `thiserror` 2.0.21 already in the tree (via tungstenite) | **adopt** `thiserror` for the crate interfaces | 0 (already linked) | Typed causes, `source()` | Grows with each track; start with `conn-engine` |
| Allocator | system (musl mallocng on Linux) | **watch** | `mimalloc` +640 KB idle, `jemalloc` +560 KB idle (macOS) | none at one thread | Measure on Linux musl under load before changing |
| Tests | `cargo test`, tokio `test-util`, hand registry (`tests/registry`, 2,702 lines), Node replay tools | **adopt later** `insta` (dev only) for event-stream snapshots; `cargo-nextest` in CI | 0 in the binary | Snapshot review instead of hand JSON asserts in `replay_tests.rs`/`engine_tests.rs` | When a test file next changes a lot |
| `/mcp` server | ours: `conn-mcp` `transport.rs`, `sessions.rs` (about 300 lines) | **keep ours** (was: adopt `rmcp` 3.10) | `rmcp` measured +0.94 MB binary and +0.12 MB per open session | The T3 server answers one protocol revision (2025-06-18) without SSE; ours matches it | Decided by the measurement in `crates/conn-mcp/README.md`; commit `35cfdba72b` keeps the `rmcp` wiring |
| PTY | stub | **adopt** `pty-process` 0.5.4 `async` | +20 KB | `openpty`, `setsid`, controlling terminal, resize: the `unsafe` we may not write | The terminal track. `AsyncFd`, no reader thread |
| Git | stub | **keep ours: `git` CLI** | `gix` +1.70 MB/+96 deps; `git2` +659 KB, C build, +3.8 MB RSS | — | The TS server uses the CLI too (`apps/server/src/vcs/GitVcsDriver.ts`), so behaviour matches. `gix` status/diff is still incomplete (`crate-status.md`) |
| File walking with ignore rules | stub | **adopt** `ignore` 0.4 (serial `WalkBuilder::build`, never `build_parallel`) | in the search set | gitignore, `.git/info/exclude`, global excludes | Files track |
| Fuzzy file search | stub | **adopt** `nucleo-matcher` 0.3.1 (not `nucleo`, which brings a rayon pool) | in the search set | Scoring, Unicode | The TS server uses `fff` (`@ff-labs/fff-node`). Its Rust core `fff-search` pulls in `git2`, LMDB (`heed`), `rayon` and `notify`, so matching its ranking exactly is not worth it |
| Content search | stub | **adopt** `regex` over the `ignore` walk; add `grep-searcher` only for binary detection or large files | `grep-*` +0.3 MB more | — | Files track |
| File watching | stub | **adopt later** `notify` 8.x, started only while a client subscribes, bridged into tokio with a channel | +928 KB footprint, +4.6 MB RSS idle on one recursive tree | FSEvents, inotify, rename handling | Only if a feature needs pushes. The TS server watches a few single files (keybindings, themes) and polls git otherwise. 9.0 is in RC |
| Codex `app-server` types | stub | **generate**: our own generator over Codex's checked-in JSON Schema | — | — | See [Codex](#codex-app-server-protocol) |
| Claude stream-JSON types | ours: `protocol.rs` (588), `mapper.rs` (1,813) | **keep ours** | — | No official Rust SDK. Community crates (`claude-agent-sdk-rs`, `cc-sdk`) have one maintainer each and own the process model we need to control | — |
| Static files, uploads | stub (`routes/assets.rs`) | **adopt** `tower-http` 0.6 (`fs`, later `limit`) + axum `multipart` | +228 KB, +11 deps | Range requests, ETag, MIME, path traversal guards, multipart parsing | Files or assets track. `tower-http` 0.7 exists; take it with axum's own bump |

### Codex app-server protocol

- OpenAI does not publish the protocol crate. The `codex-app-server-protocol` on crates.io
  (0.63.0, 2025-12) comes from a fork. The real crate (`codex-rs/app-server-protocol`,
  Apache-2.0) depends on about a dozen internal Codex crates and on `rmcp`, `zstd` and more.
  A git dependency would drag in all of that.
- Codex checks the generated JSON Schema into its repo
  (`codex-rs/app-server-protocol/schema/json`). It can also print it with
  `codex app-server generate-json-schema`. That schema is the input to use.
- typify 0.8 on `ServerNotification.json` (224 KB, 236 definitions) gave 26,507 lines. It made
  the top-level union `#[serde(untagged)]` with variants `Variant0…N`, not one keyed on
  `method`. Decoding then tries each variant in turn, and errors carry no useful detail.
  Typify issue #498 (internally tagged enums) is still open.
- **Recommendation:** extend our own generator so it also reads JSON Schema, and write the
  method dispatch by name. Generate only the definitions the provider uses, and keep the
  schema's Codex commit next to it. The protocol moved about 3 commits a day over the last
  3 months, so the Codex provider should pin the CLI version it supports, as the Claude
  provider pins `CLAUDE_AGENT_SDK_VERSION`.

## Switches worth making, in order

1. **`rustix` + `tokio::signal`: process groups and shutdown.** Today a group kill forks
   `/bin/kill`, which a slim container image may not have. Then the agent's Bash jobs live
   on. Nothing handles SIGTERM, so stopping the server leaves every `claude` child, about
   140 MiB each, running in its own group. `rustix::process::kill_process_group` is safe to
   call, costs 0.2 KB, and comes from the Bytecode Alliance. A SIGTERM handler then closes
   sessions with the grace period `process.rs` already has. Highest value for the least code.
2. **`tracing` + `tracing-subscriber` (fmt), then `thiserror` at crate edges.** Every track
   adds error paths now. If they all log with `eprintln!` and return `String` errors, the
   later change touches every file. `thiserror` is
   already linked. Doing it before the tracks merge sets the pattern they copy.
3. **`rusqlite` 0.42.** The store is our one store of record, and 0.38 to 0.42 fixed two
   use-after-free bugs reachable from safe code and one SQL injection. It saves 3 deps, and
   the API changes are small. Do it on the engine track's branch, which owns `store.rs`.
4. `uuid` in place of `uuid_v4`, and `lexopt` in place of the hand parser (an hour each).
5. `pty-process` (terminal track), `ignore` + `nucleo-matcher` + `regex`
   (files track), `tower-http` + `multipart` (assets), each as its track lands.
6. Merge the three ISO-8601 formatters into one module in `conn-contract`.
7. Later, with numbers from Linux: `insta`, `notify` on demand, and an allocator only if a
   musl load test shows mallocng costs.

## Rule for the tracks

A maintained crate replaces our own code when **all** of these hold. Measure with a scratch
build as in [Method](#method) and state the numbers in the commit.

1. **Maintained.** It had a release in the last 12 months, or it is feature-complete from a
   known maintainer (an org, a foundation, or a maintainer with a record like ripgrep's).
   Its licence passes `cargo-deny`.
2. **Fits the runtime.** No `rt-multi-thread`, and no thread pool of its own. One helper
   thread is acceptable only when the OS API demands it (`notify`), and then only while a
   client needs it. Blocking APIs run in `spawn_blocking`. `unsafe` inside the crate is
   fine. Needing `unsafe` in our code is not.
3. **Cheap enough.**
   - A convenience crate costs at most +100 KB of binary and +100 KB of idle footprint.
   - A crate that replaces a protocol, a file format or OS plumbing we would otherwise
     maintain may cost up to about +1.5 MB. `rmcp` and `ignore` are the examples.
   - No new C dependency while a pure-Rust option exists. Bundled SQLite is the exception.
4. **Worth it.** It replaces about 200 lines or more, or code where a mistake is a security
   or protocol bug: randomness, signals, path handling, a protocol.
5. **Fits the tree.** Run `cargo tree -i <crate>` first. Take the versions already in the
   tree, and match the versions `rmcp` brings, to avoid duplicates.

Keep our own code when it *is* the contract (wire codec, contract generator, provider
mappers), when it is under 100 lines and stable (time formatting), or when the crate's model
fights the runtime (`nucleo`, `portable-pty`, `fff-search`).

## Risks of what we wrote by hand

| Part | What can go wrong | Guard today | Add |
| --- | --- | --- | --- |
| Claude mapper, `mapper/` | It builds contract values as `json!` and decodes them with `from_json`. It no longer unwraps (0 in `mapper/mod.rs`), but a contract change, such as a new required field or a renamed enum value, still makes the decode fail at run time, not at compile time. The CLI's stream-JSON has no published schema and moves with each CLI release | `replay_tests.rs` over recorded transcripts; manual `live_` tests | Build the typed structs directly, so the compiler catches drift. Until then, turn a failed decode into a turn failure. Re-record transcripts when the pinned `CLAUDE_AGENT_SDK_VERSION` moves. For comparison, read the SDK's `sdk.d.ts` (commercial licence: read it, do not vendor it) and the MIT Python SDK's `types.py` |
| Wire codec, frame parts, ack window (`conn-wire`, `session.rs`) | Drifts when the monorepo bumps `effect` (now 4.1.3) or changes `socketFrameParts.ts` or `OutputProtocol.ts` | Recordings decode-check, `effect-client.mjs`, `replay.mjs`, `session/tests.rs` | Run those in CI on every Conn pin bump, keyed on the `effect` version in the pinned lockfile |
| Contract generator (`gen-contract.mjs`) | It reads `SchemaRepresentation`, an internal part of Effect. An Effect upgrade can change the IR, and new shapes fall back to `Opaque` | `--check`, `generated/report.json`, `test-contract-change.mjs`, `tests/registry`; `bump-conn.sh` fails its `opaque fallbacks` step when the count rises | — |
| Process supervision | Covered above: the fork of `/bin/kill`, no SIGTERM handling, orphaned children | none | Switch 1, plus a test: spawn `sh` with a background child and check the group is gone after `close` |
| Auth (`auth.rs`) | Edge cases in expiry, ticket audience, and code reuse after a restart. The design looks sound: hashed tokens at rest, a mode-0600 file, rejection-sampled codes, route-bound tickets | 6 unit tests in `auth.rs` | Check against `apps/server/src/auth` on each pin bump. I did not check whether failed exchanges are rate-limited |
| `uuid_v4` | It is built from the std hasher's keys, which is not a CSPRNG. It is fine for uniqueness today, but it is a trap if someone reuses it for a secret | — | Switch 4 |
| Event store schema | Was `CREATE IF NOT EXISTS` only. Fixed on `rust/engine` (`62f9acb4c3`) with `PRAGMA user_version` migrations | engine tests | — |

## Lint set (BeautifulRust)

`lints/beautiful-rust/lints.toml` (as `[workspace.lints]`, next to our
`unsafe_code = "forbid"`) and `clippy.toml` applied to a scratch copy of `rust/base`.
`cargo clippy --workspace --all-targets --all-features`, warnings deduplicated by lint and
location.

**`generated.rs` alone gives 11,468 warnings.** The generator should put one inner
`#![allow(..., reason = "generated by gen-contract.mjs")]` at the top of the file. The skill
allows `#[allow]` in generated code. Everything else gives **806 warnings**:

| Count | Lint | Count | Lint |
| --- | --- | --- | --- |
| 423 | `missing_docs` [lib] | 11 | `print_stdout` [lib] |
| 73 | `unwrap_used` (31 in `src/`, 40 in examples) | 10 | `unreachable_pub` |
| 39 | `as_conversions` (13 in `store.rs`) | 9 | `print_stderr` [lib] |
| 28 | `exhaustive_enums` [lib] | 9 | `map_unwrap_or` |
| 28 | `clone_on_ref_ptr` | 8 | `doc_markdown` |
| 17 | `missing_debug_implementations` | 7 each | `too_many_lines`, `semicolon_if_nothing_returned`, `ignored_unit_patterns` |
| 13 | `cast_possible_truncation` | 6 each | `missing_panics_doc` [lib], `allow_attributes`, `allow_attributes_without_reason`, `duration_suboptimal_units` |
| 13 | `fn_params_excessive_bools` | 5 | `redundant_closure_for_method_calls` |
| 12 | `cast_sign_loss` | 4 | `redundant_clone` |
| 12 | `needless_pass_by_value` | 25 | 15 other pedantic lints, 1 to 3 each |
| 11 | `missing_errors_doc` [lib] | | |
| 11 | `cast_possible_wrap` | | |

By crate: `conn-provider-claude` 317, `conn-server` 146, `conn-engine` 104, `conn-provider` 99,
`conn-wire` 50, `conn-contract` 33, examples 53, tests 4.

**Enforce:** the file as written, with these changes for an application:

- **Allow:** `missing_docs`, `missing_errors_doc`, `missing_panics_doc`. The skill says
  these fit libraries. Our crates have one consumer, us. Keep docs on the three interfaces
  (`conn-provider`, `conn-engine`'s trait, `table.rs`) by review; they are already written.
- **Allow:** `exhaustive_enums`. Our public enums mirror a closed external contract (wire
  frames, CLI messages), and `#[non_exhaustive]` would only force wildcard arms inside the
  workspace.
- **Allow:** `too_many_lines`. The mapper's state machine reads better as one `match`. Watch
  it in review instead.
- **Keep `print_stdout` and `print_stderr`** even though they are marked [lib]. A server
  should log through `tracing` (switch 2). The startup lines in `serve.rs` (address,
  pairing URL) are the CLI's real output and get one `#[expect(..., reason)]`.
- **Keep `unwrap_used` with `expect_used` allowed.** `panic = "abort"` makes every reachable
  unwrap a server crash. Examples take a file-level `#![expect(clippy::unwrap_used, reason
  = "example")]`.
- **Keep `max-fn-params-bools = 0`.** The 13 hits (mapper helpers such as
  `provider_turn(.., false)`, table registration) are exactly the call sites the skill means.
  A private helper with nearby callers may take an `#[expect]` with a reason.

**Work for a clean run:**

- About 300 warnings remain after the allows. Most are mechanical: `Debug` derives,
  `Arc::clone(&x)`, `TryFrom` for casts, pedantic idiom fixes. About one agent-day.
- The 18 `from_json(..).unwrap()` calls in the mapper are the exception. Fixing them
  properly means typed construction, a separate change of a few hundred lines.
- Apply the lints after the eight tracks merge, or at least land the `[workspace.lints]`
  block at warn level first and turn on `-D warnings` in CI after the clean-up. Turning it on
  mid-track makes every branch conflict.

**Where today's code is furthest from `rust-best-practices`:**

1. **Panics on input paths (§5).** The mapper's `from_json(..).unwrap()` turns contract or
   CLI drift into an abort. `serve.rs` panics on a bad flag. `runner.rs` takes
   `lock().unwrap()` ten times, where the skill wants `expect("lock poisoned")`. §1
   ("make invalid states unrepresentable") also says to build typed values, not `json!`
   decoded at run time.
2. **`String` as the error type (§5).** `StoreResult<T> = Result<T, String>`,
   `SqliteEngine::open -> Result<Self, String>`, the control channel's
   `Result<Value, String>`. There is no `source()` and no context, and callers cannot
   match on a cause.
3. **Printing instead of logging (§6), and bool parameters (§4).** 20 `println!`/`eprintln!`
   sites carry runtime events, such as dropped CLI lines and skipped message kinds, with no
   level or fields. And 13 functions take `bool` flags that read as `false` at the call site.

## A separate repository

`conn-server` now has its own repo. `tools/check.sh` runs every check that needs no model;
the Node tools take the Conn monorepo from `CONN_MONOREPO` (`tools/monorepo.mjs`). These
checks keep the repo healthy, with the tool I recommend for each. Recall records an earlier decision (2026-11-04/05) of "no Rust CI for now" for the
monorepo. A separate repo changes that context, so this needs Nick's call.

| Need | Tool | Notes |
| --- | --- | --- |
| CI checks | GitHub Actions: `cargo fmt --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo nextest run --workspace` on `ubuntu-latest` and `macos-latest` (arm64) | `dtolnay/rust-toolchain` with a `rust-toolchain.toml` pinned to 1.95; `Swatinem/rust-cache`; `taiki-e/install-action` for nextest and cargo-deny |
| Supply chain | **`cargo-deny`** (`EmbarkStudios/cargo-deny-action`): advisories, licences, bans, sources, duplicates | It covers what `cargo-audit` does, plus licences and duplicates. The licence allowlist needs MIT, Apache-2.0, `Apache-2.0 WITH LLVM-exception` (rustix), MPL-2.0 (nucleo-matcher), CC0-1.0 (notify), Unlicense, BSD-3-Clause, Unicode-3.0, Zlib. Run it on every PR and nightly, so new advisories surface without a code change |
| Unused deps | `cargo-machete` in the nightly bot | Stable and offline; text-based, so expect a rare false positive |
| Size and memory gate | A CI step that builds the musl release binary and fails if it grows more than 3% over a baseline file; `cargo-bloat` to find the cause | Size is the cheap proxy. The memory figures in the README stay a manual Linux run |
| Dependency updates | **Dependabot** (`cargo` weekly, grouped minor/patch; `github-actions` monthly) | Native to GitHub, nothing to host. Renovate is the alternative if one tool should also bump the Conn pin through a custom regex manager |
| Release builds | Tag-triggered workflow: `x86_64-unknown-linux-musl` on `ubuntu-latest` with `musl-tools` (`musl-gcc` builds bundled SQLite), `aarch64-apple-darwin` on `macos-latest`; upload to GitHub Releases with `actions/attest-build-provenance` | `cargo-zigbuild` only if Linux must be built from macOS. Skip `cross` (Docker) and `cargo-dist` (more machinery than two targets need) |
| Pinned Conn commit | Keep `crates/conn-contract/methods.json` as the **one** pin (it already records the contract commit). A `tools/conn-checkout` script (not written yet) would do a blobless, sparse clone at that SHA (`packages/contracts`, `packages/shared`, `packages/provider-core`, `apps/web`, the lockfile), then `vp i`, and set `CONN_MONOREPO` to it | Not a git submodule: the monorepo is large, and the tools need its `node_modules` anyway. The nightly bot bumps the pin to Conn `main`, runs `gen-contract.mjs`, the decode-check, `effect-client.mjs` and `replay.mjs`, and opens a PR with the `generated.rs` and `methods.json` diff. `nckrtl/conn` access needs a read token in the repo secrets if it is private |

## Not measured

- Linux memory for any candidate, and musl mallocng against `mimalloc`/`jemalloc`. All
  memory figures here are macOS.
- `rmcp` under load, and its open issue #1325: in-flight tool calls are not cancelled when
  the client disconnects. (Moot while we keep our transport.)
- Whether typify's output for the Codex schema compiles, or how long it takes to compile.
- `notify` on Linux (inotify watches per directory) and on a large repository.
- Build times are not reliable (see [Method](#method)).
- Whether Dependabot groups Cargo workspace updates as described. I took that from general
  knowledge and did not check it in this session.

## Open questions

- CI for `conn-server`: does the "no Rust CI for now" decision still hold for the new repo?
- Do clients need file-change pushes, or is polling git on demand enough? That decides
  whether `notify` lands at all.
- May we read the Claude Agent SDK's `sdk.d.ts` (commercial licence) as the reference for
  stream-JSON types, or only the MIT Python SDK?
- Which Codex CLI version does the Codex track target? The generated types should pin it.
