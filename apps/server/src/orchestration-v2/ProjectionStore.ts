import type {
  OrchestrationV2ConversationMessage,
  OrchestrationV2DomainEvent,
  OrchestrationV2ProjectedTurnItem,
  OrchestrationV2ShellSnapshot,
  OrchestrationV2ShellThreadStatus,
  OrchestrationV2ThreadShell,
  OrchestrationV2ThreadProjection,
  OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import {
  OrchestrationV2AppThreadJson as OrchestrationV2AppThreadJsonSchema,
  OrchestrationV2CheckpointJson as OrchestrationV2CheckpointJsonSchema,
  OrchestrationV2CheckpointScopeJson as OrchestrationV2CheckpointScopeJsonSchema,
  OrchestrationV2ContextHandoffJson as OrchestrationV2ContextHandoffJsonSchema,
  OrchestrationV2ContextTransferJson as OrchestrationV2ContextTransferJsonSchema,
  OrchestrationV2ConversationMessageJson as OrchestrationV2ConversationMessageJsonSchema,
  OrchestrationV2ExecutionNodeJson as OrchestrationV2ExecutionNodeJsonSchema,
  OrchestrationV2PlanArtifact as OrchestrationV2PlanArtifactSchema,
  OrchestrationV2ProviderSessionJson as OrchestrationV2ProviderSessionJsonSchema,
  OrchestrationV2ProviderThreadJson as OrchestrationV2ProviderThreadJsonSchema,
  OrchestrationV2ProviderTurnJson as OrchestrationV2ProviderTurnJsonSchema,
  OrchestrationV2RunAttemptJson as OrchestrationV2RunAttemptJsonSchema,
  OrchestrationV2RunJson as OrchestrationV2RunJsonSchema,
  OrchestrationV2RuntimeRequestJson as OrchestrationV2RuntimeRequestJsonSchema,
  OrchestrationV2SubagentJson as OrchestrationV2SubagentJsonSchema,
  OrchestrationV2TurnItemJson as OrchestrationV2TurnItemJsonSchema,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import {
  isOrchestrationV2SupersededInterrupt,
  isOrchestrationV2TurnItemVisible,
} from "@t3tools/shared/orchestrationV2Timeline";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export class ProjectionStoreApplyEventError extends Schema.TaggedErrorClass<ProjectionStoreApplyEventError>()(
  "ProjectionStoreApplyEventError",
  {
    eventType: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to apply orchestration projection event ${this.eventType}.`;
  }
}

export class ProjectionStoreSetupError extends Schema.TaggedErrorClass<ProjectionStoreSetupError>()(
  "ProjectionStoreSetupError",
  {
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return "Failed to initialize orchestration projection store.";
  }
}

export class ProjectionStoreThreadNotFoundError extends Schema.TaggedErrorClass<ProjectionStoreThreadNotFoundError>()(
  "ProjectionStoreThreadNotFoundError",
  {
    threadId: ThreadId,
  },
) {
  override get message(): string {
    return `No orchestration projection exists for thread ${this.threadId}.`;
  }
}

export class ProjectionStoreReadError extends Schema.TaggedErrorClass<ProjectionStoreReadError>()(
  "ProjectionStoreReadError",
  {
    threadId: ThreadId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to read orchestration projection for thread ${this.threadId}.`;
  }
}

export const ProjectionStoreV2Error = Schema.Union([
  ProjectionStoreSetupError,
  ProjectionStoreApplyEventError,
  ProjectionStoreThreadNotFoundError,
  ProjectionStoreReadError,
]);
export type ProjectionStoreV2Error = typeof ProjectionStoreV2Error.Type;

export interface ProjectionStoreV2Shape {
  readonly apply: (
    event: OrchestrationV2DomainEvent,
  ) => Effect.Effect<void, ProjectionStoreV2Error>;
  readonly getShellSnapshot: () => Effect.Effect<
    OrchestrationV2ShellSnapshot,
    ProjectionStoreV2Error
  >;
  readonly getThreadProjection: (
    threadId: ThreadId,
  ) => Effect.Effect<OrchestrationV2ThreadProjection, ProjectionStoreV2Error>;
}

export class ProjectionStoreV2 extends Context.Service<ProjectionStoreV2, ProjectionStoreV2Shape>()(
  "t3/orchestration-v2/ProjectionStore/ProjectionStoreV2",
) {}

function upsertById<T extends { readonly id: string }>(items: ReadonlyArray<T>, next: T): Array<T> {
  const index = items.findIndex((item) => item.id === next.id);
  if (index === -1) {
    return [...items, next];
  }

  const updated = [...items];
  updated[index] = next;
  return updated;
}

export function emptyProjection(
  event: Extract<OrchestrationV2DomainEvent, { readonly type: "thread.created" }>,
): OrchestrationV2ThreadProjection {
  return {
    thread: event.payload,
    runs: [],
    attempts: [],
    nodes: [],
    subagents: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns: [],
    runtimeRequests: [],
    messages: [],
    plans: [],
    turnItems: [],
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems: [],
    updatedAt: event.occurredAt,
  };
}

export function applyToProjection(
  projection: OrchestrationV2ThreadProjection,
  event: OrchestrationV2DomainEvent,
): OrchestrationV2ThreadProjection {
  const base = {
    ...projection,
    updatedAt: event.occurredAt,
  };

  switch (event.type) {
    case "thread.created":
      return {
        ...base,
        thread: event.payload,
      };
    case "run.created":
    case "run.updated":
      return withLocalVisibleTurnItems({
        ...base,
        runs: upsertById(base.runs, event.payload),
      });
    case "run-attempt.created":
    case "run-attempt.updated":
      return withLocalVisibleTurnItems({
        ...base,
        attempts: upsertById(base.attempts, event.payload),
      });
    case "node.updated":
      return {
        ...base,
        nodes: upsertById(base.nodes, event.payload),
      };
    case "subagent.updated":
      return {
        ...base,
        subagents: upsertById(base.subagents, event.payload),
      };
    case "provider-session.updated":
      return {
        ...base,
        providerSessions: upsertById(base.providerSessions, event.payload),
      };
    case "provider-thread.updated":
      return {
        ...base,
        providerThreads: upsertById(base.providerThreads, event.payload),
      };
    case "provider-turn.updated":
      return {
        ...base,
        providerTurns: upsertById(base.providerTurns, event.payload),
      };
    case "runtime-request.updated":
      return {
        ...base,
        runtimeRequests: upsertById(base.runtimeRequests, event.payload),
      };
    case "message.updated":
      return {
        ...base,
        messages: upsertById(base.messages, event.payload),
      };
    case "turn-item.updated":
      return withLocalVisibleTurnItems({
        ...base,
        turnItems: upsertById(base.turnItems, event.payload),
      });
    case "plan.updated":
      return {
        ...base,
        plans: upsertById(base.plans, event.payload),
      };
    case "checkpoint-scope.created":
      return {
        ...base,
        checkpointScopes: upsertById(base.checkpointScopes, event.payload),
      };
    case "checkpoint.captured":
      return {
        ...base,
        checkpoints: upsertById(base.checkpoints, event.payload),
      };
    case "context-handoff.updated":
      return {
        ...base,
        contextHandoffs: upsertById(base.contextHandoffs, event.payload),
      };
    case "context-transfer.created":
    case "context-transfer.updated":
      return {
        ...base,
        contextTransfers: upsertById(base.contextTransfers, event.payload),
      };
  }
}

type PayloadRow = {
  readonly payload_json: string;
};

type ShellThreadRow = {
  readonly thread_id: string;
  readonly payload_json: string;
  readonly latest_run_id: string | null;
  readonly latest_run_status: string | null;
  readonly item_count: number;
};

type ShellRunRow = {
  readonly thread_id: string;
  readonly run_id: string;
  readonly ordinal: number;
};

type ShellRunItemCountRow = {
  readonly thread_id: string;
  readonly run_id: string;
  readonly item_count: number;
};

const encodeThreadPayload = Schema.encodeEffect(
  Schema.fromJsonString(OrchestrationV2AppThreadJsonSchema),
);
const encodeRunPayload = Schema.encodeEffect(Schema.fromJsonString(OrchestrationV2RunJsonSchema));
const encodeRunAttemptPayload = Schema.encodeEffect(
  Schema.fromJsonString(OrchestrationV2RunAttemptJsonSchema),
);
const encodeNodePayload = Schema.encodeEffect(
  Schema.fromJsonString(OrchestrationV2ExecutionNodeJsonSchema),
);
const encodeSubagentPayload = Schema.encodeEffect(
  Schema.fromJsonString(OrchestrationV2SubagentJsonSchema),
);
const encodeProviderSessionPayload = Schema.encodeEffect(
  Schema.fromJsonString(OrchestrationV2ProviderSessionJsonSchema),
);
const encodeProviderThreadPayload = Schema.encodeEffect(
  Schema.fromJsonString(OrchestrationV2ProviderThreadJsonSchema),
);
const encodeProviderTurnPayload = Schema.encodeEffect(
  Schema.fromJsonString(OrchestrationV2ProviderTurnJsonSchema),
);
const encodeRuntimeRequestPayload = Schema.encodeEffect(
  Schema.fromJsonString(OrchestrationV2RuntimeRequestJsonSchema),
);
const encodeMessagePayload = Schema.encodeEffect(
  Schema.fromJsonString(OrchestrationV2ConversationMessageJsonSchema),
);
const encodePlanPayload = Schema.encodeEffect(
  Schema.fromJsonString(OrchestrationV2PlanArtifactSchema),
);
const encodeTurnItemPayload = Schema.encodeEffect(
  Schema.fromJsonString(OrchestrationV2TurnItemJsonSchema),
);
const encodeCheckpointScopePayload = Schema.encodeEffect(
  Schema.fromJsonString(OrchestrationV2CheckpointScopeJsonSchema),
);
const encodeCheckpointPayload = Schema.encodeEffect(
  Schema.fromJsonString(OrchestrationV2CheckpointJsonSchema),
);
const encodeContextHandoffPayload = Schema.encodeEffect(
  Schema.fromJsonString(OrchestrationV2ContextHandoffJsonSchema),
);
const encodeContextTransferPayload = Schema.encodeEffect(
  Schema.fromJsonString(OrchestrationV2ContextTransferJsonSchema),
);

const decodeThreadPayload = (json: string) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(OrchestrationV2AppThreadJsonSchema))(json);
const decodeRunPayload = (json: string) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(OrchestrationV2RunJsonSchema))(json);
const decodeRunAttemptPayload = (json: string) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(OrchestrationV2RunAttemptJsonSchema))(json);
const decodeNodePayload = (json: string) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(OrchestrationV2ExecutionNodeJsonSchema))(json);
const decodeSubagentPayload = (json: string) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(OrchestrationV2SubagentJsonSchema))(json);
const decodeProviderSessionPayload = (json: string) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(OrchestrationV2ProviderSessionJsonSchema))(json);
const decodeProviderThreadPayload = (json: string) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(OrchestrationV2ProviderThreadJsonSchema))(json);
const decodeProviderTurnPayload = (json: string) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(OrchestrationV2ProviderTurnJsonSchema))(json);
const decodeRuntimeRequestPayload = (json: string) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(OrchestrationV2RuntimeRequestJsonSchema))(json);
const decodeMessagePayload = (json: string) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(OrchestrationV2ConversationMessageJsonSchema))(
    json,
  );
const decodePlanPayload = (json: string) =>
  Schema.decodeUnknownEffect(OrchestrationV2PlanArtifactSchema)(parseEncodedPayload(json));
const decodeTurnItemPayload = (json: string) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(OrchestrationV2TurnItemJsonSchema))(json);
const decodeCheckpointScopePayload = (json: string) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(OrchestrationV2CheckpointScopeJsonSchema))(json);
const decodeCheckpointPayload = (json: string) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(OrchestrationV2CheckpointJsonSchema))(json);
const decodeContextHandoffPayload = (json: string) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(OrchestrationV2ContextHandoffJsonSchema))(json);
const decodeContextTransferPayload = (json: string) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(OrchestrationV2ContextTransferJsonSchema))(json);

function parseEncodedPayload(json: string): Record<string, unknown> {
  return JSON.parse(json) as Record<string, unknown>;
}

function stringField(payload: Record<string, unknown>, field: string): string {
  const value = payload[field];
  return typeof value === "string" ? value : String(value);
}

function nullableStringField(payload: Record<string, unknown>, field: string): string | null {
  const value = payload[field];
  if (value === null || value === undefined) {
    return null;
  }
  return typeof value === "string" ? value : String(value);
}

function booleanInt(value: boolean): 0 | 1 {
  return value ? 1 : 0;
}

const decodeRows =
  <A, E>(decode: (json: string) => Effect.Effect<A, E>, threadId: ThreadId) =>
  (rows: ReadonlyArray<PayloadRow>): Effect.Effect<Array<A>, ProjectionStoreReadError> =>
    Effect.forEach(rows, (row) => decode(row.payload_json)).pipe(
      Effect.mapError(
        (cause) =>
          new ProjectionStoreReadError({
            threadId,
            cause,
          }),
      ),
    );

function messageIdForTurnItem(item: OrchestrationV2TurnItem): string | null {
  switch (item.type) {
    case "user_message":
    case "assistant_message":
      return item.messageId;
    default:
      return null;
  }
}

function sortMessagesByTurnItemOrder(
  messages: ReadonlyArray<OrchestrationV2ConversationMessage>,
  turnItems: ReadonlyArray<OrchestrationV2TurnItem>,
): Array<OrchestrationV2ConversationMessage> {
  const messageOrdinals = new Map<string, number>();
  for (const turnItem of turnItems) {
    const messageId = messageIdForTurnItem(turnItem);
    if (messageId === null) {
      continue;
    }
    const existing = messageOrdinals.get(messageId);
    if (existing === undefined || turnItem.ordinal < existing) {
      messageOrdinals.set(messageId, turnItem.ordinal);
    }
  }

  return messages.toSorted((left, right) => {
    const leftOrdinal = messageOrdinals.get(left.id) ?? Number.MAX_SAFE_INTEGER;
    const rightOrdinal = messageOrdinals.get(right.id) ?? Number.MAX_SAFE_INTEGER;
    if (leftOrdinal !== rightOrdinal) {
      return leftOrdinal - rightOrdinal;
    }

    const leftCreatedAt = DateTime.toEpochMillis(left.createdAt);
    const rightCreatedAt = DateTime.toEpochMillis(right.createdAt);
    if (leftCreatedAt !== rightCreatedAt) {
      return leftCreatedAt - rightCreatedAt;
    }

    return left.id.localeCompare(right.id);
  });
}

function activeLocalTurnItems(
  projection: OrchestrationV2ThreadProjection,
): Array<OrchestrationV2ProjectedTurnItem> {
  return projection.turnItems
    .filter((item) =>
      isOrchestrationV2TurnItemVisible({
        item,
        runs: projection.runs,
        attempts: projection.attempts,
      }),
    )
    .map((item, position) => ({
      position,
      visibility: "local" as const,
      sourceThreadId: item.threadId,
      sourceItemId: item.id,
      item,
    }));
}

function localVisibleTurnItems(
  projection: OrchestrationV2ThreadProjection,
): Array<OrchestrationV2ProjectedTurnItem> {
  return activeLocalTurnItems(projection);
}

function inheritedVisibleTurnItemsFromLocalItems(
  items: ReadonlyArray<OrchestrationV2TurnItem>,
): Array<Omit<OrchestrationV2ProjectedTurnItem, "position">> {
  return items.map((item) => ({
    visibility: "inherited" as const,
    sourceThreadId: item.threadId,
    sourceItemId: item.id,
    item,
  }));
}

function withLocalVisibleTurnItems(
  projection: OrchestrationV2ThreadProjection,
): OrchestrationV2ThreadProjection {
  return {
    ...projection,
    visibleTurnItems: localVisibleTurnItems(projection),
  };
}

function renumberVisibleTurnItems(
  rows: ReadonlyArray<Omit<OrchestrationV2ProjectedTurnItem, "position">>,
): Array<OrchestrationV2ProjectedTurnItem> {
  return rows.map((row, position) => ({ ...row, position }));
}

function makeForkMarkerTurnItem(input: {
  readonly targetProjection: OrchestrationV2ThreadProjection;
  readonly sourceThreadId: ThreadId;
  readonly sourceRunId: NonNullable<OrchestrationV2TurnItem["runId"]>;
}): OrchestrationV2TurnItem {
  const createdAt = input.targetProjection.thread.createdAt;
  return {
    id: TurnItemId.make(`turn-item:fork:${input.targetProjection.thread.id}`),
    threadId: input.targetProjection.thread.id,
    runId: null,
    nodeId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    status: "completed",
    title: "Forked from conversation",
    startedAt: null,
    completedAt: createdAt,
    updatedAt: createdAt,
    type: "fork",
    source: { type: "run", threadId: input.sourceThreadId, runId: input.sourceRunId },
    targetThreadId: input.targetProjection.thread.id,
  };
}

function visibleTurnItemsThroughRun(input: {
  readonly sourceProjection: OrchestrationV2ThreadProjection;
  readonly sourceRunId: NonNullable<OrchestrationV2TurnItem["runId"]>;
}): Array<Omit<OrchestrationV2ProjectedTurnItem, "position">> {
  const sourceRun = input.sourceProjection.runs.find((run) => run.id === input.sourceRunId);
  if (sourceRun === undefined) {
    return [];
  }

  const runOrdinalById = new Map(input.sourceProjection.runs.map((run) => [run.id, run.ordinal]));
  const inheritedPrefix = input.sourceProjection.visibleTurnItems
    .filter(
      (row) => row.item.threadId !== input.sourceProjection.thread.id || row.item.type === "fork",
    )
    .map((row) => ({
      visibility: "inherited" as const,
      sourceThreadId: row.sourceThreadId,
      sourceItemId: row.sourceItemId,
      item: row.item,
    }));
  const localPrefix = inheritedVisibleTurnItemsFromLocalItems(
    input.sourceProjection.turnItems.filter((item) => {
      if (
        isOrchestrationV2SupersededInterrupt({
          item,
          attempts: input.sourceProjection.attempts,
        })
      ) {
        return false;
      }
      if (item.runId === null) {
        return false;
      }
      const ordinal = runOrdinalById.get(item.runId);
      return ordinal !== undefined && ordinal <= sourceRun.ordinal;
    }),
  );

  return [...inheritedPrefix, ...localPrefix];
}

function buildVisibleTurnItems(input: {
  readonly projection: OrchestrationV2ThreadProjection;
  readonly sourceProjection: OrchestrationV2ThreadProjection | null;
}): Array<OrchestrationV2ProjectedTurnItem> {
  const forkedFrom = input.projection.thread.forkedFrom;
  if (forkedFrom?.type !== "run" || input.sourceProjection === null) {
    return localVisibleTurnItems(input.projection);
  }

  const inherited = visibleTurnItemsThroughRun({
    sourceProjection: input.sourceProjection,
    sourceRunId: forkedFrom.runId,
  });
  const markerItem = makeForkMarkerTurnItem({
    targetProjection: input.projection,
    sourceThreadId: forkedFrom.threadId,
    sourceRunId: forkedFrom.runId,
  });
  const local = activeLocalTurnItems(input.projection).map((row) => ({
    visibility: "local" as const,
    sourceThreadId: row.sourceThreadId,
    sourceItemId: row.sourceItemId,
    item: row.item,
  }));

  return renumberVisibleTurnItems([
    ...inherited,
    {
      visibility: "synthetic",
      sourceThreadId: forkedFrom.threadId,
      sourceItemId: markerItem.id,
      item: markerItem,
    },
    ...local,
  ]);
}

export function threadShellFromProjection(
  projection: OrchestrationV2ThreadProjection,
): OrchestrationV2ThreadShell {
  const latestRun = projection.runs.at(-1) ?? null;
  return {
    createdBy: projection.thread.createdBy,
    creationSource: projection.thread.creationSource,
    id: projection.thread.id,
    projectId: projection.thread.projectId,
    title: projection.thread.title,
    defaultProvider: projection.thread.defaultProvider,
    modelSelection: projection.thread.modelSelection,
    runtimeMode: projection.thread.runtimeMode,
    interactionMode: projection.thread.interactionMode,
    lineage: projection.thread.lineage,
    forkedFrom: projection.thread.forkedFrom,
    activeProviderThreadId: projection.thread.activeProviderThreadId,
    latestRunId: latestRun?.id ?? null,
    status: latestRun?.status ?? "idle",
    itemCount: activeLocalTurnItems(projection).length,
    visibleItemCount: projection.visibleTurnItems.length,
    createdAt: projection.thread.createdAt,
    updatedAt: projection.updatedAt,
  };
}

type ShellThreadState = {
  readonly thread: OrchestrationV2ThreadProjection["thread"];
  readonly latestRunId: RunId | null;
  readonly latestRunStatus: OrchestrationV2ShellThreadStatus;
  readonly itemCount: number;
  readonly updatedAt: OrchestrationV2ThreadProjection["updatedAt"];
  readonly runOrdinalById: ReadonlyMap<RunId, number>;
  readonly itemCountByRunId: ReadonlyMap<RunId, number>;
};

function shellStatusFromStoredRunStatus(status: string | null): OrchestrationV2ShellThreadStatus {
  switch (status) {
    case null:
      return "idle";
    case "queued":
    case "starting":
    case "running":
    case "waiting":
    case "completed":
    case "interrupted":
    case "failed":
    case "cancelled":
    case "rolled_back":
      return status;
    default:
      return "failed";
  }
}

function itemCountThroughRun(input: {
  readonly state: ShellThreadState;
  readonly runId: RunId;
}): number {
  const runOrdinal = input.state.runOrdinalById.get(input.runId);
  if (runOrdinal === undefined) {
    return 0;
  }

  let count = 0;
  for (const [runId, itemCount] of input.state.itemCountByRunId) {
    const itemRunOrdinal = input.state.runOrdinalById.get(runId);
    if (itemRunOrdinal !== undefined && itemRunOrdinal <= runOrdinal) {
      count += itemCount;
    }
  }
  return count;
}

function visibleItemCountForShell(input: {
  readonly threadId: ThreadId;
  readonly statesByThreadId: ReadonlyMap<ThreadId, ShellThreadState>;
  readonly seenThreadIds?: ReadonlySet<ThreadId>;
}): number {
  const state = input.statesByThreadId.get(input.threadId);
  if (state === undefined) {
    return 0;
  }

  const forkedFrom = state.thread.forkedFrom;
  if (forkedFrom?.type !== "run") {
    return state.itemCount;
  }

  const seenThreadIds = input.seenThreadIds ?? new Set<ThreadId>();
  if (seenThreadIds.has(state.thread.id)) {
    return state.itemCount;
  }

  const sourceState = input.statesByThreadId.get(forkedFrom.threadId);
  if (sourceState === undefined) {
    return state.itemCount;
  }

  const sourceForkedFrom = sourceState.thread.forkedFrom;
  const inheritedPrefixCount =
    sourceForkedFrom?.type === "run"
      ? visibleItemCountForShell({
          threadId: sourceState.thread.id,
          statesByThreadId: input.statesByThreadId,
          seenThreadIds: new Set([...seenThreadIds, state.thread.id]),
        }) - sourceState.itemCount
      : 0;

  return (
    inheritedPrefixCount +
    itemCountThroughRun({ state: sourceState, runId: forkedFrom.runId }) +
    1 +
    state.itemCount
  );
}

function shellFromState(input: {
  readonly state: ShellThreadState;
  readonly visibleItemCount: number;
}): OrchestrationV2ThreadShell {
  return {
    createdBy: input.state.thread.createdBy,
    creationSource: input.state.thread.creationSource,
    id: input.state.thread.id,
    projectId: input.state.thread.projectId,
    title: input.state.thread.title,
    defaultProvider: input.state.thread.defaultProvider,
    modelSelection: input.state.thread.modelSelection,
    runtimeMode: input.state.thread.runtimeMode,
    interactionMode: input.state.thread.interactionMode,
    lineage: input.state.thread.lineage,
    forkedFrom: input.state.thread.forkedFrom,
    activeProviderThreadId: input.state.thread.activeProviderThreadId,
    latestRunId: input.state.latestRunId,
    status: input.state.latestRunStatus,
    itemCount: input.state.itemCount,
    visibleItemCount: input.visibleItemCount,
    createdAt: input.state.thread.createdAt,
    updatedAt: input.state.updatedAt,
  };
}

export const layer: Layer.Layer<ProjectionStoreV2, never, SqlClient.SqlClient> = Layer.effect(
  ProjectionStoreV2,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const apply: ProjectionStoreV2Shape["apply"] = (event) =>
      Effect.gen(function* () {
        switch (event.type) {
          case "thread.created": {
            const payloadJson = yield* encodeThreadPayload(event.payload);
            const payload = parseEncodedPayload(payloadJson);
            yield* sql`
              INSERT INTO orchestration_v2_projection_threads (
                thread_id,
                project_id,
                title,
                default_provider,
                runtime_mode,
                interaction_mode,
                active_provider_thread_id,
                created_at,
                updated_at,
                archived_at,
                deleted_at,
                payload_json
              )
              VALUES (
                ${event.payload.id},
                ${event.payload.projectId},
                ${event.payload.title},
                ${event.payload.defaultProvider},
                ${event.payload.runtimeMode},
                ${event.payload.interactionMode},
                ${event.payload.activeProviderThreadId},
                ${stringField(payload, "createdAt")},
                ${stringField(payload, "updatedAt")},
                ${nullableStringField(payload, "archivedAt")},
                ${nullableStringField(payload, "deletedAt")},
                ${payloadJson}
              )
              ON CONFLICT(thread_id)
              DO UPDATE SET
                project_id = excluded.project_id,
                title = excluded.title,
                default_provider = excluded.default_provider,
                runtime_mode = excluded.runtime_mode,
                interaction_mode = excluded.interaction_mode,
                active_provider_thread_id = excluded.active_provider_thread_id,
                created_at = excluded.created_at,
                updated_at = excluded.updated_at,
                archived_at = excluded.archived_at,
                deleted_at = excluded.deleted_at,
                payload_json = excluded.payload_json
            `;
            break;
          }
          case "run.created":
          case "run.updated": {
            const payloadJson = yield* encodeRunPayload(event.payload);
            const payload = parseEncodedPayload(payloadJson);
            yield* sql`
              INSERT INTO orchestration_v2_projection_runs (
                run_id,
                thread_id,
                ordinal,
                provider,
                provider_thread_id,
                status,
                requested_at,
                completed_at,
                payload_json
              )
              VALUES (
                ${event.payload.id},
                ${event.payload.threadId},
                ${event.payload.ordinal},
                ${event.payload.provider},
                ${event.payload.providerThreadId},
                ${event.payload.status},
                ${stringField(payload, "requestedAt")},
                ${nullableStringField(payload, "completedAt")},
                ${payloadJson}
              )
              ON CONFLICT(run_id)
              DO UPDATE SET
                thread_id = excluded.thread_id,
                ordinal = excluded.ordinal,
                provider = excluded.provider,
                provider_thread_id = excluded.provider_thread_id,
                status = excluded.status,
                requested_at = excluded.requested_at,
                completed_at = excluded.completed_at,
                payload_json = excluded.payload_json
            `;
            break;
          }
          case "run-attempt.created":
          case "run-attempt.updated": {
            const payloadJson = yield* encodeRunAttemptPayload(event.payload);
            yield* sql`
              INSERT INTO orchestration_v2_projection_run_attempts (
                attempt_id,
                thread_id,
                run_id,
                attempt_ordinal,
                root_node_id,
                provider,
                provider_thread_id,
                provider_turn_id,
                status,
                payload_json
              )
              VALUES (
                ${event.payload.id},
                ${event.threadId},
                ${event.payload.runId},
                ${event.payload.attemptOrdinal},
                ${event.payload.rootNodeId},
                ${event.payload.provider},
                ${event.payload.providerThreadId},
                ${event.payload.providerTurnId},
                ${event.payload.status},
                ${payloadJson}
              )
              ON CONFLICT(attempt_id)
              DO UPDATE SET
                thread_id = excluded.thread_id,
                run_id = excluded.run_id,
                attempt_ordinal = excluded.attempt_ordinal,
                root_node_id = excluded.root_node_id,
                provider = excluded.provider,
                provider_thread_id = excluded.provider_thread_id,
                provider_turn_id = excluded.provider_turn_id,
                status = excluded.status,
                payload_json = excluded.payload_json
            `;
            break;
          }
          case "node.updated": {
            const payloadJson = yield* encodeNodePayload(event.payload);
            const payload = parseEncodedPayload(payloadJson);
            yield* sql`
              INSERT INTO orchestration_v2_projection_nodes (
                node_id,
                thread_id,
                run_id,
                parent_node_id,
                root_node_id,
                kind,
                status,
                provider_thread_id,
                provider_turn_id,
                runtime_request_id,
                checkpoint_scope_id,
                started_at,
                completed_at,
                payload_json
              )
              VALUES (
                ${event.payload.id},
                ${event.payload.threadId},
                ${event.payload.runId},
                ${event.payload.parentNodeId},
                ${event.payload.rootNodeId},
                ${event.payload.kind},
                ${event.payload.status},
                ${event.payload.providerThreadId},
                ${event.payload.providerTurnId},
                ${event.payload.runtimeRequestId},
                ${event.payload.checkpointScopeId},
                ${nullableStringField(payload, "startedAt")},
                ${nullableStringField(payload, "completedAt")},
                ${payloadJson}
              )
              ON CONFLICT(node_id)
              DO UPDATE SET
                thread_id = excluded.thread_id,
                run_id = excluded.run_id,
                parent_node_id = excluded.parent_node_id,
                root_node_id = excluded.root_node_id,
                kind = excluded.kind,
                status = excluded.status,
                provider_thread_id = excluded.provider_thread_id,
                provider_turn_id = excluded.provider_turn_id,
                runtime_request_id = excluded.runtime_request_id,
                checkpoint_scope_id = excluded.checkpoint_scope_id,
                started_at = excluded.started_at,
                completed_at = excluded.completed_at,
                payload_json = excluded.payload_json
            `;
            break;
          }
          case "subagent.updated": {
            const payloadJson = yield* encodeSubagentPayload(event.payload);
            const payload = parseEncodedPayload(payloadJson);
            yield* sql`
              INSERT INTO orchestration_v2_projection_subagents (
                subagent_id,
                thread_id,
                run_id,
                parent_node_id,
                provider,
                provider_thread_id,
                child_thread_id,
                origin,
                status,
                started_at,
                completed_at,
                updated_at,
                payload_json
              )
              VALUES (
                ${event.payload.id},
                ${event.payload.threadId},
                ${event.payload.runId},
                ${event.payload.parentNodeId},
                ${event.payload.provider},
                ${event.payload.providerThreadId},
                ${event.payload.childThreadId},
                ${event.payload.origin},
                ${event.payload.status},
                ${nullableStringField(payload, "startedAt")},
                ${nullableStringField(payload, "completedAt")},
                ${stringField(payload, "updatedAt")},
                ${payloadJson}
              )
              ON CONFLICT(subagent_id)
              DO UPDATE SET
                thread_id = excluded.thread_id,
                run_id = excluded.run_id,
                parent_node_id = excluded.parent_node_id,
                provider = excluded.provider,
                provider_thread_id = excluded.provider_thread_id,
                child_thread_id = excluded.child_thread_id,
                origin = excluded.origin,
                status = excluded.status,
                started_at = excluded.started_at,
                completed_at = excluded.completed_at,
                updated_at = excluded.updated_at,
                payload_json = excluded.payload_json
            `;
            break;
          }
          case "provider-session.updated": {
            const payloadJson = yield* encodeProviderSessionPayload(event.payload);
            const payload = parseEncodedPayload(payloadJson);
            yield* sql`
              INSERT INTO orchestration_v2_projection_provider_sessions (
                provider_session_id,
                thread_id,
                provider,
                status,
                model,
                updated_at,
                payload_json
              )
              VALUES (
                ${event.payload.id},
                ${event.threadId},
                ${event.payload.provider},
                ${event.payload.status},
                ${event.payload.model},
                ${stringField(payload, "updatedAt")},
                ${payloadJson}
              )
              ON CONFLICT(provider_session_id)
              DO UPDATE SET
                thread_id = excluded.thread_id,
                provider = excluded.provider,
                status = excluded.status,
                model = excluded.model,
                updated_at = excluded.updated_at,
                payload_json = excluded.payload_json
            `;
            break;
          }
          case "provider-thread.updated": {
            const payloadJson = yield* encodeProviderThreadPayload(event.payload);
            const payload = parseEncodedPayload(payloadJson);
            yield* sql`
              INSERT INTO orchestration_v2_projection_provider_threads (
                provider_thread_id,
                thread_id,
                owner_node_id,
                provider,
                provider_session_id,
                status,
                first_run_ordinal,
                last_run_ordinal,
                updated_at,
                payload_json
              )
              VALUES (
                ${event.payload.id},
                ${event.payload.appThreadId},
                ${event.payload.ownerNodeId},
                ${event.payload.provider},
                ${event.payload.providerSessionId},
                ${event.payload.status},
                ${event.payload.firstRunOrdinal},
                ${event.payload.lastRunOrdinal},
                ${stringField(payload, "updatedAt")},
                ${payloadJson}
              )
              ON CONFLICT(provider_thread_id)
              DO UPDATE SET
                thread_id = excluded.thread_id,
                owner_node_id = excluded.owner_node_id,
                provider = excluded.provider,
                provider_session_id = excluded.provider_session_id,
                status = excluded.status,
                first_run_ordinal = excluded.first_run_ordinal,
                last_run_ordinal = excluded.last_run_ordinal,
                updated_at = excluded.updated_at,
                payload_json = excluded.payload_json
            `;
            if (event.payload.appThreadId !== null) {
              const threadRows = yield* sql<PayloadRow>`
                SELECT payload_json
                FROM orchestration_v2_projection_threads
                WHERE thread_id = ${event.payload.appThreadId}
                LIMIT 1
              `;
              const threadRow = threadRows[0];
              if (threadRow !== undefined) {
                const thread = yield* decodeThreadPayload(threadRow.payload_json);
                const updatedThread = {
                  ...thread,
                  activeProviderThreadId: event.payload.id,
                  updatedAt: event.payload.updatedAt,
                };
                const updatedThreadPayloadJson = yield* encodeThreadPayload(updatedThread);
                yield* sql`
                  UPDATE orchestration_v2_projection_threads
                  SET
                    active_provider_thread_id = ${event.payload.id},
                    updated_at = ${stringField(parseEncodedPayload(updatedThreadPayloadJson), "updatedAt")},
                    payload_json = ${updatedThreadPayloadJson}
                  WHERE thread_id = ${event.payload.appThreadId}
                `;
              }
            }
            break;
          }
          case "provider-turn.updated": {
            const payloadJson = yield* encodeProviderTurnPayload(event.payload);
            const payload = parseEncodedPayload(payloadJson);
            yield* sql`
              INSERT INTO orchestration_v2_projection_provider_turns (
                provider_turn_id,
                thread_id,
                provider_thread_id,
                node_id,
                run_attempt_id,
                ordinal,
                status,
                started_at,
                completed_at,
                payload_json
              )
              VALUES (
                ${event.payload.id},
                ${event.threadId},
                ${event.payload.providerThreadId},
                ${event.payload.nodeId},
                ${event.payload.runAttemptId},
                ${event.payload.ordinal},
                ${event.payload.status},
                ${nullableStringField(payload, "startedAt")},
                ${nullableStringField(payload, "completedAt")},
                ${payloadJson}
              )
              ON CONFLICT(provider_turn_id)
              DO UPDATE SET
                thread_id = excluded.thread_id,
                provider_thread_id = excluded.provider_thread_id,
                node_id = excluded.node_id,
                run_attempt_id = excluded.run_attempt_id,
                ordinal = excluded.ordinal,
                status = excluded.status,
                started_at = excluded.started_at,
                completed_at = excluded.completed_at,
                payload_json = excluded.payload_json
            `;
            break;
          }
          case "runtime-request.updated": {
            const payloadJson = yield* encodeRuntimeRequestPayload(event.payload);
            const payload = parseEncodedPayload(payloadJson);
            yield* sql`
              INSERT INTO orchestration_v2_projection_runtime_requests (
                runtime_request_id,
                thread_id,
                node_id,
                provider_turn_id,
                kind,
                status,
                created_at,
                resolved_at,
                payload_json
              )
              VALUES (
                ${event.payload.id},
                ${event.threadId},
                ${event.payload.nodeId},
                ${event.payload.providerTurnId},
                ${event.payload.kind},
                ${event.payload.status},
                ${stringField(payload, "createdAt")},
                ${nullableStringField(payload, "resolvedAt")},
                ${payloadJson}
              )
              ON CONFLICT(runtime_request_id)
              DO UPDATE SET
                thread_id = excluded.thread_id,
                node_id = excluded.node_id,
                provider_turn_id = excluded.provider_turn_id,
                kind = excluded.kind,
                status = excluded.status,
                created_at = excluded.created_at,
                resolved_at = excluded.resolved_at,
                payload_json = excluded.payload_json
            `;
            break;
          }
          case "message.updated": {
            const payloadJson = yield* encodeMessagePayload(event.payload);
            const payload = parseEncodedPayload(payloadJson);
            yield* sql`
              INSERT INTO orchestration_v2_projection_messages (
                message_id,
                thread_id,
                run_id,
                node_id,
                role,
                streaming,
                created_at,
                updated_at,
                payload_json
              )
              VALUES (
                ${event.payload.id},
                ${event.payload.threadId},
                ${event.payload.runId},
                ${event.payload.nodeId},
                ${event.payload.role},
                ${booleanInt(event.payload.streaming)},
                ${stringField(payload, "createdAt")},
                ${stringField(payload, "updatedAt")},
                ${payloadJson}
              )
              ON CONFLICT(message_id)
              DO UPDATE SET
                thread_id = excluded.thread_id,
                run_id = excluded.run_id,
                node_id = excluded.node_id,
                role = excluded.role,
                streaming = excluded.streaming,
                created_at = excluded.created_at,
                updated_at = excluded.updated_at,
                payload_json = excluded.payload_json
            `;
            break;
          }
          case "plan.updated": {
            const payloadJson = yield* encodePlanPayload(event.payload);
            yield* sql`
              INSERT INTO orchestration_v2_projection_plans (
                plan_id,
                thread_id,
                run_id,
                node_id,
                kind,
                status,
                payload_json
              )
              VALUES (
                ${event.payload.id},
                ${event.payload.threadId},
                ${event.payload.runId},
                ${event.payload.nodeId},
                ${event.payload.kind},
                ${event.payload.status},
                ${payloadJson}
              )
              ON CONFLICT(plan_id)
              DO UPDATE SET
                thread_id = excluded.thread_id,
                run_id = excluded.run_id,
                node_id = excluded.node_id,
                kind = excluded.kind,
                status = excluded.status,
                payload_json = excluded.payload_json
            `;
            break;
          }
          case "turn-item.updated": {
            const payloadJson = yield* encodeTurnItemPayload(event.payload);
            const payload = parseEncodedPayload(payloadJson);
            yield* sql`
              INSERT INTO orchestration_v2_projection_turn_items (
                turn_item_id,
                thread_id,
                run_id,
                node_id,
                provider_thread_id,
                provider_turn_id,
                parent_item_id,
                ordinal,
                type,
                status,
                updated_at,
                payload_json
              )
              VALUES (
                ${event.payload.id},
                ${event.payload.threadId},
                ${event.payload.runId},
                ${event.payload.nodeId},
                ${event.payload.providerThreadId},
                ${event.payload.providerTurnId},
                ${event.payload.parentItemId},
                ${event.payload.ordinal},
                ${event.payload.type},
                ${event.payload.status},
                ${stringField(payload, "updatedAt")},
                ${payloadJson}
              )
              ON CONFLICT(turn_item_id)
              DO UPDATE SET
                thread_id = excluded.thread_id,
                run_id = excluded.run_id,
                node_id = excluded.node_id,
                provider_thread_id = excluded.provider_thread_id,
                provider_turn_id = excluded.provider_turn_id,
                parent_item_id = excluded.parent_item_id,
                ordinal = excluded.ordinal,
                type = excluded.type,
                status = excluded.status,
                updated_at = excluded.updated_at,
                payload_json = excluded.payload_json
            `;
            break;
          }
          case "checkpoint-scope.created": {
            const payloadJson = yield* encodeCheckpointScopePayload(event.payload);
            const payload = parseEncodedPayload(payloadJson);
            yield* sql`
              INSERT INTO orchestration_v2_projection_checkpoint_scopes (
                scope_id,
                thread_id,
                run_id,
                node_id,
                parent_scope_id,
                provider_thread_id,
                kind,
                ordinal_within_parent,
                advances_app_run_count,
                created_at,
                payload_json
              )
              VALUES (
                ${event.payload.id},
                ${event.payload.threadId},
                ${event.payload.runId},
                ${event.payload.nodeId},
                ${event.payload.parentScopeId},
                ${event.payload.providerThreadId},
                ${event.payload.kind},
                ${event.payload.ordinalWithinParent},
                ${booleanInt(event.payload.advancesAppRunCount)},
                ${stringField(payload, "createdAt")},
                ${payloadJson}
              )
              ON CONFLICT(scope_id)
              DO UPDATE SET
                thread_id = excluded.thread_id,
                run_id = excluded.run_id,
                node_id = excluded.node_id,
                parent_scope_id = excluded.parent_scope_id,
                provider_thread_id = excluded.provider_thread_id,
                kind = excluded.kind,
                ordinal_within_parent = excluded.ordinal_within_parent,
                advances_app_run_count = excluded.advances_app_run_count,
                created_at = excluded.created_at,
                payload_json = excluded.payload_json
            `;
            break;
          }
          case "checkpoint.captured": {
            const payloadJson = yield* encodeCheckpointPayload(event.payload);
            const payload = parseEncodedPayload(payloadJson);
            yield* sql`
              INSERT INTO orchestration_v2_projection_checkpoints (
                checkpoint_id,
                thread_id,
                scope_id,
                run_id,
                node_id,
                parent_checkpoint_id,
                ordinal_within_scope,
                app_run_ordinal,
                status,
                captured_at,
                payload_json
              )
              VALUES (
                ${event.payload.id},
                ${event.payload.threadId},
                ${event.payload.scopeId},
                ${event.payload.runId},
                ${event.payload.nodeId},
                ${event.payload.parentCheckpointId},
                ${event.payload.ordinalWithinScope},
                ${event.payload.appRunOrdinal},
                ${event.payload.status},
                ${stringField(payload, "capturedAt")},
                ${payloadJson}
              )
              ON CONFLICT(checkpoint_id)
              DO UPDATE SET
                thread_id = excluded.thread_id,
                scope_id = excluded.scope_id,
                run_id = excluded.run_id,
                node_id = excluded.node_id,
                parent_checkpoint_id = excluded.parent_checkpoint_id,
                ordinal_within_scope = excluded.ordinal_within_scope,
                app_run_ordinal = excluded.app_run_ordinal,
                status = excluded.status,
                captured_at = excluded.captured_at,
                payload_json = excluded.payload_json
            `;
            break;
          }
          case "context-handoff.updated": {
            const payloadJson = yield* encodeContextHandoffPayload(event.payload);
            const payload = parseEncodedPayload(payloadJson);
            yield* sql`
              INSERT INTO orchestration_v2_projection_context_handoffs (
                context_handoff_id,
                thread_id,
                target_run_id,
                to_provider_thread_id,
                strategy,
                status,
                updated_at,
                payload_json
              )
              VALUES (
                ${event.payload.id},
                ${event.payload.threadId},
                ${event.payload.targetRunId},
                ${event.payload.toProviderThreadId},
                ${event.payload.strategy},
                ${event.payload.status},
                ${stringField(payload, "updatedAt")},
                ${payloadJson}
              )
              ON CONFLICT(context_handoff_id)
              DO UPDATE SET
                thread_id = excluded.thread_id,
                target_run_id = excluded.target_run_id,
                to_provider_thread_id = excluded.to_provider_thread_id,
                strategy = excluded.strategy,
                status = excluded.status,
                updated_at = excluded.updated_at,
                payload_json = excluded.payload_json
            `;
            break;
          }
          case "context-transfer.created":
          case "context-transfer.updated": {
            const payloadJson = yield* encodeContextTransferPayload(event.payload);
            const payload = parseEncodedPayload(payloadJson);
            yield* sql`
              INSERT INTO orchestration_v2_projection_context_transfers (
                context_transfer_id,
                source_thread_id,
                target_thread_id,
                target_run_id,
                type,
                status,
                source_provider,
                target_provider,
                updated_at,
                payload_json
              )
              VALUES (
                ${event.payload.id},
                ${event.payload.sourceThreadId},
                ${event.payload.targetThreadId},
                ${event.payload.targetRunId},
                ${event.payload.type},
                ${event.payload.status},
                ${event.payload.sourceProvider},
                ${event.payload.targetProvider},
                ${stringField(payload, "updatedAt")},
                ${payloadJson}
              )
              ON CONFLICT(context_transfer_id)
              DO UPDATE SET
                source_thread_id = excluded.source_thread_id,
                target_thread_id = excluded.target_thread_id,
                target_run_id = excluded.target_run_id,
                type = excluded.type,
                status = excluded.status,
                source_provider = excluded.source_provider,
                target_provider = excluded.target_provider,
                updated_at = excluded.updated_at,
                payload_json = excluded.payload_json
            `;
            break;
          }
        }
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProjectionStoreApplyEventError({
              eventType: event.type,
              cause,
            }),
        ),
      );

    const readCanonicalProjection: ProjectionStoreV2Shape["getThreadProjection"] = (threadId) =>
      Effect.gen(function* () {
        const threadRows = yield* sql<PayloadRow>`
          SELECT payload_json
          FROM orchestration_v2_projection_threads
          WHERE thread_id = ${threadId}
          LIMIT 1
        `;
        const threadRow = threadRows[0];
        if (!threadRow) {
          return yield* new ProjectionStoreThreadNotFoundError({ threadId });
        }

        const [
          thread,
          runRows,
          attemptRows,
          nodeRows,
          subagentRows,
          providerSessionRows,
          providerThreadRows,
          providerTurnRows,
          runtimeRequestRows,
          messageRows,
          planRows,
          turnItemRows,
          checkpointScopeRows,
          checkpointRows,
          contextHandoffRows,
          contextTransferRows,
        ] = yield* Effect.all([
          decodeThreadPayload(threadRow.payload_json),
          sql<PayloadRow>`
            SELECT payload_json
            FROM orchestration_v2_projection_runs
            WHERE thread_id = ${threadId}
            ORDER BY ordinal ASC
          `,
          sql<PayloadRow>`
            SELECT payload_json
            FROM orchestration_v2_projection_run_attempts
            WHERE thread_id = ${threadId}
            ORDER BY run_id ASC, attempt_ordinal ASC
          `,
          sql<PayloadRow>`
            SELECT payload_json
            FROM orchestration_v2_projection_nodes
            WHERE thread_id = ${threadId}
            ORDER BY COALESCE(started_at, ''), node_id ASC
          `,
          sql<PayloadRow>`
            SELECT payload_json
            FROM orchestration_v2_projection_subagents
            WHERE thread_id = ${threadId}
            ORDER BY COALESCE(started_at, ''), subagent_id ASC
          `,
          sql<PayloadRow>`
            SELECT payload_json
            FROM orchestration_v2_projection_provider_sessions
            WHERE thread_id = ${threadId}
            ORDER BY updated_at ASC, provider_session_id ASC
          `,
          sql<PayloadRow>`
            SELECT payload_json
            FROM orchestration_v2_projection_provider_threads
            WHERE thread_id = ${threadId}
               OR owner_node_id IN (
                 SELECT node_id
                 FROM orchestration_v2_projection_nodes
                 WHERE thread_id = ${threadId}
               )
               OR provider_thread_id IN (
                 SELECT provider_thread_id
                 FROM orchestration_v2_projection_subagents
                 WHERE thread_id = ${threadId}
                   AND provider_thread_id IS NOT NULL
               )
            ORDER BY COALESCE(first_run_ordinal, 0), provider_thread_id ASC
          `,
          sql<PayloadRow>`
            SELECT payload_json
            FROM orchestration_v2_projection_provider_turns
            WHERE thread_id = ${threadId}
            ORDER BY provider_thread_id ASC, ordinal ASC
          `,
          sql<PayloadRow>`
            SELECT payload_json
            FROM orchestration_v2_projection_runtime_requests
            WHERE thread_id = ${threadId}
            ORDER BY created_at ASC, runtime_request_id ASC
          `,
          sql<PayloadRow>`
            SELECT payload_json
            FROM orchestration_v2_projection_messages
            WHERE thread_id = ${threadId}
            ORDER BY created_at ASC, message_id ASC
          `,
          sql<PayloadRow>`
            SELECT payload_json
            FROM orchestration_v2_projection_plans
            WHERE thread_id = ${threadId}
            ORDER BY plan_id ASC
          `,
          sql<PayloadRow>`
            SELECT payload_json
            FROM orchestration_v2_projection_turn_items
            WHERE thread_id = ${threadId}
            ORDER BY ordinal ASC, turn_item_id ASC
          `,
          sql<PayloadRow>`
            SELECT payload_json
            FROM orchestration_v2_projection_checkpoint_scopes
            WHERE thread_id = ${threadId}
            ORDER BY ordinal_within_parent ASC, scope_id ASC
          `,
          sql<PayloadRow>`
            SELECT payload_json
            FROM orchestration_v2_projection_checkpoints
            WHERE thread_id = ${threadId}
            ORDER BY scope_id ASC, ordinal_within_scope ASC
          `,
          sql<PayloadRow>`
            SELECT payload_json
            FROM orchestration_v2_projection_context_handoffs
            WHERE thread_id = ${threadId}
            ORDER BY updated_at ASC, context_handoff_id ASC
          `,
          sql<PayloadRow>`
            SELECT payload_json
            FROM orchestration_v2_projection_context_transfers
            WHERE source_thread_id = ${threadId} OR target_thread_id = ${threadId}
            ORDER BY updated_at ASC, context_transfer_id ASC
          `,
        ]);

        const [
          runs,
          attempts,
          nodes,
          subagents,
          providerSessions,
          providerThreads,
          providerTurns,
          runtimeRequests,
          messages,
          plans,
          turnItems,
          checkpointScopes,
          checkpoints,
          contextHandoffs,
          contextTransfers,
        ] = yield* Effect.all([
          decodeRows(decodeRunPayload, threadId)(runRows),
          decodeRows(decodeRunAttemptPayload, threadId)(attemptRows),
          decodeRows(decodeNodePayload, threadId)(nodeRows),
          decodeRows(decodeSubagentPayload, threadId)(subagentRows),
          decodeRows(decodeProviderSessionPayload, threadId)(providerSessionRows),
          decodeRows(decodeProviderThreadPayload, threadId)(providerThreadRows),
          decodeRows(decodeProviderTurnPayload, threadId)(providerTurnRows),
          decodeRows(decodeRuntimeRequestPayload, threadId)(runtimeRequestRows),
          decodeRows(decodeMessagePayload, threadId)(messageRows),
          decodeRows(decodePlanPayload, threadId)(planRows),
          decodeRows(decodeTurnItemPayload, threadId)(turnItemRows),
          decodeRows(decodeCheckpointScopePayload, threadId)(checkpointScopeRows),
          decodeRows(decodeCheckpointPayload, threadId)(checkpointRows),
          decodeRows(decodeContextHandoffPayload, threadId)(contextHandoffRows),
          decodeRows(decodeContextTransferPayload, threadId)(contextTransferRows),
        ]);
        const orderedMessages = sortMessagesByTurnItemOrder(messages, turnItems);
        const projection = {
          thread,
          runs,
          attempts,
          nodes,
          subagents,
          providerSessions,
          providerThreads,
          providerTurns,
          runtimeRequests,
          messages: orderedMessages,
          plans,
          turnItems,
          checkpointScopes,
          checkpoints,
          contextHandoffs,
          contextTransfers,
          visibleTurnItems: [],
          updatedAt: thread.updatedAt,
        } satisfies OrchestrationV2ThreadProjection;
        return withLocalVisibleTurnItems(projection);
      }).pipe(
        Effect.mapError((cause) =>
          Schema.is(ProjectionStoreThreadNotFoundError)(cause)
            ? cause
            : new ProjectionStoreReadError({
                threadId,
                cause,
              }),
        ),
      );

    const readProjection = (
      threadId: ThreadId,
      seenThreadIds: ReadonlySet<ThreadId>,
    ): Effect.Effect<OrchestrationV2ThreadProjection, ProjectionStoreV2Error> =>
      Effect.gen(function* () {
        const projection = yield* readCanonicalProjection(threadId);
        const forkedFrom = projection.thread.forkedFrom;
        if (forkedFrom?.type !== "run" || seenThreadIds.has(forkedFrom.threadId)) {
          return withLocalVisibleTurnItems(projection);
        }

        const sourceProjection = yield* readProjection(
          forkedFrom.threadId,
          new Set([...seenThreadIds, threadId]),
        );
        return {
          ...projection,
          visibleTurnItems: buildVisibleTurnItems({
            projection,
            sourceProjection,
          }),
        };
      });

    const getThreadProjection: ProjectionStoreV2Shape["getThreadProjection"] = (threadId) =>
      readProjection(threadId, new Set());

    const getShellSnapshot: ProjectionStoreV2Shape["getShellSnapshot"] = () =>
      Effect.gen(function* () {
        const [threadRows, runRows, itemCountRows] = yield* Effect.all([
          sql<ShellThreadRow>`
            SELECT
              t.thread_id,
              t.payload_json,
              (
                SELECT r.run_id
                FROM orchestration_v2_projection_runs r
                WHERE r.thread_id = t.thread_id
                ORDER BY r.ordinal DESC, r.run_id DESC
                LIMIT 1
              ) AS latest_run_id,
              (
                SELECT r.status
                FROM orchestration_v2_projection_runs r
                WHERE r.thread_id = t.thread_id
                ORDER BY r.ordinal DESC, r.run_id DESC
                LIMIT 1
              ) AS latest_run_status,
              (
                SELECT COUNT(*)
                FROM orchestration_v2_projection_turn_items i
                LEFT JOIN orchestration_v2_projection_runs r
                  ON r.run_id = i.run_id
                WHERE i.thread_id = t.thread_id
                  AND (i.run_id IS NULL OR r.status <> 'rolled_back')
              ) AS item_count
            FROM orchestration_v2_projection_threads t
            WHERE t.deleted_at IS NULL
            ORDER BY t.updated_at ASC, t.thread_id ASC
          `,
          sql<ShellRunRow>`
            SELECT thread_id, run_id, ordinal
            FROM orchestration_v2_projection_runs
          `,
          sql<ShellRunItemCountRow>`
            SELECT thread_id, run_id, COUNT(*) AS item_count
            FROM orchestration_v2_projection_turn_items
            WHERE run_id IS NOT NULL
            GROUP BY thread_id, run_id
          `,
        ]);

        const runOrdinalsByThreadId = new Map<ThreadId, Map<RunId, number>>();
        for (const row of runRows) {
          const threadId = ThreadId.make(row.thread_id);
          const runId = RunId.make(row.run_id);
          const existing = runOrdinalsByThreadId.get(threadId) ?? new Map<RunId, number>();
          existing.set(runId, row.ordinal);
          runOrdinalsByThreadId.set(threadId, existing);
        }

        const itemCountsByThreadId = new Map<ThreadId, Map<RunId, number>>();
        for (const row of itemCountRows) {
          const threadId = ThreadId.make(row.thread_id);
          const runId = RunId.make(row.run_id);
          const existing = itemCountsByThreadId.get(threadId) ?? new Map<RunId, number>();
          existing.set(runId, row.item_count);
          itemCountsByThreadId.set(threadId, existing);
        }

        const states = yield* Effect.forEach(threadRows, (row) =>
          decodeThreadPayload(row.payload_json).pipe(
            Effect.map(
              (thread): ShellThreadState => ({
                thread,
                latestRunId: row.latest_run_id === null ? null : RunId.make(row.latest_run_id),
                latestRunStatus: shellStatusFromStoredRunStatus(row.latest_run_status),
                itemCount: row.item_count,
                updatedAt: thread.updatedAt,
                runOrdinalById:
                  runOrdinalsByThreadId.get(ThreadId.make(row.thread_id)) ?? new Map(),
                itemCountByRunId:
                  itemCountsByThreadId.get(ThreadId.make(row.thread_id)) ?? new Map(),
              }),
            ),
          ),
        );
        const statesByThreadId = new Map(states.map((state) => [state.thread.id, state]));

        return {
          threads: states.map((state) =>
            shellFromState({
              state,
              visibleItemCount: visibleItemCountForShell({
                threadId: state.thread.id,
                statesByThreadId,
              }),
            }),
          ),
        };
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProjectionStoreReadError({
              threadId: ThreadId.make("thread:shell"),
              cause,
            }),
        ),
      );

    return {
      apply,
      getShellSnapshot,
      getThreadProjection,
    } satisfies ProjectionStoreV2Shape;
  }),
);

export const layerMemory: Layer.Layer<ProjectionStoreV2> = Layer.effect(
  ProjectionStoreV2,
  Effect.gen(function* () {
    const projections = yield* Ref.make(new Map<ThreadId, OrchestrationV2ThreadProjection>());

    const service: ProjectionStoreV2Shape = {
      apply: (event) =>
        Effect.gen(function* () {
          const result = yield* Ref.modify(projections, (existing) => {
            const next = new Map(existing);

            if (event.type === "thread.created" && !next.has(event.threadId)) {
              next.set(event.threadId, emptyProjection(event));
              return [undefined, next] as const;
            }

            const projection = next.get(event.threadId);
            if (!projection) {
              return [
                new ProjectionStoreThreadNotFoundError({ threadId: event.threadId }),
                existing,
              ] as const;
            }

            next.set(event.threadId, applyToProjection(projection, event));
            return [undefined, next] as const;
          });

          if (result) {
            return yield* result;
          }
        }),
      getShellSnapshot: () =>
        Effect.gen(function* () {
          const existing = yield* Ref.get(projections);
          const shells = yield* Effect.forEach(
            [...existing.keys()].toSorted((left, right) =>
              String(left).localeCompare(String(right)),
            ),
            (threadId) =>
              service.getThreadProjection(threadId).pipe(Effect.map(threadShellFromProjection)),
          );
          return { threads: shells };
        }),
      getThreadProjection: (threadId) =>
        Effect.gen(function* () {
          const existing = yield* Ref.get(projections);
          const readProjection = (
            targetThreadId: ThreadId,
            seenThreadIds: ReadonlySet<ThreadId>,
          ): OrchestrationV2ThreadProjection | null => {
            const projection = existing.get(targetThreadId);
            if (!projection) {
              return null;
            }
            const forkedFrom = projection.thread.forkedFrom;
            if (forkedFrom?.type !== "run" || seenThreadIds.has(forkedFrom.threadId)) {
              return withLocalVisibleTurnItems(projection);
            }
            const sourceProjection = readProjection(
              forkedFrom.threadId,
              new Set([...seenThreadIds, targetThreadId]),
            );
            return {
              ...projection,
              visibleTurnItems: buildVisibleTurnItems({
                projection,
                sourceProjection,
              }),
            };
          };
          const projection = readProjection(threadId, new Set());
          if (!projection) {
            return yield* new ProjectionStoreThreadNotFoundError({ threadId });
          }
          return projection;
        }),
    };

    return service;
  }),
);
