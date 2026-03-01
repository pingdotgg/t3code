# EVENTS.md

## Goal

Define a **breaking** canonical provider-runtime event model that can represent the full useful surface of:

- Claude Agent SDK types (`@anthropic-ai/claude-agent-sdk@0.2.62`)
- Codex App Server protocol (`schema/json/*`, including `ServerNotification`, `ServerRequest`, `EventMsg`, and v2 payload schemas)
- Codex TypeScript SDK thread events/items (`sdk/typescript/src/events.ts`, `items.ts`)
- Cursor ACP protocol (`agent acp` JSON-RPC 2.0 over stdio)

This is a mapping/spec document only (no downstream compatibility constraints).

---

## 1) Proposed Canonical Runtime Event Model (V2)

### 1.1 Envelope

```ts
type RuntimeEventRaw = {
  source:
    | "codex.app-server.notification"
    | "codex.app-server.request"
    | "codex.eventmsg"
    | "claude.sdk.message"
    | "claude.sdk.permission"
    | "codex.sdk.thread-event"
    | "cursor.acp.notification"
    | "cursor.acp.request"
    | "cursor.acp.response";
  method?: string;
  messageType?: string;
  payload: unknown;
};

// Add these to `packages/contracts/src/baseSchemas.ts` for V2.
export const RuntimeItemId = makeEntityId("RuntimeItemId");
export type RuntimeItemId = typeof RuntimeItemId.Type;
export const RuntimeRequestId = makeEntityId("RuntimeRequestId");
export type RuntimeRequestId = typeof RuntimeRequestId.Type;
export const RuntimeTaskId = makeEntityId("RuntimeTaskId");
export type RuntimeTaskId = typeof RuntimeTaskId.Type;
export const RuntimeSessionId = makeEntityId("RuntimeSessionId");
export type RuntimeSessionId = typeof RuntimeSessionId.Type;

type RuntimeEventBase<TType extends CanonicalRuntimeEventType, TPayload> = {
  eventId: EventId;
  provider: ProviderKind;
  sessionId: RuntimeSessionId;
  createdAt: IsoDateTime;

  // Canonical T3 IDs (not provider-native IDs).
  threadId?: ThreadId;
  turnId?: TurnId;
  itemId?: RuntimeItemId;
  requestId?: RuntimeRequestId;

  // Provider-native IDs preserved for correlation/debugging.
  providerRefs?: {
    providerSessionId?: ProviderSessionId;
    providerThreadId?: ProviderThreadId;
    providerTurnId?: ProviderTurnId;
    providerItemId?: ProviderItemId;
    providerRequestId?: TrimmedNonEmptyString;
  };

  type: TType;
  payload: TPayload;
  raw?: RuntimeEventRaw;
};
```

### 1.2 Canonical Event Families

```ts
type CanonicalRuntimeEventType =
  // lifecycle
  | "session.started"
  | "session.configured"
  | "session.state.changed"
  | "session.exited"
  | "thread.started"
  | "thread.state.changed"
  | "thread.metadata.updated"
  | "turn.started"
  | "turn.completed"
  | "turn.aborted"
  | "turn.plan.updated"
  | "turn.diff.updated"

  // item + content stream
  | "item.started"
  | "item.updated"
  | "item.completed"
  | "content.delta"

  // approvals / input / tool-protocol requests
  | "request.opened"
  | "request.resolved"
  | "user-input.requested"
  | "user-input.resolved"

  // provider/system telemetry
  | "task.started"
  | "task.progress"
  | "task.completed"
  | "tool.progress"
  | "tool.summary"
  | "runtime.warning"
  | "runtime.error";
```

### 1.3 Canonical Item Type

```ts
type CanonicalItemType =
  | "user_message"
  | "assistant_message"
  | "reasoning"
  | "plan"
  | "command_execution"
  | "file_change"
  | "mcp_tool_call"
  | "dynamic_tool_call"
  | "collab_agent_tool_call"
  | "web_search"
  | "image_view"
  | "review_entered"
  | "review_exited"
  | "context_compaction"
  | "error"
  | "unknown";
```

### 1.4 Canonical Request Type

```ts
type CanonicalRequestType =
  | "command_execution_approval"
  | "file_change_approval"
  | "apply_patch_approval"
  | "exec_command_approval"
  | "tool_user_input"
  | "dynamic_tool_call"
  | "auth_tokens_refresh"
  | "unknown";
```

### 1.5 Discriminated Union (Type-Safe)

```ts
type SessionState = "starting" | "ready" | "running" | "waiting" | "stopped" | "error";
type ThreadState = "active" | "idle" | "archived" | "closed" | "compacted" | "error";
type TurnState = "completed" | "failed" | "interrupted" | "cancelled";

type ContentStreamKind =
  | "assistant_text"
  | "reasoning_text"
  | "reasoning_summary_text"
  | "plan_text"
  | "command_output"
  | "file_change_output"
  | "unknown";

type ItemLifecyclePayload = {
  itemType: CanonicalItemType;
  status?: "inProgress" | "completed" | "failed" | "declined";
  title?: string;
  detail?: string;
  data?: unknown;
};

type RuntimeEventPayloadByType = {
  "session.started": { message?: string; resume?: unknown };
  "session.configured": { config: Record<string, unknown> };
  "session.state.changed": { state: SessionState; reason?: string; detail?: string };
  "session.exited": { reason?: string; recoverable?: boolean; exitKind?: "graceful" | "error" };

  "thread.started": { providerThreadId?: ProviderThreadId };
  "thread.state.changed": { state: ThreadState; detail?: unknown };
  "thread.metadata.updated": { name?: string; metadata?: Record<string, unknown> };
  "thread.token-usage.updated": { usage: unknown };
  "thread.realtime.started": { realtimeSessionId?: string };
  "thread.realtime.item-added": { item: unknown };
  "thread.realtime.audio.delta": { audio: unknown };
  "thread.realtime.error": { message: string };
  "thread.realtime.closed": { reason?: string };

  "turn.started": { model?: string; effort?: string };
  "turn.completed": {
    state: TurnState;
    stopReason?: string | null;
    usage?: unknown;
    modelUsage?: Record<string, unknown>;
    totalCostUsd?: number;
    errorMessage?: string;
  };
  "turn.aborted": { reason: string };
  "turn.plan.updated": {
    explanation?: string | null;
    plan: Array<{ step: string; status: "pending" | "inProgress" | "completed" }>;
  };
  "turn.diff.updated": { unifiedDiff: string };

  "item.started": ItemLifecyclePayload;
  "item.updated": ItemLifecyclePayload;
  "item.completed": ItemLifecyclePayload;
  "content.delta": {
    streamKind: ContentStreamKind;
    delta: string;
    contentIndex?: number;
    summaryIndex?: number;
  };

  "request.opened": {
    requestType: CanonicalRequestType;
    detail?: string;
    args?: unknown;
  };
  "request.resolved": {
    requestType: CanonicalRequestType;
    decision?: string;
    resolution?: unknown;
  };
  "user-input.requested": { questions: unknown };
  "user-input.resolved": { answers: unknown };

  "task.started": { taskId: RuntimeTaskId; description?: string; taskType?: string };
  "task.progress": {
    taskId: RuntimeTaskId;
    description: string;
    usage?: unknown;
    lastToolName?: string;
  };
  "task.completed": {
    taskId: RuntimeTaskId;
    status: "completed" | "failed" | "stopped";
    summary?: string;
    usage?: unknown;
  };
  "hook.started": { hookId: string; hookName: string; hookEvent: string };
  "hook.progress": { hookId: string; output?: string; stdout?: string; stderr?: string };
  "hook.completed": {
    hookId: string;
    outcome: "success" | "error" | "cancelled";
    output?: string;
    stdout?: string;
    stderr?: string;
    exitCode?: number;
  };
  "tool.progress": {
    toolUseId?: string;
    toolName?: string;
    summary?: string;
    elapsedSeconds?: number;
  };
  "tool.summary": { summary: string; precedingToolUseIds?: string[] };
  "auth.status": { isAuthenticating?: boolean; output?: string[]; error?: string };
  "account.updated": { account: unknown };
  "account.rate-limits.updated": { rateLimits: unknown };
  "mcp.status.updated": { status: unknown };
  "mcp.oauth.completed": { success: boolean; name?: string; error?: string };
  "model.rerouted": { fromModel: string; toModel: string; reason: string };
  "config.warning": { summary: string; details?: string; path?: string; range?: unknown };
  "deprecation.notice": { summary: string; details?: string };
  "files.persisted": {
    files: Array<{ filename: string; fileId: string }>;
    failed?: Array<{ filename: string; error: string }>;
  };
  "runtime.warning": { message: string; detail?: unknown };
  "runtime.error": {
    message: string;
    class?:
      | "provider_error"
      | "transport_error"
      | "permission_error"
      | "validation_error"
      | "unknown";
    detail?: unknown;
  };
};

type CanonicalRuntimeEventTypeFromPayloadMap = keyof RuntimeEventPayloadByType;
type MissingPayloadTypes = Exclude<
  CanonicalRuntimeEventType,
  CanonicalRuntimeEventTypeFromPayloadMap
>;
type ExtraPayloadTypes = Exclude<
  CanonicalRuntimeEventTypeFromPayloadMap,
  CanonicalRuntimeEventType
>;
// Both should be `never`.

export type ProviderRuntimeEventV2 = {
  [TType in CanonicalRuntimeEventTypeFromPayloadMap]: RuntimeEventBase<
    TType,
    RuntimeEventPayloadByType[TType]
  >;
}[CanonicalRuntimeEventTypeFromPayloadMap];
```

### 1.6 ID Semantics

- `eventId`, `sessionId`, `threadId`, `turnId`, `itemId`, `requestId` are **canonical T3 IDs** (branded).
- Provider IDs must go in `providerRefs.*` (and `raw`), never in canonical fields.
- If a canonical id is not known at emit time, omit it and emit only `providerRefs` + `raw`.

---

## 2) Changes vs Current `ProviderRuntimeEvent` (packages/contracts/src/providerRuntime.ts)

## 2.1 Update Existing

| Current           | Action                                                                                 |
| ----------------- | -------------------------------------------------------------------------------------- |
| `session.started` | Keep, add structured payload (`resume/fork/config snapshot if known`)                  |
| `session.exited`  | Keep, add `reason`, `exitKind`, `recoverable`                                          |
| `thread.started`  | Keep, add source metadata                                                              |
| `turn.started`    | Keep, include optional model/provider state                                            |
| `turn.completed`  | Keep, expand status + usage + stopReason + cost/modelUsage                             |
| `message.delta`   | Replace semantics with generic `content.delta` (message delta becomes one stream kind) |
| `runtime.error`   | Keep but include normalized error class + provider raw error info                      |

## 2.2 Delete (replaced)

| Current               | Replacement                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------ |
| `message.completed`   | `item.completed` for `assistant_message`                                                               |
| `tool.started`        | `item.started` (`command_execution`, `file_change`, `mcp_tool_call`, `dynamic_tool_call`, etc.)        |
| `tool.completed`      | `item.completed`                                                                                       |
| `approval.requested`  | `request.opened`                                                                                       |
| `approval.resolved`   | `request.resolved`                                                                                     |
| `checkpoint.captured` | Remove from provider runtime canonical set (keep checkpoint as orchestration-level projection concern) |

## 2.3 Create New

`session.configured`, `session.state.changed`, `thread.state.changed`, `thread.metadata.updated`, `thread.token-usage.updated`, `turn.aborted`, `turn.plan.updated`, `turn.diff.updated`, `item.started`, `item.updated`, `item.completed`, `content.delta`, `request.opened`, `request.resolved`, `user-input.requested`, `user-input.resolved`, `task.*`, `hook.*`, `tool.progress`, `tool.summary`, `auth.status`, `account.*`, `mcp.*`, `model.rerouted`, `config.warning`, `deprecation.notice`, `files.persisted`, realtime thread events.

---

## 3) Codex App Server -> Canonical Mapping

### 3.1 Server Notifications (`ServerNotification.method`)

| Codex method                                              | Canonical V2                                   | Notes                                                                    |
| --------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------ |
| `thread/started`                                          | `thread.started`                               | `thread.id -> threadId`                                                  |
| `thread/status/changed`                                   | `thread.state.changed`                         | preserve full status object (`notLoaded/idle/systemError/active{flags}`) |
| `thread/archived` / `thread/unarchived` / `thread/closed` | `thread.state.changed`                         | normalize `state=archived/unarchived/closed`                             |
| `thread/name/updated`                                     | `thread.metadata.updated`                      | `threadName`                                                             |
| `thread/tokenUsage/updated`                               | `thread.token-usage.updated`                   | preserve totals + breakdown                                              |
| `turn/started`                                            | `turn.started`                                 | `turn.id`, initial turn item snapshot                                    |
| `turn/completed`                                          | `turn.completed`                               | map `TurnStatus`: `completed/interrupted/failed/inProgress`              |
| `turn/diff/updated`                                       | `turn.diff.updated`                            | keep unified diff payload                                                |
| `turn/plan/updated`                                       | `turn.plan.updated`                            | preserve `explanation`, steps (`pending/inProgress/completed`)           |
| `item/started`                                            | `item.started`                                 | map item type to canonical item type                                     |
| `item/completed`                                          | `item.completed`                               | map item type + terminal status                                          |
| `item/agentMessage/delta`                                 | `content.delta`                                | `streamKind=assistant_text`                                              |
| `item/plan/delta`                                         | `content.delta`                                | `streamKind=plan_text`                                                   |
| `item/commandExecution/outputDelta`                       | `content.delta`                                | `streamKind=command_output`                                              |
| `item/fileChange/outputDelta`                             | `content.delta`                                | `streamKind=file_change_output`                                          |
| `item/reasoning/summaryTextDelta`                         | `content.delta`                                | `streamKind=reasoning_summary_text`, `summaryIndex`                      |
| `item/reasoning/summaryPartAdded`                         | `item.updated`                                 | item reasoning summary segment boundary                                  |
| `item/reasoning/textDelta`                                | `content.delta`                                | `streamKind=reasoning_text`, `contentIndex`                              |
| `item/mcpToolCall/progress`                               | `tool.progress`                                | for MCP calls                                                            |
| `item/commandExecution/terminalInteraction`               | `item.updated`                                 | interaction input on command execution item                              |
| `serverRequest/resolved`                                  | `request.resolved`                             | correlate by request id                                                  |
| `model/rerouted`                                          | `model.rerouted`                               | preserve `fromModel/toModel/reason`                                      |
| `thread/compacted`                                        | `thread.state.changed`                         | compacted context marker                                                 |
| `thread/realtime/started`                                 | `thread.realtime.started`                      | realtime transport/session id                                            |
| `thread/realtime/itemAdded`                               | `thread.realtime.item-added`                   | raw realtime item                                                        |
| `thread/realtime/outputAudio/delta`                       | `thread.realtime.audio.delta`                  | preserve sample metadata                                                 |
| `thread/realtime/error`                                   | `thread.realtime.error`                        | message                                                                  |
| `thread/realtime/closed`                                  | `thread.realtime.closed`                       | optional reason                                                          |
| `error`                                                   | `runtime.error`                                | preserve `willRetry`, codex error info                                   |
| `deprecationNotice`                                       | `deprecation.notice`                           | summary/details                                                          |
| `configWarning`                                           | `config.warning`                               | summary/details/path/range                                               |
| `account/updated`                                         | `account.updated`                              | auth mode updates                                                        |
| `account/rateLimits/updated`                              | `account.rate-limits.updated`                  | rate limits snapshot                                                     |
| `mcpServer/oauthLogin/completed`                          | `mcp.oauth.completed`                          | success/error/name                                                       |
| `windows/worldWritableWarning`                            | `runtime.warning`                              | platform warning                                                         |
| `windowsSandbox/setupCompleted`                           | `session.state.changed` + `runtime.warning`    | success/failure diagnostic                                               |
| `app/list/updated`                                        | `runtime.warning` or future `app-list.updated` | optional if UI wants app ecosystem surface                               |
| `account/login/completed`                                 | `auth.status`                                  | login success/error                                                      |

### 3.2 Server Requests (`ServerRequest.method`)

| Codex request method                    | Canonical V2                                                              |
| --------------------------------------- | ------------------------------------------------------------------------- |
| `item/commandExecution/requestApproval` | `request.opened` (`requestType=command_execution_approval`)               |
| `item/fileChange/requestApproval`       | `request.opened` (`requestType=file_change_approval`)                     |
| `applyPatchApproval`                    | `request.opened` (`requestType=apply_patch_approval`)                     |
| `execCommandApproval`                   | `request.opened` (`requestType=exec_command_approval`)                    |
| `item/tool/requestUserInput`            | `user-input.requested` + `request.opened` (`requestType=tool_user_input`) |
| `item/tool/call`                        | `request.opened` (`requestType=dynamic_tool_call`)                        |
| `account/chatgptAuthTokens/refresh`     | `request.opened` (`requestType=auth_tokens_refresh`)                      |

### 3.3 EventMsg cross-reference (`EventMsg.type`)

EventMsg is broader than server notification coverage. Important equivalents:

- `task_started` / `task_complete` -> `turn.started` / `turn.completed`
- `agent_message_delta`, `agent_message_content_delta` -> `content.delta (assistant_text)`
- `agent_reasoning_delta`, `reasoning_content_delta`, `reasoning_raw_content_delta` -> `content.delta (reasoning*)`
- `exec_command_begin/output_delta/end` -> `item.started/content.delta/item.completed` (`command_execution`)
- `patch_apply_begin/end` -> `item.updated/item.completed` (`file_change`)
- `exec_approval_request`, `apply_patch_approval_request`, `request_user_input` -> `request.opened` / `user-input.requested`
- `plan_update`, `plan_delta` -> `turn.plan.updated` / `content.delta(plan_text)`
- `turn_diff`, `turn_aborted`, `thread_rolled_back`, `context_compacted`, `model_reroute` -> dedicated `turn.*` / `thread.*` / `model.rerouted`
- collab events (`collab_*`) -> `item.*` (`collab_agent_tool_call`) or `task.*` depending UI preference

---

## 4) Claude Agent SDK -> Canonical Mapping

### 4.1 SDKMessage Mapping (`@anthropic-ai/claude-agent-sdk@0.2.62`)

| Claude SDK message                                                              | Canonical V2                                                     | Notes                                                                                                        |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `assistant` (`SDKAssistantMessage`)                                             | `item.updated` or `item.completed` (`assistant_message`)         | preserve `message`, `uuid`, optional `error`                                                                 |
| `stream_event` (`SDKPartialAssistantMessage`) `content_block_delta[text_delta]` | `content.delta` (`assistant_text`)                               | primary streamed assistant text                                                                              |
| `stream_event` `content_block_start[tool_use/server_tool_use/mcp_tool_use]`     | `item.started`                                                   | map tool name -> canonical item type (`command_execution`/`file_change`/`mcp_tool_call`/`dynamic_tool_call`) |
| `stream_event` `content_block_stop`                                             | `item.completed`                                                 | close tool item started above                                                                                |
| `result` `subtype=success`                                                      | `turn.completed` (`status=completed`)                            | include usage/modelUsage/cost/stop_reason                                                                    |
| `result` `subtype=error_*`                                                      | `runtime.error` + `turn.completed(status=failed)`                | include error list + subtype                                                                                 |
| `system:init`                                                                   | `session.configured`                                             | model/tools/permissionMode/skills/plugins/mcp status                                                         |
| `system:status`                                                                 | `session.state.changed`                                          | compacting status + permission mode                                                                          |
| `system:compact_boundary`                                                       | `thread.state.changed`                                           | context compaction boundary                                                                                  |
| `system:hook_started`                                                           | `hook.started`                                                   | hook telemetry                                                                                               |
| `system:hook_progress`                                                          | `hook.progress`                                                  | hook stdout/stderr/output                                                                                    |
| `system:hook_response`                                                          | `hook.completed`                                                 | outcome + exit_code                                                                                          |
| `tool_progress`                                                                 | `tool.progress`                                                  | elapsed seconds, tool name, tool_use_id                                                                      |
| `tool_use_summary`                                                              | `tool.summary`                                                   | summary + related tool use ids                                                                               |
| `auth_status`                                                                   | `auth.status`                                                    | authentication progress/errors                                                                               |
| `system:task_started`                                                           | `task.started`                                                   | background task/subagent activity                                                                            |
| `system:task_progress`                                                          | `task.progress`                                                  | incremental background task updates                                                                          |
| `system:task_notification`                                                      | `task.completed`                                                 | status completed/failed/stopped                                                                              |
| `system:files_persisted`                                                        | `files.persisted`                                                | file ids persisted to backend                                                                                |
| `user` / `user (isReplay)`                                                      | optional `item.started/item.completed (user_message)`            | keep if we want full transcript parity                                                                       |
| `rate_limit` / `prompt_suggestion` (in union)                                   | `account.rate-limits.updated` or `item.updated(plan_suggestion)` | preserve raw payload even if sparse typing                                                                   |

### 4.2 Claude Permission Callback Mapping (`canUseTool`)

| Claude callback phase                                                                       | Canonical V2                                                                                       |
| ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| permission request (`toolName`, input, suggestions, blockedPath, decisionReason, toolUseID) | `request.opened` (`requestType=command_execution_approval` or `file_change_approval` or `unknown`) |
| user decision allow/deny (+updatedPermissions)                                              | `request.resolved`                                                                                 |
| interrupt/deny behavior                                                                     | `turn.completed(status=interrupted)` or `runtime.error` as appropriate                             |

---

## 5) Cursor ACP -> Canonical Mapping

### 5.1 ACP session lifecycle (JSON-RPC methods)

| Cursor ACP method                    | Canonical V2                                                             | Notes                                                                                         |
| ------------------------------------ | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `initialize` (response)              | `session.configured`                                                     | preserve `protocolVersion`, `agentCapabilities`, `authMethods`                                |
| `authenticate` (response)            | `auth.status`                                                            | success when empty result; errors map to `runtime.error(class=permission_error)`              |
| `session/new` (response)             | `session.started` + `thread.started` + `session.state.changed(ready)`    | persist `sessionId` in `providerRefs.providerSessionId`; preserve `modes` in payload/raw      |
| `session/load` (response)            | `session.started` + `thread.started` + `session.state.changed(ready)`    | resume path; note ACP requires `sessionId`, `cwd`, `mcpServers` in request                    |
| `session/prompt` (response)          | `turn.completed`                                                         | map `stopReason` (`end_turn`, `cancelled`, etc.)                                              |
| `session/cancel` (error `-32601`)    | `runtime.warning`                                                        | currently unsupported in observed ACP version; adapter should fall back to process interrupt   |

### 5.2 ACP notifications (`session/update`)

| Cursor ACP `update.sessionUpdate` | Canonical V2                             | Notes                                                                                       |
| --------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------- |
| `available_commands_update`       | `session.configured`                     | preserve `availableCommands`; optional secondary `runtime.warning` if list changes mid-turn |
| `agent_thought_chunk`             | `content.delta` (`streamKind=reasoning_text`) | map `content.text`                                                                           |
| `agent_message_chunk`             | `content.delta` (`streamKind=assistant_text`) | map `content.text`                                                                           |
| `tool_call`                       | `item.started`                           | map `toolCallId` -> `itemId`; dedupe starts because ACP may emit multiple `tool_call` updates for the same id |
| `tool_call_update` (`in_progress`) | `item.updated`                           | include status + partial metadata                                                           |
| `tool_call_update` (`completed`)  | `item.completed`                         | include `rawOutput` summary when present (terminal stdout/stderr, search totals, etc.)     |

### 5.3 ACP server requests (permission)

| Cursor ACP request method       | Canonical V2                 | Notes                                                                                                         |
| ------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `session/request_permission`    | `request.opened`             | `requestType` usually `command_execution_approval` for `kind=execute`; preserve options (`allow/reject`)    |
| permission response sent by T3  | `request.resolved`           | map T3 decision -> ACP `optionId` (`allow-once`, `allow-always`, `reject-once`)                             |

### 5.4 ACP runtime/error mapping notes

1. Unknown session on `session/prompt` (`-32603`) -> `runtime.error(class=provider_error)` and terminate active turn as failed.
2. Invalid params / method-not-found (`-32602`, `-32601`) -> `runtime.error(class=validation_error)` or `runtime.warning` depending recoverability.
3. Concurrent `session/prompt` calls can cancel earlier prompt (`stopReason=cancelled`) -> emit `turn.completed(state=cancelled)` for the superseded turn.
4. Keep all ACP envelopes in `raw` with `source` set to `cursor.acp.notification` or `cursor.acp.request`.

---

## 6) Codex SDK Thread Events -> Canonical Mapping

(For parity with direct Codex SDK integrations and to cross-reference app-server behavior.)

| Codex SDK ThreadEvent | Canonical V2                                      |
| --------------------- | ------------------------------------------------- |
| `thread.started`      | `thread.started`                                  |
| `turn.started`        | `turn.started`                                    |
| `turn.completed`      | `turn.completed`                                  |
| `turn.failed`         | `runtime.error` + `turn.completed(status=failed)` |
| `item.started`        | `item.started`                                    |
| `item.updated`        | `item.updated`                                    |
| `item.completed`      | `item.completed`                                  |
| `error`               | `runtime.error`                                   |

Codex SDK `ThreadItem.type` (`agent_message`, `reasoning`, `command_execution`, `file_change`, `mcp_tool_call`, `web_search`, `todo_list`, `error`) maps directly to canonical item types (`assistant_message`, `reasoning`, `command_execution`, `file_change`, `mcp_tool_call`, `web_search`, `plan`, `error`).

---

## 7) Cross-Provider Equivalence (Claude <-> Codex <-> Cursor ACP)

| Concept                     | Codex source                                 | Claude source                                               | Cursor ACP source                                 | Canonical                       |
| --------------------------- | -------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------- | ------------------------------- |
| Turn start                  | `turn/started`                               | first active response turn + `sendTurn` start               | `session/prompt` dispatch lifecycle               | `turn.started`                  |
| Turn completion             | `turn/completed`                             | `result`                                                    | `session/prompt` response (`stopReason`)          | `turn.completed`                |
| Assistant text streaming    | `item/agentMessage/delta`                    | `stream_event content_block_delta[text_delta]`              | `session/update:agent_message_chunk`              | `content.delta(assistant_text)` |
| Reasoning/thought streaming | `item/reasoning/textDelta`                   | reasoning deltas in `stream_event`                          | `session/update:agent_thought_chunk`              | `content.delta(reasoning_text)` |
| Tool call start             | `item/started` with tool item                | `content_block_start tool_use/server_tool_use/mcp_tool_use` | `session/update:tool_call`                        | `item.started`                  |
| Tool call end               | `item/completed` with tool item              | `content_block_stop`                                        | `session/update:tool_call_update(completed)`      | `item.completed`                |
| Approval required           | server request `.../requestApproval`         | `canUseTool` callback                                       | `session/request_permission`                      | `request.opened`                |
| Approval resolved           | `serverRequest/resolved` + response decision | callback resolution decision                                | JSON-RPC response to permission request id        | `request.resolved`              |
| Runtime error               | `error` notification / failed turn           | `result error_*` or assistant error                         | JSON-RPC error response (`-3260x` etc.)           | `runtime.error`                 |
| Session capabilities/config | `session_configured`/init responses          | `system:init`                                               | `initialize` / `available_commands_update`        | `session.configured`            |

---

## 8) Implementation Guidance

1. Emit one canonical event per source message minimum; emit additional derived events when needed (for example `runtime.error` + `turn.completed`).
2. Always attach `raw` payload so provider-specific detail is never lost.
3. Replace current Codex adapter heuristic mapping (`tool.*`, `approval.*`, `message.*`) with method/item-driven mapping from app-server schemas.
4. Extend Claude adapter to emit non-chat telemetry (`system:*`, `task_*`, `hook_*`, `tool_progress`, `auth_status`, `files_persisted`) into canonical events.
5. Keep ID correlation deterministic:
   - request lifecycle keyed by `requestId` / approval id / tool use id
   - item lifecycle keyed by `itemId` (synthesize stable ids for Claude when missing)
6. Treat unknown provider events as `runtime.warning` + raw passthrough instead of dropping.

---

## 9) Summary of Breaking Schema Direction

- Move from a small, chat-centric runtime union to an **item/lifecycle/protocol-complete canonical runtime model**.
- Normalize Claude and Codex onto the same event families (`turn`, `item`, `content`, `request`, `task`, `hook`, `state`), keeping provider specifics in `payload` + `raw`.
- This supports richer integration ports without provider-specific logic in downstream consumers.
