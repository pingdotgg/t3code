# conn-provider-claude

The Claude provider for the Conn Server. It runs Claude through Anthropic's official Agent SDK
(`@anthropic-ai/claude-agent-sdk` 0.3.321, as the T3 server) in the SDK host, a small Node
program (`helpers/sdk-host`, driver `claude`), and implements `Provider` and `Session` from `conn-provider`. The SDK
starts the `claude` CLI and speaks its protocol; this crate builds the same `query()` options
the T3 server builds and maps the SDK's messages to events. Reference: `ClaudeAdapterV2.ts`
in the Conn monorepo at the pinned commit.

## Layout

| Module             | Holds                                                                                   |
| ------------------ | --------------------------------------------------------------------------------------- |
| `helper`           | The shared SDK host process: start on first query, stop after the last, a router per process |
| `launch`           | The `query()` option object, its environment, the runtime policy → permission mode       |
| `catalog`          | `compileClaudeModelSelection` over T3's bundled catalog (`model_catalog.json`, generated) |
| `ordered`          | JSON with T3's key order for what the SDK writes to the CLI verbatim                    |
| `protocol`         | Typed SDK messages; unknown kinds and changed shapes fall back to raw JSON              |
| `mapper`           | Pure state machine: SDK messages → `ProviderEvent`s and callback answers                |
| `mapper/subagents` | Subagent rows and their child threads                                                   |
| `mapper/notices`   | Todo lists, API retries, usage limits, failure classes                                  |
| `attachments`      | Image blocks and attachment paths in a user message                                     |
| `session`          | `Session`: lazy query, SDK calls, a driver and an idle watcher per query                |

The SDK yields the CLI's own stream messages, so the mapper is unchanged from the CLI days:
SDK callbacks (`canUseTool`, `onElicitation`, `onUserDialog`) become the control requests it
reads, and its replies become the callback results (`session::callback_request`,
`callback_answer`). The eight replays still pass.

## Launch policy

Everything below is what `makeClaudeQueryOptions`, `createClaudeAdapterV2` and the query runner
pass; the SDK turns it into argv, environment and `initialize`. `tools/conformance` proves the
result equal, byte for byte.

- **Helper:** `ClaudeConfig.helper`; the server sets it from `--sdk-host`, else
  `$CONN_SDK_HOST`, else `conn-sdk-host` beside the binary, else this checkout's
  `helpers/sdk-host/index.mjs` under `node`. A missing helper is a provider error in the turn.
- **Executable:** `ClaudeConfig.binary` as `pathToClaudeCodeExecutable` (default `claude`).
  The helper spawns it like T3: `/bin/sh` watchdog with argv0 `t3-claude`, its own process
  group, an fd 3 pipe whose EOF stops the group, an fd 4 launch gate, the shell entering the
  cwd itself (`cd -P`), and the descendant tracker.
- **Options:** model, effort and settings from the catalog; `title`; tools preset;
  `permissionMode` (+ `allowDangerouslySkipPermissions` for bypass); `includePartialMessages`;
  `promptSuggestions: false`; `sessionId` or `resume` (+ `resumeSessionAt`); `allowedTools`
  with `mcp__t3-code__*` when the session has `t3-code`; adaptive thinking with summaries;
  `settings`; `supportedDialogKinds: ["resume_return"]`; `env`; the `claude_code` system prompt
  preset with T3's append text (runtime info, pull request linking, and with `t3-code` the
  orchestration and background-wait text); `extraArgs {"thinking-display": "summarized"}`;
  `additionalDirectories` (cwd, attachments); `cwd`.
- **Environment:** the host environment, `CLAUDE_CODE_ENTRYPOINT=t3-code` (or the user's or
  managed settings' `env.CLAUDE_CODE_ENTRYPOINT`), the parent Claude session's variables and
  `ELECTRON_RUN_AS_NODE` removed, the instance's own env, `CLAUDE_CONFIG_DIR` for `homePath`,
  `MCP_CONNECTION_NONBLOCKING=0` on resume, `T3CODE_THREAD_ID`. The SDK adds its own.
- **Bypass downgrade:** when bypass is asked, the SDK's `resolveSettings` plus the home's and
  remote settings decide; settings that forbid bypass give `auto` (or `default`), as T3.
- **MCP servers:** `setMcpServers` after `initializationResult`, as the query runner does.
- **Runtime policy:** `permissionModeForClaudeRuntimePolicy` and
  `claudeRuntimeQueryPolicyForRuntimePolicy` over the runtime mode, interaction mode,
  `approvalPolicy` and `sandboxPolicy` kind: a read-only sandbox gives the tools
  `["Read","Glob","Grep"]` (also as `allowedTools` with `access: fullAccess`) and the read-only
  `t3-code` tools; `approvalPolicy: never` gives `dontAsk` or bypass; plan mode with approvals
  off denies every tool that would ask. The T3 server sets the two policies only through
  `RuntimePolicy.layerWithOverride` (its replay harness); its engine never does, and neither
  does ours.
- **Live changes:** at a turn start, model by `setModel` (only when the CLI opened in the
  policy's mode) then `applyFlagSettings`; permission mode by `setPermissionMode`; anything
  else a new query. A selection sent to a running turn (`applyModelSelection`) applies effort
  and settings live, and never a new model: that waits for the next turn, as T3. A steer's
  selection applies live when T3's `liveSteerSelection` would, and only then sets the steer's
  prompt effort.
- **Fork:** the SDK's `forkSession` at fork time; the fork's first turn resumes it.
- **Prompts:** trimmed, `Ultrathink:` for the ultrathink effort, as T3.

## Idle children

T3's session manager releases an idle provider session after 30 minutes
(`DEFAULT_IDLE_TIMEOUT_MS`), unless background work holds it (up to 4 hours,
`DEFAULT_MAX_IDLE_PIN_MS`); the next turn resumes. Here the session keeps its state and only
the query ends (and the helper, when it was the last): `ClaudeConfig.idle_timeout` (default 30 minutes) and
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
no default); see its README.

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
  after a restart (`getSubagentMessages` is offered by the helper but not used), `stopSubagent`
  and `stop_task` / `background_tasks` not sent.
- **Background roster:** T3 keeps a roster of background tasks per native thread (Bash
  `run_in_background`, Monitor, background subagents) on `providerThread.pendingBackgroundTasks`,
  emits `background_work.updated`, and serves `stopTask` (workflow tasks) and
  `awaitBackgroundTasks`. This provider reports an empty roster, sends no
  `background_work.updated`, and leaves both session methods unsupported. The engine still lists
  running background rows from the turn items.
- **Task list:** starts from the task tools it sees; TS first reads the list Claude saved on
  disk.
- **Attachments:** PDFs stay path-only. No skill splitting of slash commands. The 28 MiB
  inline budget lives in memory and starts over after a restart.
- **Not passed:** `launchArgs` and their `--settings`/append-file text, `autoCompactWindow`,
  `ENABLE_TOOL_SEARCH`, the delegated child's prompt cache TTL, prompt suggestions, the
  device-tool text and hook (no device tools), custom models.
- **Process:** no Linux `systemd-run` agent scope (T3's `AgentScope`; macOS and containers
  without systemd have none either). T3 records each CLI before it opens the fd 4 gate, so a
  restarted server can reap survivors (`ProviderProcesses`); the helper opens the gate at once
  and nothing reaps after a restart.
- **Wakes:** T3 tells a Claude Monitor event from finished work (`monitorEvent`) and shows a
  subagent that Claude resumes by itself as running again. Not followed here.
- **Interrupt** returns when the CLI acknowledges; TS waits for the terminal.
- **Elicitation:** only field-less forms; TS fills simple forms.
- **No `/mcp` instructions text** in this crate: the server passes it as `mcp_instructions`.

## History operations

| Operation          | Here                                                                                                                                   |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| rollback to a turn | `nativeConversationHeadRef` = the turn's assistant uuid; the next query passes `resumeSessionAt`; cleared after a turn runs past it  |
| rollback to start  | a new native session id; the old transcript stays on disk (as TS)                                                                      |
| fork               | the SDK's `forkSession` (up to the fork turn); the new thread resumes the copy                                                         |
| thread snapshot    | unsupported, as in TS                                                                                                                  |
| history injection  | unsupported, as in TS                                                                                                                  |

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

These child-tree figures are from the CLI-only provider before the SDK helper; the CLI's own
memory does not depend on who starts it. The helper adds one process for all sessions while
any query is open: 43 to 44 MB footprint (88 MiB RSS), flat over 10 turns, and none once the
last query closed (`helpers/sdk-host/README.md`). The host process stayed at 4.6 MiB RSS /
2.8 MB footprint after 10 turns through the helper.

## Tests

```sh
cargo test -p conn-provider-claude                                        # offline
cargo test -p conn-provider-claude live_ -- --ignored --test-threads=1    # real CLI, Haiku
tools/conformance/run.sh                                                  # vs the T3 server, no model
node tools/t3-replay/check.mjs                                            # T3's transcripts, expected failures listed
tools/gen-catalog/run.sh                                                  # regenerate model_catalog.json
cargo run --release -p conn-provider-claude --example helper_memory -- <claude> <cwd> 10
```

The live tests (11, about 20 Haiku turns) cover one turn, a permission round trip, interrupt,
resume in a new session, steer, idle close then resume (the helper stops), an MCP tool call,
fork, rollback, a foreground subagent running Bash, and an image. They need `npm ci` in
`helpers/sdk-host`.
