# How the TS server talks to `codex app-server`

Read from `CodexAdapterV2.ts`, `provider/CodexProvider.ts`, `provider/codexLaunchArgs.ts`,
`provider/Drivers/CodexHomeLayout.ts` and the recordings in
`apps/server/src/orchestration-v2/testkit/fixtures/*/codex_transcript.ndjson` (CLI 0.156.1).
Method names were checked against the schema that the installed CLI (0.167.0) prints with
`codex app-server generate-json-schema --out <dir>`. Every method below is in it.

## Transport

JSON-RPC 2.0 without the `"jsonrpc"` member, one JSON object per line on stdin and stdout.
stderr is logging only.

| Frame               | Shape                                                                          |
| ------------------- | ------------------------------------------------------------------------------ |
| client request      | `{"id": n, "method": m, "params": p}`                                          |
| client notification | `{"method": m}` (only `initialized`)                                           |
| response to client  | `{"id": n, "result": r}` or `{"id": n, "error": {"code", "message", "data"?}}` |
| server notification | `{"method": m, "params": p}`                                                   |
| server request      | `{"id": n, "method": m, "params": p}`; the server numbers its own ids from 0   |
| client reply        | `{"id": n, "result": r}`                                                       |

Both sides can use the same id numbers. A frame with `method` and `id` is a server request; one
with `id` and no `method` is a response.

## Launch

- **Executable:** `CodexSettings.binaryPath`, default `codex` on PATH, `~` expanded.
- **argv:** `app-server -c thread_unload_delay_secs=0 <launch args>`. The launch args come from
  `T3CODE_CODEX_LAUNCH_ARGS` or else `CodexSettings.launchArgs`, split like a shell.
- **Environment:** the host environment, plus the instance's own entries, then:
  - `CODEX_INTERNAL_ORIGINATOR_OVERRIDE=T3 Code`, so the backend gives the same model catalog
    it gives T3 (the instance env can override it)
  - `CODEX_HOME=<homePath>` only when a home path or shadow home is set
  - nothing is removed
- **Process:** TS runs one `app-server` per provider instance, shared by every thread. The
  provider session id is `provider-session:provider-instance:codex:shared`. On Linux it wraps
  the spawn in a systemd agent scope, with a 2 s force-kill after SIGTERM.
- **Conn only:** before the first spawn, it waits up to 120 s for `*.orbit` MCP hosts in
  `config.toml` to accept TCP (`codexMcpNetworkGate.ts`). This crate does the same.
- **Stop:** stdin closed, SIGTERM to the process group, SIGKILL after 2 s. Same here.
- **Linux agent scope (not done here):** on Linux, with `XDG_RUNTIME_DIR` set and both
  `systemd-run` and `systemctl` on PATH, and a probe `systemd-run --user --scope --quiet
  --collect --slice=app-t3code-agents.slice --property=TimeoutStopSec=10s
  --property=Delegate=yes [--property=OOMPolicy=stop] -- true` succeeding, TS starts the
  app-server as `/bin/sh -c '<raise oom_score_adj to 800>; : "${XDG_RUNTIME_DIR:=$1}"; export
  XDG_RUNTIME_DIR; shift; exec "$@"' t3-agent <runtime dir> <systemd-run> --user --scope
  --quiet --slice=app-t3code-agents-<sha256(stateDir)[:12]>.slice
  --unit=t3code-codex-<8 hex>.scope --property=TimeoutStopSec=10s --property=Delegate=yes
  --property=OOMPolicy=continue -- <codex> app-server ...` (shared process: OOMPolicy
  `continue`, no `--collect`). Before the first scope it stops a populated leftover slice,
  and sets `MemoryHigh`/`MemoryMax` on `app-t3code-agents.slice` and `CPUWeight=10
  IOWeight=10 TasksMax=25%` on `app-t3code.slice`. Without systemd it still wraps the
  command in `/bin/sh -c '<oom score>; exec "$@"' t3-agent <codex> ...`. On macOS it does
  nothing. A Linux step must port `apps/server/src/process/agentScope.ts` and run the
  conformance check on Linux (the stub records the wrapped argv).

In a container, Codex reaches models through whatever the inherited environment and
`config.toml` configure. No sign-in call is made.

## Handshake

1. `initialize` with
   `{"clientInfo": {"name": "T3 Code", "title": "T3 Code", "version": <server version>},
   "capabilities": {"experimentalApi": true, "optOutNotificationMethods":
   ["turn/diff/updated"], "extensions": {"io.modelcontextprotocol/ui": {"mimeTypes":
   ["text/html;profile=mcp-app"]}}}}`. The result carries `userAgent`
   (`t3code_desktop/<version> ...`), `codexHome`, `platformFamily` and `platformOs`.
   `-32600 "Already initialized"` counts as success.
2. The `initialized` notification.

Done once per process, before the first thread call. Nothing else goes to the session's
process before a thread call (the TS server lists models in a separate probe process).

## The status probe's process

A process of its own per probe, as T3's `probeCodexAppServerProvider` (`README.md`, "Status
probe"): the same argv, the session's environment plus `MISE_OFFLINE=1`, in the server's
folder. `initialize` carries `capabilities: {experimentalApi: true}` only (no
`optOutNotificationMethods`, no `extensions`). Then `initialized`, `account/read` `{}`,
`skills/list` `{cwds}`, `model/list` `{}` / `{cursor}`, `config/read` `{includeLayers: false}`,
`account/rateLimits/read` with `params: null`. Results read:

| Request | Fields read |
| --- | --- |
| `initialize` | `userAgent` (the version after the first `/`), `codexHome` (where `models_cache.json` is) |
| `account/read` | `account` (`type`: `apiKey`, `chatgpt` with `email` and `planType`, `amazonBedrock`; or null), `requiresOpenaiAuth` |
| `skills/list` | `data[]` `{cwd, skills[] {name, path, enabled, description, scope, shortDescription, interface {displayName, shortDescription}}}` |
| `model/list` | `data[]` `{model, displayName, isDefault, defaultReasoningEffort, supportedReasoningEfforts[].reasoningEffort, serviceTiers[] {id, name, description}, additionalSpeedTiers, defaultServiceTier, availableAccessPrograms.cyber}`, `nextCursor` |
| `config/read` | `config` `{model_provider, openai_base_url, model_providers{}.base_url, service_tier, daybreak, features.api_key_cyber_access_programs}` |
| `account/rateLimits/read` | `rateLimits` / `rateLimitsByLimitId.codex` `{limitId, planType, primary, secondary {usedPercent, resetsAt, windowDurationMins}, individualLimit}`, `rateLimitResetCredits`, `accountId` |

The process ends with the probe: stdin closed, SIGTERM to the group, SIGKILL after 2 s.

## Threads

- **Start:** `thread/start` `{"cwd", "model", "config": {...}}`. `config` holds:
  - `tools.update_plan.enabled: true`
  - `mcp_optional_startup_grace_ms: 10000`
  - `features.concurrent_reasoning_summaries: true`
  - `shell_environment_policy.set.T3CODE_THREAD_ID: <app thread id>`
  - with T3 MCP: `mcp_servers.t3-code` and `mcp_servers.t3-code-direct` (URL, bearer header,
    65-minute tool timeout)

  The result is `{"thread": {"id", "createdAt", "updatedAt", ...}, "model", ...}`. The native
  thread id goes into `ProviderThread.nativeThreadRef`.

- **Resume:** `thread/resume` `{"threadId", "excludeTurns": true, "cwd", "model", "config"}`.
  A "session … is archived" error leads to `thread/unarchive` and a retry. An "active writer"
  error (`-32600`) means another client holds the thread.
- **Unload:** `thread/unsubscribe` (Codex sends `thread/closed` later), or `thread/archive`.

## Turns

- **Start:** `config/read` `{"cwd", "includeLayers": false}` first, to pass the user's
  `model_reasoning_summary`. Then `turn/start` with:
  - `threadId`, `cwd`, `model`
  - `input`: `[{"type": "text", "text"}]`, plus image attachments as `localImage` items
  - `summary`: the configured value, or `auto`
  - `approvalPolicy`, `approvalsReviewer`, `sandboxPolicy`, from the runtime mode (table below)
  - `effort` and `serviceTier`, when the model selection sets them
  - `collaborationMode: {"mode": <interaction mode>, "settings": {"model",
    "reasoning_effort"?}}`
  - `additionalContext`: with T3 MCP, T3's entries; MCP app context as `{"kind": "untrusted"}`
  - `input: []` for a restart continuation (`restartContinuationOfRunId`): Codex resumes

  The result is `{"turn": {"id", "status": "inProgress", "startedAt": null | secs, ...}}`. A
  `turn/started` notification can come before the result.

- **Steer:** `turn/steer` `{"expectedTurnId", "input", "threadId"}` → `{"turnId"}`.
- **Interrupt:** `turn/interrupt` `{"threadId", "turnId"}` → `{}`. Also sent, once, for a turn
  whose start a Stop abandoned after `turn/start` was written, when its answer or a
  `turn/started` names it (not in T3; README, "A Stop that abandons a start"). Codex then sends
  `turn/completed` with status `interrupted`. TS waits up to 10 s for it; without it the turn
  stays open and Stop fails with `ProviderAdapterInterruptTimeoutError` (Force stop), as here. Running background terminals are stopped with
  `thread/backgroundTerminals/terminate` `{"threadId", "processId"}`.
- **Model change:** none in session. Each `turn/start` carries the model and effort.
- **Runtime mode change:** none in session. Each `turn/start` carries the policies.

| Runtime mode        | `approvalPolicy` | `approvalsReviewer` | `sandboxPolicy`                |
| ------------------- | ---------------- | ------------------- | ------------------------------ |
| `approval-required` | `untrusted`      | `user`              | `{"type": "readOnly"}`         |
| `auto-accept-edits` | `on-request`     | `user`              | `{"type": "workspaceWrite"}`   |
| `auto`              | `on-request`     | `auto_review`       | `{"type": "workspaceWrite"}`   |
| `full-access`       | `never`          | `user`              | `{"type": "dangerFullAccess"}` |

## Server requests (approvals and questions)

Each one becomes a `node.updated` (`approval_request` or `user_input_request`, `waiting`), a
`turn_item.updated` and a `runtime_request.updated` (`pending`, live response capability). The
reply waits for the user. TS emits no event of its own when the user answers; the engine
marks the request resolved.

| Request                                 | Request kind                                 | Reply                                                                            |
| --------------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------- |
| `item/commandExecution/requestApproval` | `command`; prompt `reason ?? command`        | `{"decision": "accept" \| "acceptForSession" \| "decline" \| "cancel"}`          |
| `item/fileChange/requestApproval`       | `file-change`; prompt from reason or changes | same                                                                             |
| `item/permissions/requestApproval`      | `file-change`, `file-read` or `command`      | `{"permissions": <granted or {}>, "scope": "turn" \| "session"}`                 |
| `item/tool/requestUserInput`            | `user_input` with questions                  | `{"answers": {"<question id>": {"answers": ["…"]}}}`                             |
| `mcpServer/elicitation/request`         | `mcp-elicitation` with `appName`, `options`  | the form's option: `{"action": "accept", "_meta"?: {"persist"}, "content"?}`, or `decline` / `cancel`; a URL or an unfillable form is declined at once |
| `execCommandApproval` (legacy)          | `command`                                    | `{"decision": "approved" \| "approved_for_session" \| {"denied": …} \| "abort"}` |
| `applyPatchApproval` (legacy)           | `file-change`                                | same                                                                             |

`acceptForSession` (and `acceptAlways`) is remembered per native thread and kind: the next
request of that kind is answered at once. The allowance resets when the runtime mode changes.
`serverRequest/resolved` follows each reply.

## Notifications → `ProviderEvent`

Ordinals: `providerTurnOrdinal * 100 + n`, where `n` counts the turn's items in first-seen
order. Assistant text and reasoning are buffered and flushed every 50 ms; plan text every
400 ms. A flush emits the row with `streaming: true`; item completion emits it completed.

| Notification                                                  | Events                                                                                                               |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `turn/start` result or `turn/started`                         | `provider_turn.updated` running                                                                                      |
| `item/started` `agentMessage`                                 | remembers the phase and reserves the ordinal                                                                         |
| `item/agentMessage/delta`                                     | buffered text; a flush gives `node` + `turn_item` (`assistant_message`, streaming)                                   |
| `item/completed` `agentMessage`                               | `node` + `message` + `turn_item`, completed; a repeated final answer is dropped                                      |
| `item/reasoning/summaryTextDelta`, `textDelta`                | buffered per part; `node` (`reasoning`) + `turn_item` (`reasoning`)                                                  |
| `item/completed` `reasoning`                                  | each part completed, using the item's summary and content as final text                                              |
| `item/started` / `completed` `commandExecution`               | `node` (`tool_call`) + `turn_item` (`command_execution`, input, output, exit code)                                   |
| `item/commandExecution/outputDelta`                           | `command_output.delta`                                                                                               |
| `item/completed` `fileChange`                                 | `node` + `turn_item` (`file_change`, first path, diff, changes)                                                      |
| `item/started` / `completed` `webSearch`                      | `node` + `turn_item` (`web_search`, patterns)                                                                        |
| `item/started` / `completed` `mcpToolCall`, `dynamicToolCall` | `node` + `turn_item` (`dynamic_tool`)                                                                                |
| `item/plan/delta`, `item/completed` `plan`                    | `node` (`plan`) + `plan.updated` (`proposed_plan`) + `turn_item` (`proposed_plan`)                                   |
| `turn/plan/updated`                                           | `node` (`todo_list`) + `plan.updated` (`todo_list`) + `turn_item` (`todo_list`)                                      |
| `item/started` / `completed` `contextCompaction`              | `turn_item` (`compaction`)                                                                                           |
| `thread/tokenUsage/updated`                                   | `provider_turn.updated` running with `tokenUsage` from `last`; `total` feeds the turn usage                          |
| `thread/settings/updated`, `model/rerouted`                   | the model reported on the completed turn                                                                             |
| `error` (`willRetry: false`)                                  | the failure the terminal reports                                                                                     |
| `error` (`willRetry: true`)                                   | a `provider_retry` turn item, completed when output resumes                                                          |
| `mcpServer/startupStatus/updated` `failed`                    | a `system_notice` turn item                                                                                          |
| `turn/completed`                                              | buffers flushed, open command rows ended, `provider_turn.updated` (status, `turnTokenUsage`, model), `turn.terminal` |

`turn.terminal` status follows `turn.status`: `completed`, `interrupted` or `failed`. A
`completed` turn that the user stopped counts as `interrupted`. A failed turn's failure comes
from the last `error` notification or `turn.error`. `threadDisposition` is `reusable`.

Ignored: `thread/started`, `thread/status/changed`, `account/updated`,
`remoteControl/status/changed`, `configWarning`, `warning`, `deprecationNotice`,
`serverRequest/resolved`, `item/reasoning/summaryPartAdded`, `hook/*`, and the realtime,
fuzzy-search and fs families.

## Subagents

Child threads report on their own `threadId`; T3 maps them in `CodexAdapterV2`
(`registerSubagentThread`, `emitSubagentProviderTurnStarted`, `updateSubagentStates`).

| Frame | Effect |
| --- | --- |
| `item/completed` `collabAgentToolCall` `spawnAgent` | each `receiverThreadIds` entry becomes a child: `app_thread.created`, `node.updated` (`subagent`, and the child's `root_turn`), `provider_thread.updated`, the prompt as the child's first message, `subagent.updated` + `turn_item.updated` (`subagent`) |
| `item/started` `subAgentActivity` `started` (v2) | the same child, titled by `agentPath`, without a prompt |
| `collabAgentToolCall` `wait` / `sendInput` / `resumeAgent`, completed | `agentsStates` statuses (`pendingInit` pending, `errored`/`notFound` failed, `shutdown` cancelled) and messages update each task |
| `subAgentActivity` `completed` / `interrupted` | the task's status |
| `turn/started` on a child thread | the child's provider turn and root node (the second and later turns reopen the task); `turn/completed` ends them, sets the child's provider thread back to `idle`, ends the `subagent` node and the task |
| a server request on a child turn | an approval shows on the root turn under the subagent's node; a question on the child |

A direct child whose turn completes or fails after its root turn ended wakes the parent: the
next turn's text is `Subagent <status>: <label>` with its result (README, "Wakes"). A
background command that ends after its completed turn does the same with `Background command
completed (exit N): <command>` and its output tail.

Requests T3 sends for subagents: `thread/read` `{threadId, includeTurns: false}`, then
`thread/resume` `{threadId, excludeTurns: true}` when the read names no model (a child with
no model yet); `turn/interrupt` to each running child turn when the root turn is stopped,
and to a child turn that starts under a stopped turn.

## Text generation (`codex exec`)

Thread titles with Codex as the title model do not use the app-server: see the README,
"Text generation". `codex mcp list --json` prints `[{name, enabled}]`; `codex exec` reads
the prompt on stdin and writes the last message, a JSON object, to `--output-last-message`.

## Exit and errors

- The process exits: the event stream fails, so every open turn ends.
- A request error is `{"code", "message"}`. TS checks these codes:
  - `-32600 "Already initialized"`: success
  - `-32600` "already has an active writer": thread in use (`ProviderError::ThreadInUse` with
    T3's `CODEX_THREAD_IN_USE_MESSAGE`; `tools/check-copies.mjs` holds the text)
  - `-32601`: unknown method; `thread/inject_items` falls back
  - `-32600 "thread not found:"` on terminate: nothing is left to stop
- A usage limit: the `error` notification or `turn.error` carries `codexErrorInfo` (HTTP
  429 or `usageLimitExceeded`). The failure class is `usage_limit`, and `resetAt` comes from
  `account/rateLimits/*`.

## Not used by T3 here

`review/start`, `command/exec`, the `fs/*`, `plugin/*` and `skills/*` families, and the
realtime methods. Rollback (`thread/read`, `thread/turns/list`, `thread/revert`) and fork (`thread/fork`)
are done here as TS does them. Goals (`thread/goal/*`), compaction (`thread/compact/start`), `thread/inject_items`,
`thread/sample`, `feedback/upload` and the MCP-app calls are used by TS; this crate leaves them
out (see the README).
