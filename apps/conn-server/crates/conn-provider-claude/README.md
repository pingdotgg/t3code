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
| `helper`           | The `claude` driver of the SDK host (`conn_provider_support::sdk_host`), with T3's key order |
| `launch`           | The `query()` option object, its environment, the runtime policy → permission mode; `ClaudeConfig::with_instance` |
| `launch_args`      | The instance's `launchArgs` as `makeClaudeQueryOptions` applies them, with an order-keeping JSON value |
| `catalog`          | `compileClaudeModelSelection` over T3's bundled catalog (`model_catalog.json`, generated), and the models with their options that clients are offered |
| `ordered`          | JSON with T3's key order for what the SDK writes to the CLI verbatim                    |
| `protocol`         | Typed SDK messages; unknown kinds and changed shapes fall back to raw JSON              |
| `mapper`           | Pure state machine: SDK messages → `ProviderEvent`s and callback answers                |
| `mapper/subagents` | Subagent rows and their child threads                                                   |
| `mapper/notices`   | Todo lists, API retries, usage limits, failure classes                                  |
| `mapper/presentation` | Tool row titles, MCP tool source and icon (`mcpToolPresentation`), web search patterns and results |
| `mapper/roster`    | The background roster: Bash and Monitor tasks on `pendingBackgroundTasks`, owed wakes, awaited tasks, the scheduled wakeup entry |
| `mapper/wakes`     | What a wake reports (`backgroundWorkNotification`), the scheduled wakeup (`trackClaudeScheduledWakeup`) |
| `text_generation`  | `Provider::generate_text`: the `claude` CLI directly, as `ClaudeTextGeneration.ts` |
| `status`           | The `ServerProvider` entry, probed as `checkClaudeProviderStatus`: `claude --version`, the version-filtered catalog, the capabilities probe in the SDK host |
| `tail`             | Live output of a foreground Bash call from the CLI's task file (`ClaudeTaskOutputTail.ts`) |
| `attachments`      | Image blocks and attachment paths in a user message                                     |
| `session`          | `Session`: lazy query, SDK calls, a driver and an idle watcher per query                |

The SDK yields the CLI's own stream messages, so the mapper is unchanged from the CLI days:
SDK callbacks (`canUseTool`, `onElicitation`, `onUserDialog`) become the control requests it
reads, and its replies become the callback results (`session::callback_request`,
`callback_answer`). The eight replays still pass.

## Instance settings

`ClaudeProvider::for_instance` builds the provider for one `providerInstances` entry, as the
T3 server's Claude driver and `createClaudeAdapterV2` build theirs; the server
(`conn-server/src/instances.rs`) builds one per instance and a new one when the entry changes.

| Field | Here |
| --- | --- |
| `binaryPath` | trimmed, `~` expanded (`expandHomePath`), `claude` when empty: `pathToClaudeCodeExecutable`, the `--version` probe, titles |
| `homePath` | trimmed, `~` expanded, made absolute: `CLAUDE_CONFIG_DIR` everywhere, over an instance variable of that name |
| `environment` | each entry with a value, `~` expanded only in `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GROK_HOME`; a sensitive value is the real one from the secret store. `Debug` prints names only |
| `launchArgs` | per query (`launch_args`): `--add-dir` values after the cwd and attachments; `--permission-mode`, then `--dangerously-skip-permissions`, over the policy's mode; `--append-system-prompt-file` text (one trailing newline trimmed) and `--append-system-prompt` text after T3's append text; `--settings` (inline JSON or a file, comments and trailing commas allowed) beneath T3's settings keys, in its own key order; every other flag to `extraArgs` in T3's order, then `thinking-display`. A missing value or an unreadable file fails the start. Probes and titles do not use them, as in T3 |
| `enabled` | T3's rule; a disabled instance gets T3's disabled entry, also with the probe off, and the engine refuses its turns |
| `displayName`, `accentColor` | on the entry, pending and probed (`withInstanceIdentity`) |
| `customModels`, `autoCompactWindow` | not read yet |

Proof: the conformance scenarios `instance_*` and the probe scenarios `instance-settings` and
`title-instance` (below); `instances-flow.mjs` in `conn-server` for a turn through the server.

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
  with `mcp__conn__*` when the session has `conn`; adaptive thinking with summaries;
  `settings`; `supportedDialogKinds: ["resume_return"]`; `env`; the `claude_code` system prompt
  preset with T3's append text (runtime info, pull request linking, and with `conn` the
  orchestration and background-wait text); `extraArgs {"thinking-display": "summarized"}`;
  `additionalDirectories` (cwd, attachments); `cwd`.
- **Environment:** the host environment, `CLAUDE_CODE_ENTRYPOINT=t3-code` (or the user's or
  managed settings' `env.CLAUDE_CODE_ENTRYPOINT`), the parent Claude session's variables and
  `ELECTRON_RUN_AS_NODE` removed, the instance's own env, `CLAUDE_CONFIG_DIR` for `homePath`,
  `MCP_CONNECTION_NONBLOCKING=0` on resume, `T3CODE_THREAD_ID`. The SDK adds its own.
- **Bypass downgrade:** when bypass is asked, the SDK's `resolveSettings` plus the home's and
  remote settings decide; settings that forbid bypass give `auto` (or `default`), as T3.
- **Interrupt:** as `interruptTurn`: the SDK's `interrupt` (at most 10 s), then `close` (the
  CLI's stdin ends; the SDK sends SIGTERM after 2 s), then up to 10 s
  (`CLAUDE_STOP_CONFIRM_TIMEOUT_MS`) for the CLI to exit. Then the turn is `interrupted` and
  the call returns; else `InterruptTimeout`, the turn stays open and the engine offers Force
  stop. A turn start waits for a running interrupt, as T3's effect outbox holds a thread's
  next effect, so the next turn resumes in a new CLI (`--resume`) after the old one exited.
- **MCP servers:** taken at open (`OpenSessionInput::mcp_servers`) and registered with
  `setMcpServers` after `initializationResult`, as the query runner does;
  `Session::set_mcp_servers` changes them on a live query.
- **Runtime policy:** `permissionModeForClaudeRuntimePolicy` and
  `claudeRuntimeQueryPolicyForRuntimePolicy` over the runtime mode, interaction mode,
  `approvalPolicy` and `sandboxPolicy` kind: a read-only sandbox gives the tools
  `["Read","Glob","Grep"]` (also as `allowedTools` with `access: fullAccess`) and the read-only
  `conn` tools; `approvalPolicy: never` gives `dontAsk` or bypass; plan mode with approvals
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

## Background work and wakes

As `ClaudeAdapterV2.ts`, with each rule's T3 name:

- **Roster** (`pendingBackgroundTasksByNativeThread`): background Bash and Monitor tasks; every
  `background_tasks_changed` sends the thread. A task that ended while it can still wake
  Claude stays listed until its continuation runs (`owedWakeTasksForNativeThread`,
  wake-eligible ids and replay tombstones). `awaitBackgroundTasks` marks tasks `awaited`. A
  `ScheduleWakeup` result lists T3's `claude-scheduled-wakeup` entry until the wakeup fires,
  is cancelled, a Stop ends the turn or the process ends; it counts as background work.
- **Wake reports** (`recordWakeReport`): a task notification during a user turn (a known
  background task or a backgrounded subagent) or while idle records what the next wake names.
  Reports live through one user turn. The continuation request carries T3's notice
  (`backgroundWorkNotification`: `Subagent "X" finished`, `Command "Y" and monitor "Z"
  failed`, …) and the last notification's summary as its text. A root subagent's end asks for
  the continuation at once; a Monitor event with nothing finished is "Monitor reported new
  output". Nested subagents (`spawn_depth` > 1) wake nothing.
- **Prompt echo gate** (`promptEchoMode`): after a prompt is written, root frames before its
  echo wait; when they end in a result for another turn (`isClaudeResultForOtherTurn`) they were
  a wake Claude ran first, and become a continuation.
- **Subagents across turns**: settled subagents stay known (up to 64), so a `SendMessage`
  resume reopens the row in the resuming turn and adds the sent message to the child thread.
- **Stop with no turn running** (`interruptTurn` with `requestRuntimeRestart`):
  `Session::stop_background_work` closes the thread's idle query and clears the roster and
  wake state; the next turn resumes in a new CLI.
- **Usage ledger** (`resultLedgerUsage`): measured when a result arrives, before it waits for a
  wake or an echo. `/compact` results report `localCommand`.

All state above is bounded (64 entries per list; `the_background_roster_stays_bounded`).

## Status entry

`ClaudeProvider::refresh_status` builds the entry as `checkClaudeProviderStatus`: `claude
--version` (20 s; missing, failing and hanging CLIs give T3's messages), T3's catalog filtered
by that version (`resolveClaudeModelsForVersion`, `updateRequiredModels`, the upgrade
message), then `probeClaudeCapabilities` in the SDK host (`probeCapabilities`, 25 s): the
official SDK starts the CLI with a prompt that never yields, so no request reaches the API.
The host returns the account status the SDK reports (email, subscription, token and key
source, API provider; never a token), slash commands, models, usage windows and effort caps.
Before the first probe the entry is T3's pending one. `CONN_CLAUDE_STATUS_PROBE=off` turns the
probe off; every check that starts the server sets it, so no check runs this machine's
`claude`. Not ported: reset credits (Anthropic's API), the organization id (Claude's account
file), the version advisory (a registry lookup), skills, custom models, applying effort caps.
Proof: `tools/probe-conformance/run.mjs`, 11 status scenarios against T3's own function (and
5 title scenarios against T3's `generateThreadTitle`); `instance-settings` and
`title-instance` run an instance with a `~` binary path, a sensitive variable and
`CLAUDE_CONFIG_DIR` with `~`, T3's side decoding the entry with its own
`ProviderInstanceConfig`. It runs T3's side with the sealed
environment (`tools/sealed-env.mjs`, `sealedNodeEnv`): a throwaway HOME and no `ANTHROPIC_*`,
`CLAUDE_*` or other variable of the shell.

The SDK host starts for a probe and stops right after it (under 1 s with a stub CLI, 89 MiB
RSS at its peak). The server probes at start, on a settings change, on `server.refreshProviders`,
and every 5 minutes only while a client in the foreground holds a `provider-status`
activity lease, as T3's `BackgroundPolicy`: an idle server starts no CLI and no host.

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
| `assistant` `tool_use`                            | `node` + `turn_item` (`command_execution`, `file_change`, `web_search`, `dynamic_tool`) running, with T3's title; MCP tools get `toolSource`/`toolIcon` from `tool_use_meta`; web search rows get `patterns` and `results` |
| `assistant` `tool_use` TodoWrite                  | also `node` + `plan.updated` + `turn_item` (`todo_list`); the previous list is superseded                              |
| `user` `tool_result`                              | the tool row completed / failed / cancelled / interrupted, with output                                                 |
| `system` `task_started` `local_bash` (foreground) | the CLI's task file is tailed every 250 ms: `command_output.delta`; the call's result reads it once more first          |
| `task_started` `local_bash` (background), `task_notification`, `background_tasks_changed` | the roster on `providerThread.pendingBackgroundTasks` (`provider_thread.updated`); a Monitor call's task is `monitor` |
| `tool_result` of TaskCreate/TaskUpdate/TaskList   | also a `todo_list` for the session's task list                                                                         |
| `assistant` `tool_use` Agent                      | nothing; remembers the launch's model, effort and owner                                                                |
| `system` `task_started`                           | `app_thread.created` (child thread), `node` (subagent, child root), `subagent.updated`, prompt message, `subagent` row |
| `system` `task_progress` / `task_notification`    | `subagent.updated` and row with progress / result; child result message                                                |
| frames with `parent_tool_use_id`                  | child-thread messages, reasoning and tool rows; held (capped) until `task_started`                                     |
| Agent `tool_result`                               | settles a foreground subagent; a background launch ack is ignored                                                      |
| root frames with no turn running                  | held (capped) and `continuation.requested`; the continuation turn (`creationSource: provider`) replays them                                     |
| steer written (`priority: "now"`)                 | `steer.updated` pending; completed on `command_lifecycle` started or an echo; the `aborted_*` result folds in          |
| `can_use_tool`                                    | approval: `node` + `runtime_request` + `turn_item` (`approval_request`)                                                |
| `can_use_tool` AskUserQuestion / ExitPlanMode     | `user_input_request` / `plan.updated` (proposed plan)                                                                  |
| `elicitation`, `request_user_dialog`              | field-less form as an approval card; `resume_return` as a question                                                     |
| `control_cancel_request`                          | request, node and item `cancelled`                                                                                     |
| `system` `status` compacting / `compact_boundary` | `compaction` row running, then completed with token counts and a usage update                                          |
| `system` `api_retry`                              | `error` row with `retry` (running, then recovered); on failure the retry goes on `turn.terminal`                       |
| `rate_limit_event` rejected                       | `system_notice` with the window and the wait; the turn's failure becomes `usage_limit` with `resetAt`                  |
| `system` `informational`                          | `system_notice` row                                                                                                    |
| `result`                                          | open rows closed, pending requests cancelled, `provider_turn.updated` (usage with `otherUsage` from the process's `modelUsage` ledger), `provider_thread.updated`, `turn.terminal` |
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
`tools/capture-ts` regenerates `testdata/ts` from the Conn monorepo this crate sits in; see
its README.

Normalized in the comparison:

- Runtime request ids end in a random uuid.
- `threadId: null` appears where TS leaves the key out.
- TS-only fields: `nativeMetadata` (attachment budget), `goal`, `pendingBackgroundWork`,
  `pendingBackgroundTasks`, `failureItemOrdinal`. (`otherUsage` is compared since 2026-11-14.)
- TS repeats an unchanged `provider_turn.updated` or `provider_thread.updated`.
- `continuation.requested` is ours; TS uses a separate service.

## Known differences from `ClaudeAdapterV2`

- **Continuation timing:** TS asks for the continuation turn when the background task's
  notification arrives; this provider asks when Claude starts writing. The events match.
- **Cold start:** with no live query the provider turn shows as running before the SDK host
  answers `resolveSettings` (T3 resolves it in-process and emits the turn right after
  `query()`). What the CLI gets is unchanged. A start that then fails ends the turn as failed
  (`claude_start_failed`), where T3 emits no provider turn. A steer waits for the start.
- **Stop during the start** (`abandon_turn_start`, 2026-11-14): attachments are read before the
  query opens, as T3. A Stop while they are read or while `resolveSettings` waits for the SDK
  host opens nothing. A Stop while the CLI boots or registers MCP servers aborts the query
  (host command `abort`: T3's teardown of an interrupted `openQuery`, prompt stream ended,
  SIGKILL, up to 10 s for the exit, dispose); the early turn ends `interrupted`. A Stop once
  the query is open lets the prompt go and the engine interrupts the turn, as T3 does for a
  turn that starts after Stop. Proven by `an_abandoned_start_aborts_the_booting_query` and
  the conformance scenarios `stop_during_boot` and `stop_during_mcp_registration`.
- **Workflows:** progress and Stop are served, with at most 256 phases and members per
  workflow. Member transcript files and their effort/speed metadata are not read yet;
  member threads show partial progress excerpts.
- **Subagents:** no recovery of running subagents after a restart (`getSubagentMessages` is
  offered by the helper but not used); `stopSubagent` and `background_tasks` are not sent.
- **Background work:** not built: the re-emit when a new process clears a roster; the stale-latch
  rules of `retireOfferedWake` (a continuation that never starts); held frames for tool calls
  that a held root frame owns.
- **Live command output:** a relative `CLAUDE_CODE_TMPDIR` resolves against the cwd as given;
  T3 uses the real path. Only the first 8 tailed calls of a turn are tailed.
- **Task list:** starts from the task tools it sees; TS first reads the list Claude saved on
  disk.
- **Tool titles:** T3's own `/mcp` tools (`conn` and its aliases) get no presentation, as
  T3; T3 decides by its tool table, this provider by the server name. `normalizeMcpHttpUrl`
  keeps an icon URL as sent, where T3 normalizes it with `new URL`.
- **Attachments:** PDFs stay path-only. No skill splitting of slash commands. The 28 MiB
  inline budget lives in memory and starts over after a restart.
- **Not passed:** `autoCompactWindow`, `customModels`,
  `ENABLE_TOOL_SEARCH`, the delegated child's prompt cache TTL, prompt suggestions, the
  device-tool text and hook (no device tools), custom models.
- **Process:** no Linux `systemd-run` agent scope (T3's `AgentScope`; macOS and containers
  without systemd have none either). T3 records each CLI before it opens the fd 4 gate, so a
  restarted server can reap survivors (`ProviderProcesses`); the helper opens the gate at once
  and nothing reaps after a restart.
- **Wakes:** a Monitor event is told from finished work by "a Monitor runs and nothing
  finished" (T3 also checks the wake's result origin and the scheduled wakeup); a subagent
  that Claude resumes by itself is not shown as running again.
- **Stop without a running turn:** the engine reaches the provider, but writes none of T3's
  interrupt request and result items for the settled run.
- **Titles:** none known. `Provider::generate_text` runs the CLI directly, as
  `ClaudeTextGeneration.ts` does (`text_generation.rs`): `claude -p --output-format json
  --json-schema … --tools "" --permission-mode dontAsk`, the prompt on stdin, a fresh temp
  folder, 180 s, a retry without `--no-session-persistence` for CLIs before 2.0.63. No SDK host.
  Proven by the four `title*` scenarios of `tools/probe-conformance`.
- **Stop hook and goals:** every query gets T3's `Stop` hook (`onStop`), so `initialize` is
  equal. T3's hook answers `{continue: false}` while a Claude `/goal` is active and a
  delegated task will wake the thread; this provider tracks no Claude goals (`active_goal` is
  ignored), so its hook always answers `{}`, T3's answer without an active goal.
- **Native session title:** as T3, a turn sends `rename_session` (`source: "host"`) when the
  thread title differs from the one last applied to the native session; a new session applies
  its title at spawn, and the applied titles live per provider instance, across sessions.
  T3 also records the applied title in `nativeMetadata.title`, so it survives a restart; this
  provider reads a recorded title but writes none, so after a restart it renames once more.
  A native `/rename` does not retitle the thread here (T3 #36879).
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

The roster, the live-output tails and the `modelUsage` ledger (2026-11-14) are bounded (64
tasks, 64 links, 8 tails per turn, 16 ledger models; `the_background_roster_stays_bounded`).
The T3 transcript replay (18 scenarios through `ClaudeSession`, release build) peaked at
4.11–4.16 MiB footprint on `main` and 3.94–4.28 MiB with them (3 runs each; max RSS 55.4 and
55.1 MiB).

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
node tools/probe-conformance/run.mjs                                      # the status entry vs T3's, stub CLIs
node tools/t3-replay/check.mjs                                            # T3's transcripts, expected failures listed
tools/gen-catalog/run.sh                                                  # regenerate model_catalog.json
cargo run --release -p conn-provider-claude --example helper_memory -- <claude> <cwd> 10
```

The live tests (11, about 20 Haiku turns) cover one turn, a permission round trip, interrupt,
resume in a new session, steer, idle close then resume (the helper stops), an MCP tool call,
fork, rollback, a foreground subagent running Bash, and an image. They need `npm ci` in
`helpers/sdk-host`.
