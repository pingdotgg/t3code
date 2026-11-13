# conn-provider-codex

The Codex provider for Conn Server. It drives `codex app-server` (JSON-RPC on stdio) and
implements `Provider` and `Session` from `conn-provider`. Reference behaviour:
`CodexAdapterV2.ts` in the Conn monorepo. `PROTOCOL.md` maps the protocol and the event
mapping.

## Layout

| Module     | Holds                                                                               |
| ---------- | ----------------------------------------------------------------------------------- |
| `protocol` | JSON-RPC frames; params stay `serde_json::Value`                                    |
| `launch`   | argv, environment, `initialize`, `thread/start`, `turn/start` params                |
| `mapper`   | Pure state machine: frames → `ProviderEvent`s and replies; replay-tested            |
| `client`   | The app-server process shared by the instance's sessions; request ids, routing      |
| `session`  | `Session`: one native thread per session, a driver task, the 50/400 ms text flushes |

Ids, line framing and the process supervisor come from `conn-provider-support`.

## Process model

One `codex app-server` per provider instance, shared by every session, as the TS server does.
It starts on the first thread call and stops when the last session closes. The router sends
each notification and server request to the session that owns its `threadId`. If the process
dies, open turns end as failed, and the next call starts a new process and resumes the thread
(`thread/resume`).

## Launch (matches the TS server)

- **Executable:** `CodexConfig.binary`, default `codex` on `PATH`, `~` expanded. The instance
  is offered only when the binary exists (`CodexProvider::detect`).
- **argv:** `app-server -c thread_unload_delay_secs=0`, then `T3CODE_CODEX_LAUNCH_ARGS` or
  `CodexConfig.launch_args`.
- **Environment:** inherited whole. Added: `CODEX_INTERNAL_ORIGINATOR_OVERRIDE=T3 Code`, the
  instance's own entries, and `CODEX_HOME` when a home path is set. Nothing is removed, so in
  an Orbit container the variables and `config.toml` that point Codex at the AI router pass
  through. No sign-in call is made.
- **Thread config:** `tools.update_plan.enabled`, `mcp_optional_startup_grace_ms: 10000`,
  `features.concurrent_reasoning_summaries`, and `T3CODE_THREAD_ID` through
  `shell_environment_policy.set`.
- **Turn policy:** per turn, from the runtime mode (table in `PROTOCOL.md`), so model, effort
  and mode changes apply on the next turn.

## Supported

Turns with streamed text and reasoning, token usage, the executed model (reroutes included),
command rows with output deltas, file changes, web search, MCP and dynamic tool rows,
image-view rows, proposed plans, todo lists, context compaction rows, MCP start-up failure
notices, command / file-change / permission / legacy approvals with session allowances,
structured questions, steering, interrupt (with background terminals stopped and a 10 s
fallback), usage-limit and provider failures, thread resume after a restart.

## Not implemented

- **Subagents:** `collabAgentToolCall`, `subAgentActivity` and child threads are skipped.
- **Thread operations:** rollback, fork, snapshots, compaction requests, history injection,
  goals, unload and archive, feedback upload.
- **Retries:** `error` with `willRetry: true` makes no retry row; the turn keeps running.
- **Rate limits:** `account/rateLimits/*` is ignored, so usage-limit failures have no `resetAt`.
- **Attachments:** images and files are not sent.
- **T3 MCP:** no `mcp_servers.t3-code` and no `additionalContext`; Conn Server has no `/mcp`
  for Codex yet.
- **Tool rows:** MCP presentation (titles, icons, surfaces) and MCP apps.
- **Elicitations:** declined. `item/tool/call` and auth-refresh requests get an error reply.
- **Image generation**, prompt suggestions, async questions in agent messages, the Orbit MCP
  network wait before the first spawn, and the Linux systemd agent scope.

## Known differences from `CodexAdapterV2`

- Command rows carry no `completionWake`: Conn Server has no background continuation.
- `turn.terminal` has no `failureItemOrdinal` or `retryStartedAt`: the trait has no field.
- Capabilities switch off what is listed above.

## Version tie

The crate reads the few fields it uses by name and tolerates new ones. Unknown methods and
items are skipped and logged once each. `TESTED_CLI_VERSION` (0.167.0) names the release
whose printed schema was checked; a newer minor version logs a warning at start-up. When the
CLI changes a field the mapper reads, the replay tests do not notice; the live tests do.

Typed upstream definitions were measured and not used:

| Option                                        | State (2026-11-13)                                                                                                            | Cost                                                          |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `codex-app-server-protocol` in `openai/codex` | Apache-2.0, not published (workspace version 0.0.0); depends on rmcp, zstd, uuid, tracing and seven internal crates           | not vendorable at small cost                                  |
| `codex-app-server-protocol` on crates.io      | a third-party republish, 0.63.0, December 2025                                                                                | a year behind the CLI                                         |
| `codex-codes` on crates.io                    | Apache-2.0, third party, 0.167.8 (tracks the CLI's version), released daily, 32k downloads; serde types, unknown methods kept | decoded all 3,372 recorded frames; +1.0 MB in a release probe |
| hand-written reads of `Value` (this crate)    | ~20 fields                                                                                                                    | crate code 81 KB                                              |

## Tests

```sh
cargo test -p conn-provider-codex                                                # offline
cargo test -p conn-provider-codex live_ -- --ignored --test-threads=1 --nocapture  # real CLI
node tools/capture-ts-events.mjs        # regenerate testdata from CONN_MONOREPO (default /Users/nckrtl/apps/conn)
```

- `src/replay_tests.rs` replays 15 of the TS test kit's 25 Codex recordings (all that do not
  need subagents, rollback, fork or a transformed transcript) and compares every event with
  the TS adapter's output for the same lines, after the normalizations listed there. Replies
  to approvals and questions must equal the recorded frames.
- `session::tests` drives a whole session against a scripted fake app-server: a turn, an
  approval, an interrupt, close and process exit.
- The live tests use `gpt-6-luna` in a temporary folder.
