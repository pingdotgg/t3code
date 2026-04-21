# Core Graph And Data Model

## Overview

V2 models orchestration as a graph with a small number of durable entity types:

```text
Project
  AppThread
    Run
      ExecutionNode tree
    ProviderThread handles
    Context handoffs
    Checkpoints
```

The central separation is:

- `AppThread`: the user-visible conversation in T3 Code.
- `Run`: a counted user-visible turn on an app thread.
- `ExecutionNode`: a unit of provider/runtime work inside a run.
- `ProviderThread`: a provider-native conversation handle.
- `ProviderSession`: a live or resumable provider process/runtime.
- `ContextHandoff`: a provider-switch summary that bridges runs into another provider thread.

Provider-specific lifecycle is preserved in provider refs and raw events. App behavior is driven by app-owned ids and graph relationships.

## Entity Summary

```text
AppThread
  id: ThreadId
  projectId: ProjectId
  title
  providerBinding
  activeProviderThreadId?
  forkSource?
  status projection

Run
  id: RunId
  threadId: ThreadId
  ordinal: number
  status
  rootNodeId
  attempts[]
  providerThreadId
  contextHandoffId?
  userMessageId
  checkpoint?

ExecutionNode
  id: NodeId
  threadId: ThreadId
  runId: RunId | null
  parentNodeId: NodeId | null
  rootNodeId: NodeId
  kind
  status
  providerThreadId?
  providerTurnId?
  itemId?
  countsForRun
  checkpointScopeId?

CheckpointScope
  id: CheckpointScopeId
  threadId
  runId?
  nodeId
  parentScopeId?
  kind
  advancesAppRunCount

ProviderSession
  id: ProviderSessionId
  provider
  status
  cwd
  capabilities

ProviderThread
  id: ProviderThreadId
  providerSessionId?
  appThreadId?
  nativeThreadRef?
  coveredRunRange?
  contextHandoffIds[]
  forkSource?

ContextHandoff
  id: ContextHandoffId
  threadId
  fromProviderThreadIds[]
  toProviderThreadId
  coveredRunRange
  strategy
  summaryMessageId?

ProviderTurn
  id: ProviderTurnId
  providerThreadId
  nativeTurnRef?
  nodeId
  runAttemptId?
  status

RuntimeItem
  id: RuntimeItemId
  nodeId
  providerItemRef?
  kind
  status

RuntimeRequest
  id: RuntimeRequestId
  nodeId
  providerRequestRef?
  kind
  status
```

## AppThread

An `AppThread` is the stable user-facing conversation. It owns messages, runs, checkpoints, and UI state. It does not have to map one-to-one with a provider-native thread forever.

```ts
type AppThread = {
  id: ThreadId;
  projectId: ProjectId;
  title: string;
  defaultProvider: ProviderKind;
  modelSelection: ModelSelection;
  runtimeMode: RuntimeMode;
  interactionMode: InteractionMode;
  branch: string | null;
  worktreePath: string | null;
  activeProviderThreadId: ProviderThreadId | null;
  forkedFrom: ForkSource | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  deletedAt: string | null;
};
```

`activeProviderThreadId` points to the provider-native conversation currently backing the app thread. Forking, provider migration, or recovery may create new provider threads while preserving the same app thread, depending on the operation.

`defaultProvider` is only the currently selected default for future runs. Historical runs retain their own provider and provider thread bindings.

## Run

A `Run` is the counted user-visible turn. This replaces using provider turn ids as the app-level lifecycle boundary.

```ts
type Run = {
  id: RunId;
  threadId: ThreadId;
  ordinal: number;
  provider: ProviderKind;
  providerThreadId: ProviderThreadId | null;
  userMessageId: MessageId;
  rootNodeId: NodeId | null;
  activeAttemptId: RunAttemptId | null;
  status:
    | "queued"
    | "starting"
    | "running"
    | "waiting"
    | "completed"
    | "interrupted"
    | "failed"
    | "cancelled"
    | "rolled_back";
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  checkpointId: CheckpointId | null;
  contextHandoffId: ContextHandoffId | null;
  sourcePlanRef?: {
    threadId: ThreadId;
    planId: ProposedPlanId;
  };
};
```

Only a run with `countsForConversation = true` contributes to the user-visible turn count and checkpoint count.

`providerThreadId` is the provider-native conversation used for this run. This makes mixed-provider app threads explicit: run 1 may be Codex, run 2 may be Claude, and run 3 may return to the original Codex provider thread.

## RunAttempt

A `RunAttempt` represents one provider execution attempt for an app run. Most runs have exactly one attempt. Steering, retries, provider recovery, or provider-switch recovery may create more than one attempt.

```ts
type RunAttempt = {
  id: RunAttemptId;
  runId: RunId;
  attemptOrdinal: number;
  rootNodeId: NodeId;
  provider: ProviderKind;
  providerThreadId: ProviderThreadId;
  providerTurnId: ProviderTurnId | null;
  reason: "initial" | "steering_restart" | "retry" | "provider_recovery";
  status:
    | "pending"
    | "running"
    | "completed"
    | "interrupted"
    | "failed"
    | "cancelled"
    | "superseded";
  startedAt: string | null;
  completedAt: string | null;
};
```

Run attempts let app-level steering work even for providers that cannot steer an active native turn. The app can interrupt the active provider turn and create a replacement attempt under the same `RunId`.

Only one attempt is the final selected attempt for run completion and checkpointing. Superseded/interrupted attempts remain in the execution graph for audit/debugging.

## ExecutionNode

An `ExecutionNode` is the generic unit of runtime work. It is the bridge between provider events and app behavior.

```ts
type ExecutionNode = {
  id: NodeId;
  threadId: ThreadId;
  runId: RunId | null;
  parentNodeId: NodeId | null;
  rootNodeId: NodeId;
  kind:
    | "root_turn"
    | "assistant_message"
    | "reasoning"
    | "plan"
    | "todo_list"
    | "tool_call"
    | "approval_request"
    | "user_input_request"
    | "subagent"
    | "hook"
    | "system";
  status:
    | "pending"
    | "running"
    | "waiting"
    | "completed"
    | "interrupted"
    | "failed"
    | "cancelled"
    | "rolled_back";
  countsForRun: boolean;
  providerThreadId: ProviderThreadId | null;
  providerTurnId: ProviderTurnId | null;
  runtimeItemId: RuntimeItemId | null;
  runtimeRequestId: RuntimeRequestId | null;
  checkpointScopeId: CheckpointScopeId | null;
  startedAt: string | null;
  completedAt: string | null;
};
```

The root node of a run is the only node allowed to complete the run. Subagent nodes, tool nodes, approval nodes, and plan nodes may complete independently.

## CheckpointScope

A `CheckpointScope` describes a unit of filesystem state that can be checkpointed. Root runs and child execution nodes can both have checkpoint scopes.

```ts
type CheckpointScope = {
  id: CheckpointScopeId;
  threadId: ThreadId;
  runId: RunId | null;
  nodeId: NodeId;
  parentScopeId: CheckpointScopeId | null;
  providerThreadId: ProviderThreadId | null;
  kind: "root_run" | "subagent" | "tool" | "provider_thread" | "manual";
  ordinalWithinParent: number;
  advancesAppRunCount: boolean;
  cwd: string;
  createdAt: string;
};
```

Root run scopes have `advancesAppRunCount = true`. Child scopes, such as subagents, have `advancesAppRunCount = false` and are nested under the parent run's scope.

## ProviderSession

A `ProviderSession` is a live provider runtime process/session, such as a Codex app-server process or a Claude SDK session.

```ts
type ProviderSession = {
  id: ProviderSessionId;
  provider: ProviderKind;
  status: "starting" | "ready" | "running" | "waiting" | "stopped" | "error";
  cwd: string;
  model: string | null;
  capabilities: ProviderCapabilities;
  createdAt: string;
  updatedAt: string;
  lastError: string | null;
};
```

A provider session may host one or more provider threads if the provider supports it. If a provider only supports one active conversation per process, V2 still models that as one provider thread attached to the session.

## ProviderThread

A `ProviderThread` is a provider-native conversation handle. It is addressable even when it is nested under a subagent execution node.

```ts
type ProviderThread = {
  id: ProviderThreadId;
  provider: ProviderKind;
  providerSessionId: ProviderSessionId | null;
  appThreadId: ThreadId | null;
  ownerNodeId: NodeId | null;
  nativeThreadRef: string | null;
  status: "not_loaded" | "idle" | "active" | "archived" | "closed" | "error";
  firstRunOrdinal: number | null;
  lastRunOrdinal: number | null;
  handoffIds: ContextHandoffId[];
  forkedFrom: ProviderThreadForkSource | null;
  createdAt: string;
  updatedAt: string;
};
```

`appThreadId` is set when the provider thread backs a first-class app thread. `ownerNodeId` is set when the provider thread is nested under an execution node, such as a subagent. A provider thread can later be forked or promoted into a first-class app thread.

A provider thread may have gaps in its native run coverage. Example: runs 1-5 use Codex provider thread A, runs 6-8 use Claude provider thread B, and run 9 returns to Codex thread A with a handoff summary covering runs 6-8. In that case, Codex thread A remains the same provider thread, but it has an explicit `ContextHandoff` before run 9.

## ContextHandoff

A `ContextHandoff` is a first-class artifact created when provider context must be bridged. It is most common when changing providers between runs, but it also applies when provider resume fails and a replacement provider thread must be seeded from app history.

```ts
type ContextHandoff = {
  id: ContextHandoffId;
  threadId: ThreadId;
  targetRunId: RunId;
  fromProviderThreadIds: ProviderThreadId[];
  toProviderThreadId: ProviderThreadId;
  coveredRunOrdinals: {
    from: number;
    to: number;
  };
  strategy:
    | "delta_since_target_last_seen"
    | "full_thread_summary"
    | "checkpoint_summary"
    | "manual_context";
  status: "pending" | "ready" | "failed" | "superseded";
  summaryMessageId: MessageId | null;
  summaryText: string;
  createdByProvider: ProviderKind | null;
  createdAt: string;
  updatedAt: string;
};
```

The handoff is not just prompt text. It is part of the graph and can be inspected, regenerated, superseded, or audited.

The preferred return-to-provider strategy is `delta_since_target_last_seen`: resume the previous provider thread and summarize only the runs that happened while that provider was inactive. Use `full_thread_summary` when resume fails, provider settings are incompatible, or the accumulated handoffs would create poor context quality.

## ProviderTurn

A `ProviderTurn` is the normalized handle for a provider-native turn.

```ts
type ProviderTurn = {
  id: ProviderTurnId;
  providerThreadId: ProviderThreadId;
  nodeId: NodeId;
  runAttemptId: RunAttemptId | null;
  nativeTurnRef: string | null;
  ordinal: number;
  status: "pending" | "running" | "completed" | "interrupted" | "failed" | "cancelled";
  startedAt: string | null;
  completedAt: string | null;
};
```

Codex has strong native turn ids. Weaker providers may only have ordinals. Both map into `ProviderTurnId`.

## RuntimeItem

Items are provider-visible work units inside a turn or node.

```ts
type RuntimeItem = {
  id: RuntimeItemId;
  nodeId: NodeId;
  providerTurnId: ProviderTurnId | null;
  nativeItemRef: string | null;
  ordinal: number;
  kind:
    | "assistant_message"
    | "reasoning"
    | "plan"
    | "todo_list"
    | "command_execution"
    | "file_change"
    | "mcp_tool_call"
    | "dynamic_tool_call"
    | "collab_agent_tool_call"
    | "web_search"
    | "unknown";
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  title: string | null;
  detail: string | null;
};
```

The item id is app-owned. Provider-native item ids are refs.

## RuntimeRequest

Requests represent provider-originated callbacks that require app/user response.

```ts
type RuntimeRequest = {
  id: RuntimeRequestId;
  nodeId: NodeId;
  providerTurnId: ProviderTurnId | null;
  runtimeItemId: RuntimeItemId | null;
  nativeRequestRef: string | null;
  kind:
    | "command_approval"
    | "file_read_approval"
    | "file_change_approval"
    | "dynamic_tool_call"
    | "user_input"
    | "auth_refresh";
  status: "pending" | "resolved" | "expired" | "cancelled";
  responseCapability:
    | { type: "live"; providerSessionId: ProviderSessionId }
    | { type: "not_resumable"; reason: string };
  createdAt: string;
  resolvedAt: string | null;
};
```

Requests may remain visible after restart, but they are only respondable if their `responseCapability` is live.

## Messages

Messages are part of the conversation projection, not the raw provider graph. They link back to runs and nodes when possible.

```ts
type ConversationMessage = {
  id: MessageId;
  threadId: ThreadId;
  runId: RunId | null;
  nodeId: NodeId | null;
  role: "user" | "assistant" | "system";
  text: string;
  attachments: Attachment[];
  streaming: boolean;
  createdAt: string;
  updatedAt: string;
};
```

Provider message chunks are collected through items/content events and projected into messages. The projection may hide child/subagent messages by default while preserving them in the graph.

## Plans, Questions, And Todo Lists

V2 treats these as structured runtime items or nodes.

```ts
type PlanArtifact = {
  id: PlanId;
  threadId: ThreadId;
  runId: RunId | null;
  nodeId: NodeId;
  kind: "proposed_plan" | "todo_list" | "questions";
  status: "draft" | "active" | "completed" | "superseded";
  markdown?: string;
  steps?: Array<{ id: string; text: string; status: "pending" | "running" | "completed" }>;
  questions?: UserInputQuestion[];
};
```

Codex `turn/plan/updated` maps to a `todo_list` artifact. Plan-mode final plan items map to `proposed_plan`. User-input question requests map to `questions` plus a `RuntimeRequest`.

## Checkpoint

Checkpoints attach to checkpoint scopes. A root run checkpoint is the user-visible conversation checkpoint. A child checkpoint records nested filesystem state for a subagent, tool, or provider thread without advancing the parent run count.

```ts
type Checkpoint = {
  id: CheckpointId;
  threadId: ThreadId;
  scopeId: CheckpointScopeId;
  runId: RunId | null;
  nodeId: NodeId;
  parentCheckpointId: CheckpointId | null;
  ordinalWithinScope: number;
  appRunOrdinal: number | null;
  ref: string;
  status: "ready" | "missing" | "error";
  files: CheckpointFileSummary[];
  capturedAt: string;
};
```

A child/subagent provider turn can create a child checkpoint. It does not create an app-run checkpoint unless it is running as a first-class app run in a forked/promoted thread.

## Raw Event Log

The raw event log is append-only evidence.

```ts
type RawProviderEvent = {
  id: RawEventId;
  provider: ProviderKind;
  providerSessionId: ProviderSessionId;
  sequence: number;
  direction: "incoming" | "outgoing";
  messageKind: "request" | "response" | "notification" | "error";
  method: string | null;
  jsonRpcId: string | number | null;
  payload: unknown;
  observedAt: string;
};
```

No domain behavior should depend on parsing historic UI events if raw provider events are available.

## Projections

V2 should expose separate projections:

- Thread shell: fast sidebar list.
- Thread detail: messages, runs, activities, checkpoints, plans.
- Execution graph: debug/developer view of nodes and provider refs.
- Provider sessions: live runtime/process state.
- Pending requests: actionable approvals/user input.

The UI can remain simple while the graph remains precise.

## Turn Item Projection

The frontend should not reconstruct display order by merging `messages`, `runtimeItems`, `plans`, checkpoints, approvals, and activities itself. V2 should expose an ordered `turnItems` projection for thread detail rendering.

`turnItems` are projection records, not the canonical source of truth. The canonical graph remains normalized in runs, attempts, nodes, runtime items, requests, messages, plans, and checkpoints. The projection reducer is responsible for turning that graph into a deterministic display stream.

Known common tools should have structured item variants so the frontend can render stable custom components without parsing provider text:

```ts
type TurnItem =
  | UserMessage
  | AssistantMessage
  | Reasoning
  | Plan
  | FileChange
  | CommandExecution
  | FileSearch
  | WebSearch
  | ApprovalRequest
  | Checkpoint
  | Compaction
  | Handoff
  | Fork
  | DynamicTool;
```

Examples:

```ts
type FileChange = {
  type: "file_change";
  fileName: string;
  additions?: number;
  deletions?: number;
  diffStr?: string;
  oldStr?: string;
  newStr?: string;
};

type CommandExecution = {
  type: "command_execution";
  input: string;
  status: TurnItemStatus;
  output?: string;
  exitCode?: number;
};

type DynamicTool = {
  type: "dynamic_tool";
  toolName: string | null;
  input: unknown;
  output?: unknown;
};
```

Compaction, handoff, and fork are orchestration lifecycle items, not dynamic tools:

- `compaction`: one item can transition from `running` with title like "Compacting context..." to `completed` with title like "Compacted context".
- `handoff`: records the context bridge from one or more source provider threads/providers to a target provider thread/provider.
- `fork`: records that the user or system created a new app thread from a run, node, or provider thread.

The UI can render known variants with deterministic components and render `dynamic_tool` as expandable JSON input/output. Each turn item keeps refs back to `runId`, `nodeId`, `providerTurnId`, and `runtimeItemId` so debug views can jump from the display stream back into the graph.
