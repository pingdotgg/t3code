# Orchestration Interface Spec (Required State)

Status: Required target architecture (not a description of current behavior).

## 1. Identifier Schema (Branded)

All identifiers are branded and never plain `string` in schema definitions.

```ts
const ThreadId = Schema.String.pipe(Schema.brand("ThreadId"));
const ProjectId = Schema.String.pipe(Schema.brand("ProjectId"));
const CommandId = Schema.String.pipe(Schema.brand("CommandId"));
const EventId = Schema.String.pipe(Schema.brand("EventId"));
const MessageId = Schema.String.pipe(Schema.brand("MessageId"));
const TurnId = Schema.String.pipe(Schema.brand("TurnId"));

const ProviderSessionId = Schema.String.pipe(Schema.brand("ProviderSessionId"));
const ProviderThreadId = Schema.String.pipe(Schema.brand("ProviderThreadId"));
const ProviderTurnId = Schema.String.pipe(Schema.brand("ProviderTurnId"));
const ProviderItemId = Schema.String.pipe(Schema.brand("ProviderItemId"));
const ApprovalRequestId = Schema.String.pipe(Schema.brand("ApprovalRequestId"));

const CheckpointRef = Schema.String.pipe(Schema.brand("CheckpointRef"));
```

Rules:

- `ThreadId` is app/orchestration thread identity.
- `ProviderThreadId` is provider runtime thread identity.
- They are never assigned to each other.
- `ProviderSessionId` is internal server/provider routing identity; clients do not send it.
- use e.g. `ThreadId.make(randomUUID())` to create new entity ids at the source (e.g. client create thread id and send to server, provider adapter creates the provider thread id from the codex app server etc)

## 2. Client Commands (Domain Commands)

All commands are sent through one RPC: `orchestration.dispatchCommand`.

Output for every command: `DispatchResultSchema = { sequence: number }`.

### 2.1 Client-Dispatchable Commands

1. `project.create`

- Input:
  - `commandId: CommandId`
  - `projectId: ProjectId`
  - `title: string`
  - `workspaceRoot: string`
  - `defaultModel?: string`
  - `createdAt: IsoDateTime`
- Output: `DispatchResult`

2. `project.meta.update`

- Input:
  - `commandId: CommandId`
  - `projectId: ProjectId`
  - optional `{ title, workspaceRoot, defaultModel, scripts }`
- Output: `DispatchResult`

3. `project.delete`

- Input: `commandId`, `projectId`
- Output: `DispatchResult`

4. `thread.create`

- Input:
  - `commandId: CommandId`
  - `threadId: ThreadId`
  - `projectId: ProjectId`
  - `title: string`
  - `model: string`
  - `branch: string | null`
  - `worktreePath: string | null`
  - `createdAt: IsoDateTime`
- Output: `DispatchResult`

5. `thread.delete`

- Input: `commandId`, `threadId`
- Output: `DispatchResult`

6. `thread.meta.update`

- Input: `commandId`, `threadId`, optional `{ title, model, branch, worktreePath }`
- Output: `DispatchResult`

7. `thread.turn.start`

- Input:
  - `commandId`
  - `threadId`
  - `message`:
    - `messageId: MessageId`
    - `role: "user"`
    - `text: string`
    - `attachments: ChatAttachment[]` (schema-shared)
  - `model?: string`
  - `effort?: string`
  - `createdAt`
- Output: `DispatchResult`

8. `thread.turn.interrupt`

- Input: `commandId`, `threadId`, optional `turnId: TurnId`, `createdAt`
- Output: `DispatchResult`

9. `thread.approval.respond`

- Input:
  - `commandId`
  - `threadId`
  - `requestId: ApprovalRequestId`
  - `decision: "accept" | "acceptForSession" | "decline" | "cancel"`
  - `createdAt`
- Output: `DispatchResult`

10. `thread.checkpoint.revert`

- Input: `commandId`, `threadId`, `turnCount: number`, `createdAt`
- Output: `DispatchResult`

11. `thread.session.stop`

- Input: `commandId`, `threadId`, `createdAt`
- Output: `DispatchResult`

### 2.2 Internal-Only Commands (Not Client Dispatchable)

1. `thread.session.set`

- Server-owned projection update for session lifecycle.

2. `thread.message.assistant.delta`

- Server-owned incremental assistant content append.

3. `thread.message.assistant.complete`

- Server-owned assistant message completion marker.

4. `thread.turn.diff.complete`

- Server-owned checkpoint diff summary write.

5. `thread.activity.append`

- Server-owned activity feed append.

## 3. Client RPC (Required)

These are the required client-facing RPC methods.

1. `orchestration.getSnapshot`

- Input: `{}`
- Output: `OrchestrationReadModel`

2. `orchestration.dispatchCommand`

- Input: `ClientOrchestrationCommand` (`Schema.Union` of all client-dispatchable commands)
- Output: `DispatchResult`

3. `orchestration.getTurnDiff`

- Input:
  - `threadId: ThreadId`
  - `fromTurnCount: number`
  - `toTurnCount: number`
- Output:
  - `threadId: ThreadId`
  - `fromTurnCount: number`
  - `toTurnCount: number`
  - `diff: string`

4. `orchestration.replayEvents` (optional operational/debug API)

- Input: `{ fromSequenceExclusive: number }`
- Output: `OrchestrationEvent[]`

### 3.1 RPC To Remove

Remove from client boundary:

- `providers.startSession`
- `providers.sendTurn`
- `providers.interruptTurn`
- `providers.respondToRequest`
- `providers.stopSession`
- `providers.listCheckpoints`
- `providers.getCheckpointDiff`
- `providers.revertToCheckpoint`

Rationale:

- Session/turn/checkpoint control belongs to orchestrator command path.
- Snapshot already includes checkpoint summaries (`checkpoints`); only full textual diff needs explicit query RPC.

## 4. Server Orchestrator Command <-> Event Schemas

Each command deterministically yields one or more domain events that are persisted to the event store.

1. `project.create` -> `project.created`
2. `project.meta.update` -> `project.meta-updated`
3. `project.delete` -> `project.deleted`
4. `thread.create` -> `thread.created`
5. `thread.delete` -> `thread.deleted`
6. `thread.meta.update` -> `thread.meta-updated`
7. `thread.turn.start` ->

- `thread.message-sent` (user message append)
- `thread.turn-start-requested`
- then (async side effect success) `thread.session-set` + provider-driven message/turn events

8. `thread.turn.interrupt` -> `thread.turn-interrupt-requested`
9. `thread.approval.respond` -> `thread.approval-response-requested`
10. `thread.checkpoint.revert` -> `thread.checkpoint-revert-requested` then `thread.reverted`
11. `thread.session.stop` -> `thread.session-stop-requested` then `thread.session-set`

Internal command/event path:

- `thread.session.set` -> `thread.session-set`
- `thread.message.assistant.delta` -> `thread.message-sent` (assistant streaming)
- `thread.message.assistant.complete` -> `thread.message-sent` (streaming false)
- `thread.turn.diff.complete` -> `thread.turn-diff-completed`
- `thread.activity.append` -> `thread.activity-appended`

## 5. Orchestration Events <-> Generic Provider Events <-> Raw Provider Events

Required mapping pipeline:

`Raw Provider Event (adapter-specific)`
-> `GenericProviderRuntimeEvent` (provider-agnostic schema)
-> `Internal Orchestration Command`
-> `Orchestration Domain Event`

### 5.1 Mapping Table for Codex Adapter

1. Raw `thread/started`

- Generic: `thread.started`
- Internal command: `thread.session.set` (attach `ProviderThreadId`, status `ready|running`)
- Domain event: `thread.session-set`

2. Raw `turn/started`

- Generic: `turn.started`
- Internal command: `thread.session.set` (status `running`, active turn)
- Domain event: `thread.session-set`

3. Raw `item/agentMessage/delta`

- Generic: `message.delta`
- Internal command: `thread.message.assistant.delta`
- Domain event: `thread.message-sent` (assistant, streaming)

4. Raw `item/completed` (agent message)

- Generic: `message.completed`
- Internal command: `thread.message.assistant.complete`
- Domain event: `thread.message-sent` (assistant, completed)

5. Raw `turn/completed`

- Generic: `turn.completed`
- Internal commands:
  - `thread.session.set` (ready/error)
  - `thread.activity.append` (optional summary)
- Domain events: `thread.session-set`, `thread.activity-appended`

6. Raw approval request

- Generic: `approval.requested`
- Internal command: `thread.activity.append` (typed `requestId`, `requestKind`)
- Domain event: `thread.activity-appended`

7. Raw approval decision ack

- Generic: `approval.resolved`
- Internal command: `thread.activity.append`
- Domain event: `thread.activity-appended`

8. Raw tool start/complete

- Generic: `tool.started` / `tool.completed`
- Internal command: `thread.activity.append`
- Domain event: `thread.activity-appended`

9. Checkpoint capture (server-produced)

- Generic: `checkpoint.captured`
- Internal command: `thread.turn.diff.complete`
- Domain event: `thread.turn-diff-completed`

10. Raw/runtime error

- Generic: `runtime.error`
- Internal commands:
  - `thread.session.set` (status `error`)
  - `thread.activity.append` (`tone=error`)
- Domain events: `thread.session-set`, `thread.activity-appended`

## 6. Schema Section (Boundary + Reuse)

### 6.1 Shared Schemas (contracts package)

Expose to both web and server:

- `OrchestrationReadModelSchema`
- `ClientOrchestrationCommandSchema`
- `OrchestrationEventSchema`
- `OrchestrationRpcSchemas` (`getSnapshot`, `dispatchCommand`, `getTurnDiff`, optional replay)
- `GenericProviderRuntimeEventSchema` (used for diagnostics/ingestion tests)
- Shared message/activity/checkpoint summary schemas used in snapshot

### 6.2 Server-Internal Schemas

Not exposed to web:

- `InternalOrchestrationCommandSchema`
- Adapter raw-event schemas and provider-specific payload schemas
- Provider session directory records and persistence-only row schemas
- Git service cache/query schemas (non-orchestration read model)

### 6.3 Reuse Requirements

- Snapshot checkpoint summary schema is source of truth for checkpoint list UI.
- `getTurnDiff` response reuses `ThreadId`/turn count brands and textual `diff` only.
- Activity schemas are reused for approval/tool/runtime annotations; no separate UI-only structure.
- Session schema must include both `threadId: ThreadId` and optional `providerThreadId: ProviderThreadId` (explicitly distinct).

## 7. Persistence Model (Required)

This section defines required persisted tables, the canonical persisted event envelope, and required projected/read tables.

### 7.1 Write-Side Persisted Tables

1. `orchestration_events` (append-only event store)

- `sequence: number` (global monotonic sequence, primary key)
- `eventId: EventId` (unique)
- `aggregateKind: "project" | "thread"`
- `streamId: ProjectId | ThreadId` (aggregate stream id)
- `streamVersion: number` (per-aggregate monotonic version)
- `eventType: OrchestrationEventType`
- `occurredAt: IsoDateTime`
- `commandId: CommandId | null`
- `causationEventId: EventId | null`
- `correlationId: CommandId | null`
- `actorKind: "client" | "server" | "provider"`
- `payload: OrchestrationEventPayload` (type-validated by `eventType`)
- `metadata: OrchestrationEventMetadata`

2. `orchestration_command_receipts` (idempotency + ack replay)

- `commandId: CommandId` (primary key)
- `aggregateKind: "project" | "thread"`
- `aggregateId: ProjectId | ThreadId`
- `acceptedAt: IsoDateTime`
- `resultSequence: number`
- `status: "accepted" | "rejected"`
- `error: string | null`

3. `checkpoint_diff_blobs` (large plaintext diffs; separate from summaries)

- `threadId: ThreadId`
- `fromTurnCount: number`
- `toTurnCount: number`
- `diff: string`
- `createdAt: IsoDateTime`
- unique key: `(threadId, fromTurnCount, toTurnCount)`

4. `provider_session_runtime` (server-internal adapter resume state)

- `providerSessionId: ProviderSessionId` (primary key)
- `threadId: ThreadId`
- `providerName: string`
- `adapterKey: string`
- `providerThreadId: ProviderThreadId | null`
- `status: "starting" | "running" | "stopped" | "error"`
- `lastSeenAt: IsoDateTime`
- `resumeCursor: JsonValue | null` (adapter-specific opaque state)
- `runtimePayload: JsonValue | null` (adapter-specific opaque state)

### 7.2 Canonical Persisted Event Schema

`OrchestrationPersistedEventSchema` (full envelope):

```ts
type OrchestrationPersistedEvent = {
  sequence: number;
  eventId: EventId;
  aggregateKind: "project" | "thread";
  streamId: ProjectId | ThreadId;
  streamVersion: number;
  eventType: OrchestrationEventType;
  occurredAt: IsoDateTime;
  commandId: CommandId | null;
  causationEventId: EventId | null;
  correlationId: CommandId | null;
  actorKind: "client" | "server" | "provider";
  payload: OrchestrationEventPayload;
  metadata: {
    providerSessionId?: ProviderSessionId;
    providerThreadId?: ProviderThreadId;
    providerTurnId?: ProviderTurnId;
    providerItemId?: ProviderItemId;
    adapterKey?: string;
    requestId?: ApprovalRequestId;
    ingestedAt?: IsoDateTime;
  };
};
```

Rules:

- `payload` must be schema-discriminated by `eventType`.
- provider identifiers only appear in `metadata` and provider-specific payload sub-shapes; they do not replace `ThreadId`.
- `streamVersion` is concurrency guard for aggregate writes.

### 7.3 Required Projected Tables (Read Models)

1. `projection_projects`

- `projectId: ProjectId` (primary key)
- `title: string`
- `workspaceRoot: string`
- `defaultModel: string | null`
- `scripts: ProjectScript[]`
- `createdAt: IsoDateTime`
- `updatedAt: IsoDateTime`
- `deletedAt: IsoDateTime | null`

2. `projection_threads`

- `threadId: ThreadId` (primary key)
- `projectId: ProjectId`
- `title: string`
- `model: string`
- `branch: string | null`
- `worktreePath: string | null`
- `latestTurnId: TurnId | null`
- `createdAt: IsoDateTime`
- `updatedAt: IsoDateTime`
- `deletedAt: IsoDateTime | null`

3. `projection_thread_messages`

- `messageId: MessageId` (primary key)
- `threadId: ThreadId`
- `turnId: TurnId | null`
- `role: "user" | "assistant" | "system"`
- `text: string`
- `isStreaming: boolean`
- `createdAt: IsoDateTime`
- `updatedAt: IsoDateTime`

4. `projection_thread_activities`

- `activityId: EventId` (primary key; derived from source event)
- `threadId: ThreadId`
- `turnId: TurnId | null`
- `tone: "info" | "tool" | "approval" | "error"`
- `kind: string`
- `summary: string`
- `payload: JsonValue`
- `createdAt: IsoDateTime`

5. `projection_thread_sessions`

- `threadId: ThreadId` (primary key)
- `status: "idle" | "starting" | "running" | "ready" | "interrupted" | "stopped" | "error"`
- `providerName: string | null`
- `providerSessionId: ProviderSessionId | null`
- `providerThreadId: ProviderThreadId | null`
- `activeTurnId: TurnId | null`
- `lastError: string | null`
- `updatedAt: IsoDateTime`

6. `projection_thread_turns`

- `turnId: TurnId` (primary key)
- `threadId: ThreadId`
- `turnCount: number`
- `status: "running" | "completed" | "interrupted" | "error"`
- `userMessageId: MessageId | null`
- `assistantMessageId: MessageId | null`
- `startedAt: IsoDateTime`
- `completedAt: IsoDateTime | null`

7. `projection_checkpoints`

- `threadId: ThreadId`
- `turnId: TurnId`
- `checkpointTurnCount: number`
- `checkpointRef: CheckpointRef`
- `status: "ready" | "missing" | "error"`
- `files: JsonArray` (typed as file diff summary schema)
- `assistantMessageId: MessageId | null`
- `completedAt: IsoDateTime`
- unique key: `(threadId, checkpointTurnCount)`

8. `projection_pending_approvals`

- `requestId: ApprovalRequestId` (primary key)
- `threadId: ThreadId`
- `turnId: TurnId | null`
- `status: "pending" | "resolved"`
- `decision: "accept" | "acceptForSession" | "decline" | "cancel" | null`
- `createdAt: IsoDateTime`
- `resolvedAt: IsoDateTime | null`

9. `projection_state`

- `projector: string` (primary key; e.g. `threads`, `messages`, `sessions`)
- `lastAppliedSequence: number`
- `updatedAt: IsoDateTime`

Projection consistency rules:

- Every projector applies read-model row updates and `projection_state.lastAppliedSequence` in the same database transaction.
- Optional debug field on projection rows: `lastEventSequence: number` (not required for correctness).

### 7.4 Snapshot and RPC Requirements

1. `orchestration.getSnapshot` is fully served from projection tables and returns `snapshotSequence: number`.
2. Snapshot must include `projects[]` from `projection_projects`.
3. Thread snapshot must include `checkpoints[]` from `projection_checkpoints`:
- `turnId: TurnId`
- `completedAt: IsoDateTime`
- `status`
- `files[]` (`path`, `kind`, `additions`, `deletions`)
- `checkpointRef: CheckpointRef`
- `assistantMessageId?: MessageId`
- `checkpointTurnCount: number`
4. Client does not require `listCheckpoints` RPC:
- checkpoint list comes from snapshot projections
- full diff text comes from `orchestration.getTurnDiff` backed by `checkpoint_diff_blobs`
5. Provider session identity is not a client routing key:
- client acts on `ThreadId`
- server resolves provider session internally via `projection_thread_sessions`
6. `snapshotSequence` is derived from `projection_state`:
- if snapshot depends on multiple projectors, use the minimum `lastAppliedSequence` across those projectors.
7. Event subscription handoff contract:
- client performs `getSnapshot` and reads `snapshotSequence`
- client subscribes/replays with `fromSequenceExclusive = snapshotSequence`
- server guarantees no gap between snapshot visibility and subsequent event stream from that sequence.

### 7.5 External Derived State (Non-Orchestration)

1. Current git/worktree state is not projected from orchestration events.
2. If persisted, it belongs in a separate git cache/read model (for example `git_state_cache`) owned by a git service.
3. Orchestration may embed git metadata only when captured as a domain fact (for example checkpoint metadata at turn completion).
4. Any RPC for current git status should be outside orchestration RPC (for example `git.getThreadState`).

### 7.6 Existing Repository Placement

1. `ProjectsRepository`
- Fits as projection/query access on top of `projection_projects` plus orchestration command dispatch for writes.
- Must not bypass command->event append path for mutations.

2. `CheckpointsRepository`
- Fits as projection/query access on top of `projection_checkpoints` plus `checkpoint_diff_blobs` (or git-service on-demand diff implementation).
- Represents the same concept as prior `turn_diff_summary`; canonical naming is `checkpoint`.
- Must not be an independent source of truth outside orchestration events.

3. `ProviderSessionsRepository`
- Fits as server-internal runtime persistence on top of `provider_session_runtime`, with domain-visible state projected into `projection_thread_sessions`.
- Not part of client RPC/domain aggregate boundary.
