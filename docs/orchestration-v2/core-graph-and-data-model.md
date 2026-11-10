# Core Graph And Data Model

## Overview

V2 models orchestration as a graph with a small number of durable entity types:

```text
Project
  AppThread
    Run
      ExecutionNode tree
    ProviderThread handles
    Context transfers and handoffs
    Checkpoints
```

The central separation is:

- `AppThread`: the user-visible conversation in T3 Code.
- `Run`: a counted user-visible turn on an app thread.
- `ExecutionNode`: a unit of provider/runtime work inside a run.
- `ProviderThread`: a provider-native conversation handle.
- `ProviderSession`: a live or resumable provider process/runtime.
- `ContextTransfer`: a provider-neutral relationship/source-point record used by forks, provider switches, merge-back, and subagents.
- `ContextHandoff`: a materialized portable context artifact used when native transfer is unavailable or insufficient.

Provider-specific lifecycle is preserved in provider refs and diagnostic raw-provider logs. App behavior is driven by app-owned ids, V2-native orchestration events, and graph relationships.

V2 events are durable because they are the app state transition log. Raw provider frames are not durable app state. They may be attached by optional correlation ids such as `rawEventId`, but the canonical durable row is the normalized V2 event.

Every committed V2 event has a store-assigned monotonically increasing `sequence`. Projection snapshots and websocket streams use that sequence as the cursor boundary:

```text
read snapshot at sequence N
  -> stream committed V2 events where sequence > N
```

The sequence belongs to the stored event envelope, not the provider event and not the domain payload. Provider-native ordering is preserved separately through provider refs and diagnostic logs. Clients should treat the snapshot's `snapshotSequence` as the authoritative cursor and apply only subsequent events with a greater sequence.

## Entity Summary

```text
AppThread
  id: ThreadId
  projectId: ProjectId
  title
  providerBinding
  activeProviderThreadId?
  lineage?
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
  nativeConversationHeadRef?
  coveredRunRange?
  contextHandoffIds[]
  forkSource?

ContextTransfer
  id: ContextTransferId
  type
  sourceThreadId
  targetThreadId
  sourcePoint
  basePoint?
  sourceProvider?
  targetProvider?
  status
  resolution?

ContextHandoff
  id: ContextHandoffId
  transferId
  kind
  payload
  status

ProviderTurn
  id: ProviderTurnId
  providerThreadId
  nativeTurnRef?
  nodeId
  runAttemptId?
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
  lineage: AppThreadLineage | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  deletedAt: string | null;
};
```

`activeProviderThreadId` points to the provider-native conversation currently backing the app thread. Forking, provider migration, or recovery may create new provider threads while preserving the same app thread, depending on the operation.

`defaultProvider` is only the currently selected default for future runs. Historical runs retain their own provider and provider thread bindings.

`lineage` is intentionally lightweight browsing metadata. Operational source points, lazy native fork resolution, portable context handoffs, merge-back deltas, and subagent result transfers live in `ContextTransfer` rows because an app thread can participate in more than one transfer over time.

```ts
type AppThreadLineage = {
  parentThreadId: ThreadId | null;
  relationshipToParent: "fork" | "subagent" | null;
  rootThreadId: ThreadId;
};
```

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

`contextHandoffId` points to a materialized handoff artifact consumed by this run. A run may also be associated with a broader `ContextTransfer` through the transfer's target/source fields. The handoff is the payload; the transfer is the durable relationship and policy record.

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
  nativeItemRef: ProviderRef | null;
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

The session entity is durable metadata for a live-or-recoverable runtime, not the runtime handle itself. The in-memory process/client handle may disappear because the server restarted, an idle reaper released it, or the provider process crashed. In all cases, the app keeps the `ProviderSession`, `ProviderThread`, and native resume refs in durable state, then recreates the live runtime through the normal provider session manager path.

Provider runtime ids and ordinals must not depend on adapter process memory. If a value is persisted or must survive recovery, it is allocated by the orchestrator/correlation/id services or derived from durable provider refs.

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
  nativeConversationHeadRef: ProviderRef | null;
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

## ContextTransfer

A `ContextTransfer` records a source/target relationship and how context should move between them. It is the shared primitive for user forks, provider switching, merge-back, and subagents.

```ts
type ContextTransfer = {
  id: ContextTransferId;
  type: "fork" | "provider_handoff" | "merge_back" | "subagent_spawn" | "subagent_result";
  sourceThreadId: ThreadId;
  targetThreadId: ThreadId;
  sourcePoint: ContextSourcePoint;
  basePoint: ContextSourcePoint | null;
  sourceProvider: ProviderKind | null;
  targetProvider: ProviderKind | null;
  status:
    | "pending"
    | "resolved_native"
    | "resolved_portable"
    | "failed"
    | "consumed"
    | "superseded";
  resolution: ContextTransferResolution | null;
  createdBy: "user" | "agent" | "system";
  createdAt: string;
  consumedAt: string | null;
};
```

```ts
type ContextSourcePoint = {
  threadId: ThreadId;
  runId: RunId | null;
  checkpointId: CheckpointId | null;
  turnItemId: TurnItemId | null;
  providerThreadRef: NativeThreadRef | null;
  providerTurnRef: NativeTurnRef | null;
};

type ContextTransferResolution =
  | { strategy: "native_fork"; providerThreadRef: NativeThreadRef }
  | { strategy: "portable_context"; contextHandoffId: ContextHandoffId }
  | { strategy: "delta_context"; contextHandoffId: ContextHandoffId }
  | { strategy: "checkpoint_context"; contextHandoffId: ContextHandoffId };
```

Creating a transfer should be cheap. Expensive context handoffs are materialized lazily when the target run starts and the selected provider is known.

## ContextHandoff

A `ContextHandoff` is a first-class artifact created when portable provider context must be bridged. It is most common when changing providers between runs, but it also applies when provider resume fails and a replacement provider thread must be seeded from app history.

In the broader transfer model, `ContextTransfer` records source, target, and lifecycle. `ContextHandoff` is the materialized payload consumed by a run when native transfer cannot satisfy the relationship.

```ts
type ContextHandoff = {
  id: ContextHandoffId;
  transferId: ContextTransferId;
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

## RuntimeRequest

Requests represent provider-originated callbacks that require app/user response.

```ts
type RuntimeRequest = {
  id: RuntimeRequestId;
  nodeId: NodeId;
  providerTurnId: ProviderTurnId | null;
  nativeRequestRef: string | null;
  kind:
    | "command"
    | "file-read"
    | "file-change"
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

The permission kinds are the same canonical domain values used by V1 `ProviderRequestKind`.
Adapters map provider-native callback names such as Codex `item/commandExecution/requestApproval`
and Claude tool permission names into these app-level values.

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

V2 treats these as structured turn items or execution nodes.

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
  status: "ready" | "missing" | "error" | "stale";
  files: CheckpointFileSummary[];
  capturedAt: string;
};
```

A child/subagent provider turn can create a child checkpoint. It does not create an app-run checkpoint unless it is running as a first-class app run in a forked/promoted thread.

## Raw Provider Diagnostics

Raw provider diagnostics are append-only evidence for debugging, support, and replay fixture generation. They should be written to bounded rotating log files, not treated as canonical durable SQLite state.

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

No domain behavior should depend on parsing historic UI events if raw provider diagnostics are available. Production behavior should depend on normalized orchestration events/entities and provider refs. Raw provider frames are evidence and replay input, not the source of truth for normal app state.

Normalized V2 entities should preserve enough correlation metadata to explain and route behavior:

- provider kind.
- provider session/thread/turn refs.
- provider item/request refs when available.
- native id strength.
- diagnostic log location or raw frame reference when useful.

The replay framework can use raw provider transcripts as input without requiring production SQLite to store every raw frame.

## Projections

V2 should expose separate projections:

- Thread shell: fast sidebar list.
- Thread detail: messages, runs, activities, checkpoints, plans.
- Execution graph: debug/developer view of nodes and provider refs.
- Provider sessions: live runtime/process state.
- Pending requests: actionable approvals/user input.

The UI can remain simple while the graph remains precise.

Projection streaming should use the existing app snapshot-plus-cursor contract. A thread-detail subscription should return a projection snapshot at sequence `N`, then stream only events after `N`. The frontend should not receive events already reflected in the snapshot. Reconnects may reset from a fresh snapshot instead of replaying local client state; the fresh snapshot and its `snapshotSequence` become the new cursor boundary.

## Turn Item Projection

The frontend should not reconstruct display order by merging `messages`, `plans`, checkpoints, approvals, and activities itself. V2 exposes an ordered `turnItems` projection for thread detail rendering.

`turnItems` are projection records, not the canonical source of truth. The canonical graph remains normalized in runs, attempts, nodes, requests, messages, plans, and checkpoints. Provider-native item refs live directly on nodes and turn items where correlation is needed.

Forked threads also expose a derived `visibleTurnItems` projection. `turnItems` remains the canonical
items emitted on that app thread. `visibleTurnItems` is the user-visible ordered read model: it may
reference inherited source items through the fork source point, include synthetic lifecycle markers
such as "forked from conversation", and then continue with local target-thread items. This keeps
storage normalized while giving thread detail views and tests one backend-owned surface to assert.

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

The UI can render known variants with deterministic components and render `dynamic_tool` as expandable JSON input/output. Each turn item keeps refs back to `runId`, `nodeId`, `providerTurnId`, and `nativeItemRef` so debug views can jump from the display stream back into the graph and provider logs.
