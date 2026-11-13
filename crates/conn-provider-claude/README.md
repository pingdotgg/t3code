# conn-provider-claude

The Claude provider for the Conn Server. It drives the `claude` CLI over its stdio stream-JSON
protocol and implements `Provider` and `Session` from `conn-provider`. Reference behaviour:
`ClaudeAdapterV2.ts` in the Conn monorepo at the pinned contract commit.

## Layout

| Module             | Holds                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------- |
| `protocol`         | Typed CLI messages; unknown kinds and changed shapes fall back to raw JSON            |
| `launch`           | Executable, argv, environment, `initialize`, runtime mode → permission mode           |
| `mapper`           | Pure state machine: CLI messages → `ProviderEvent`s and CLI replies                   |
| `mapper/subagents` | Subagent rows and their child threads                                                 |
| `mapper/notices`   | Todo lists, API retries, usage limits, failure classes                                |
| `attachments`      | Image blocks and attachment paths in a user message                                   |
| `session`          | `Session`: lazy start, control requests, a driver and an idle watcher per process     |
| `ids`              | Re-export of `conn-provider-support::ids`; `DRIVER` (`claudeAgent`) lives in `lib.rs` |

The child process (bounded line reader, stdin writer, stderr tail, reaping, group kill), id
formats and the clock come from `conn-provider-support`, shared with the Codex provider. A
`session` driver decodes each stdout line with `Inbound::decode`.

No crate replaces `protocol`. The closest, `claude-codes` 2.1.323 (tracks CLI 2.1.322), is about
23k lines, pulls in `chrono` and `uuid`, breaks with nearly every CLI release, and lacks typed
`initialize` fields, `set_model`, `set_permission_mode`, `mcp_set_servers`, `mcp_status`,
`stop_task`, `elicitation` and `request_user_dialog`. The other Rust SDKs need `futures`,
`async-trait` or a multi-thread runtime. Checked on crates.io and GitHub on 2026-11-13.

## Launch policy

- **Executable:** `ClaudeConfig.binary`, default `claude` on PATH.
- **Setting sources:** `ClaudeConfig.setting_sources`. `None` (the default) passes no flag, so
  the CLI loads user, project and local settings, hooks and MCP helpers, as under T3.
  `Some(vec![])` loads none: use it in containers, where auth comes from the environment.
- **Environment:** inherit the host environment, then:
  - remove a parent Claude session's variables (`CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`, ...),
    plus `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS` and `DEBUG`
  - set `CLAUDE_CODE_ENTRYPOINT=t3-code`, `CLAUDE_CONFIG_DIR` when `home_path` is set, the
    instance's own env, `MCP_CONNECTION_NONBLOCKING=0` on resume, `T3CODE_THREAD_ID`, and the
    SDK's `CLAUDE_AGENT_SDK_VERSION` and `CLAUDE_CODE_SDK_READS_SESSION_STATE=1`
- **argv:** the SDK's order and `--flag=value` form, plus:
  - `--resume=<id>` or `--session-id=<id>`; `--resume-session-at=<uuid>` after a rollback;
    `--resume=<source> --fork-session --session-id=<new>` for a fork's first turn
  - `--allowedTools=mcp__t3-code__*` when the session has a `t3-code` MCP server
- **`initialize`:** `appendSystemPrompt` (T3's runtime instructions, plus
  `ClaudeConfig.mcp_instructions` with a `t3-code` server), `title`, `promptSuggestions: false`,
  `supportedDialogKinds: ["resume_return"]`.
- **MCP servers:** `Session::set_mcp_servers` (name, URL, headers). Sent after `initialize` as
  `mcp_set_servers`, as the TS query runner does, so credentials stay out of argv. A server
  that fails to connect is logged by name only. A list change on a live process is sent at
  once; gaining or losing `t3-code` needs a new process (`--allowedTools`).
- **Model and effort:** a model change is `set_model`; an effort change is
  `apply_flag_settings {effortLevel}`; clearing an effort or changing bypass needs a new
  process. Permission mode changes are `set_permission_mode`.

## Idle children

T3's session manager releases an idle provider session after 30 minutes
(`DEFAULT_IDLE_TIMEOUT_MS`), unless background work holds it (up to 4 hours,
`DEFAULT_MAX_IDLE_PIN_MS`); the next turn resumes with `--resume`. Here the session keeps its
state and only the child ends: `ClaudeConfig.idle_timeout` (default 30 minutes) and
`idle_max_hold` (default 4 hours). A running subagent or output held for a continuation
counts as background work (`Session::has_pending_background_work`).

## Event mapping

| CLI                                               | Events                                                                                                                 |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| user message written                              | `provider_turn.updated` running, `provider_thread.updated` active                                                      |
| `stream_event` `message_start` / `message_delta`  | `provider_turn.updated` with `tokenUsage`                                                                              |
| text / thinking deltas                            | every 50 ms: `node` + `message` + `turn_item` (`assistant_message`, streaming) or `reasoning`                          |
| block stop or `assistant` snapshot                | the same, completed                                                                                                    |
| `assistant` `tool_use`                            | `node` + `turn_item` (`command_execution`, `file_change`, `web_search`, `dynamic_tool`) running                        |
| `assistant` `tool_use` TodoWrite                  | also `node` + `plan.updated` + `turn_item` (`todo_list`); the previous list is superseded                              |
| `user` `tool_result`                              | the tool row completed / failed / cancelled / interrupted, with output                                                 |
| `tool_result` of TaskCreate/TaskUpdate/TaskList   | also a `todo_list` for the session's task list                                                                         |
| `assistant` `tool_use` Agent                      | nothing; remembers the launch's model, effort and owner                                                                |
| `system` `task_started`                           | `app_thread.created` (child thread), `node` (subagent, child root), `subagent.updated`, prompt message, `subagent` row |
| `system` `task_progress` / `task_notification`    | `subagent.updated` and row with progress / result; child result message                                                |
| frames with `parent_tool_use_id`                  | child-thread messages, reasoning and tool rows; held (capped) until `task_started`                                     |
| Agent `tool_result`                               | settles a foreground subagent; a background launch ack is ignored                                                      |
| root frames with no turn running                  | held (capped) and `continuation.requested`; `start_continuation_turn` replays them                                     |
| steer written (`priority: "now"`)                 | `steer.updated` pending; completed on `command_lifecycle` started or an echo; the `aborted_*` result folds in          |
| `can_use_tool`                                    | approval: `node` + `runtime_request` + `turn_item` (`approval_request`)                                                |
| `can_use_tool` AskUserQuestion / ExitPlanMode     | `user_input_request` / `plan.updated` (proposed plan)                                                                  |
| `elicitation`, `request_user_dialog`              | field-less form as an approval card; `resume_return` as a question                                                     |
| `control_cancel_request`                          | request, node and item `cancelled`                                                                                     |
| `system` `status` compacting / `compact_boundary` | `compaction` row running, then completed with token counts and a usage update                                          |
| `system` `api_retry`                              | `error` row with `retry` (running, then recovered); on failure the retry goes on `turn.terminal`                       |
| `rate_limit_event` rejected                       | `system_notice` with the window and the wait; the turn's failure becomes `usage_limit` with `resetAt`                  |
| `system` `informational`                          | `system_notice` row                                                                                                    |
| `result`                                          | open rows closed, pending requests cancelled, `provider_turn.updated`, `provider_thread.updated`, `turn.terminal`      |
| process exit mid-turn                             | running subagents end, `turn.terminal` failed, `transport_error` / `claude_process_exited`                             |

Failure classes follow `providerFailureFromResult` and `terminalStatusFromResult`
(`terminal_reason`, 429/529, auth, usage limits, context window full); messages are redacted
of bearer tokens and `sk-` keys.

## Replay against the TS adapter

`src/replay_tests.rs` replays recorded CLI output (`testdata/cli`, CLI 2.1.322) through the
mapper and compares the events with what `ClaudeAdapterV2` emitted for the same lines
(`testdata/ts`). Eight recordings match: a simple turn, a second turn, an interrupt, a
permission turn, a background subagent with its continuation turn, a foreground subagent, a
steer, and an image. Both live inside this crate; the tests need no monorepo.
`tools/capture-ts` regenerates `testdata/ts` from a Conn monorepo checkout (`CONN_MONOREPO`,
default `/Users/nckrtl/apps/conn`); see its README.

Normalized in the comparison:

- Runtime request ids end in a random uuid.
- `threadId: null` appears where TS leaves the key out.
- TS-only fields: `nativeMetadata` (attachment budget), `goal`, `pendingBackgroundWork`,
  `pendingBackgroundTasks`, `failureItemOrdinal`, `turnTokenUsage.otherUsage`.
- TS repeats an unchanged `provider_turn.updated` or `provider_thread.updated`.
- `continuation.requested` is ours; TS uses a separate service.

## Known differences from `ClaudeAdapterV2`

- **Continuation timing:** TS asks for the continuation turn when the background task's
  notification arrives; this provider asks when Claude starts writing. The events match.
- **Subagents:** no workflow subagents (`local_workflow`), no recovery of running subagents
  after a restart (`getSubagentMessages`), model slugs not canonicalized through a catalog,
  `stopSubagent` not offered.
- **Task list:** starts from the task tools it sees; TS first reads the list Claude saved on
  disk.
- **Attachments:** PDFs stay path-only (TS embeds one only when its strict page scanner
  succeeds). No captured-window context for snap-shot images. The 28 MiB inline budget lives in
  memory and starts over after a restart.
- **Context window:** a small table of the current models, from T3's bundled
  `model-manifest.json`, then the CLI's reported window. No downloaded catalog.
- **Models:** the provider entry uses a static model list.
- **Interrupt** returns when the CLI acknowledges; TS waits for the terminal.
- **Elicitation:** only field-less forms; TS fills simple forms.
- **Bypass downgrade** when settings forbid bypass is not done (needs `resolveSettings`).
- **Process cleanup:** the CLI runs in its own process group, killed after the CLI exits.
- **No `/mcp` instructions text** in this crate: the server passes it as `mcp_instructions`.

## History operations

| Operation          | Here                                                                                                                                   |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| rollback to a turn | `nativeConversationHeadRef` = the turn's assistant uuid; the next launch adds `--resume-session-at`; cleared after a turn runs past it |
| rollback to start  | a new native session id; the old transcript stays on disk (as TS)                                                                      |
| fork               | lazy: the new thread records source and cut point; its first launch uses `--fork-session`                                              |
| thread snapshot    | unsupported, as in TS                                                                                                                  |
| history injection  | unsupported, as in TS                                                                                                                  |

The SDK's disk helpers, decided one by one:

| Helper                | Decision                                                                                                                                              |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `forkSession`         | CLI flags (`--resume --fork-session --resume-session-at`): the CLI makes the copy; no file format to track                                            |
| `getSessionMessages`  | not needed: the fork's head is the cut point we pass, not a remapped uuid read back from disk                                                         |
| `getSubagentMessages` | not done: only resume recovery of running subagents and forked-skill models use it; reading Claude's transcript files ties us to their private format |
| `resolveSettings`     | not done: only the bypass downgrade and a delegated child's cache TTL use it; T3's settings merge would have to be re-implemented                     |

## Memory (macOS arm64, CLI 2.1.322, Haiku)

`cargo run --release -p conn-provider-claude --example rss` (`RSS_SETTINGS=minimal`,
`RSS_TURNS=12`). Footprint is private memory.

| Claude child tree after one turn                     | Processes | RSS     | Footprint |
| ---------------------------------------------------- | --------- | ------- | --------- |
| user's settings (hooks, plugins, 5 MCP helpers)      | 6         | 573 MiB | 294 MiB   |
| minimal (`--setting-sources user`, empty config dir) | 1         | 254 MiB | 145 MiB   |
| after the idle timeout                               | 0         | 0       | 0         |

The host process (this provider in a current-thread runtime) stays near 4–5 MiB RSS: 4.2 MiB
after turn 1, 4.9 MiB after turn 12, the same after the child closed and the session dropped.
A test replays 200 rounds of subagent, steer and permission recordings into one mapper and
checks that every per-session collection keeps its size.

## Tests

```sh
cargo test -p conn-provider-claude                          # offline: recordings, process, launch
cargo test -p conn-provider-claude live_ -- --ignored --test-threads=1   # real CLI, Haiku
cargo run --release -p conn-provider-claude --example rss   # memory
```

The live tests cover one turn, a permission round trip, interrupt, resume in a new session,
steer, idle close then resume, an MCP tool call through a tiny in-test HTTP MCP server, fork
and rollback. They run in an empty temporary folder and delete it and its session folder
under `~/.claude/projects`.
