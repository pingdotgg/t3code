// @effect-diagnostics nodeBuiltinImport:off -- fixtures use Node builtins
import * as NodeSqlite from "node:sqlite";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  CommandId,
  ContextTransferId,
  EventId,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Scheduler from "effect/Scheduler";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import { vi } from "vite-plus/test";
import * as ServerConfig from "../config.ts";
import * as DatabaseStorage from "../persistence/DatabaseStorage.ts";
import * as ServerSettings from "../serverSettings.ts";
import { LIVE_STREAM_MAX_ITEMS, LiveStreamBufferError } from "./LiveStreamBudget.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProjectionMaintenance from "./ProjectionMaintenance.ts";
import * as ProjectionReplay from "./testkit/ProjectionReplay.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProviderRuntimeRecovery from "./ProviderRuntimeRecoveryService.ts";
import * as TurnItemPositionStore from "./TurnItemPositionStore.ts";

export const isLiveStreamBufferError = Schema.is(LiveStreamBufferError);

export const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

export const layerDatabase = SqlitePersistence.layerMemory;

export const layerEventStoreProvided = EventStore.layer.pipe(Layer.provideMerge(layerDatabase));

export const layerProjectionStoreProvided = ProjectionStore.layer.pipe(
  Layer.provideMerge(layerDatabase),
);

export const layerStoresProvided = Layer.mergeAll(
  layerDatabase,
  layerEventStoreProvided,
  layerProjectionStoreProvided,
);

export const layerEventSinkProvided = EventSink.layer.pipe(Layer.provide(layerStoresProvided));

export const layerEffectOutboxProvided = EffectOutbox.layer.pipe(Layer.provide(layerDatabase));

export const layerCommandReceiptStoreProvided = CommandReceiptStore.layer.pipe(
  Layer.provide(layerDatabase),
);

export const layerIsolatedOutbox = Layer.fresh(
  EffectOutbox.layer.pipe(Layer.provideMerge(layerDatabase)),
);

export const layerProjectionMaintenanceProvided = ProjectionMaintenance.layer.pipe(
  Layer.provide(layerDatabase),
);

export const layerProjectionReplayProvided = ProjectionReplay.layer.pipe(
  Layer.provide(layerStoresProvided),
);

export const layerTest = Layer.mergeAll(
  layerStoresProvided,
  layerEventSinkProvided,
  layerEffectOutboxProvided,
  layerCommandReceiptStoreProvided,
  IdAllocator.layer,
  layerProjectionMaintenanceProvided,
  layerProjectionReplayProvided,
);

export const providerInstanceId = ProviderInstanceId.make("codex");

export const providerDriver = ProviderDriverKind.make("codex");

export const modelSelection = {
  instanceId: providerInstanceId,
  model: "gpt-5.4",
} satisfies ModelSelection;

export function makeThread(threadId: ThreadId, now: DateTime.Utc): OrchestrationV2AppThread {
  return {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId: ProjectId.make(`project:${threadId}`),
    title: `Thread ${threadId}`,
    providerInstanceId,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: threadId,
    },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

export function threadCreatedEvent(input: {
  readonly id: string;
  readonly thread: OrchestrationV2AppThread;
  readonly now: DateTime.Utc;
}): OrchestrationV2DomainEvent {
  return {
    id: EventId.make(input.id),
    type: "thread.created",
    threadId: input.thread.id,
    providerInstanceId,
    occurredAt: input.now,
    payload: input.thread,
  };
}

export const seedCompaction = Effect.fnUntraced(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO orchestration_v2_legacy_imports (
    thread_id, source_updated_at, shell_imported_at, transcript_imported_at, imported_message_count
  ) VALUES ('imported', '2026-10-17', '2026-10-17', '2026-10-17', 0)`;
  yield* sql`WITH RECURSIVE history(n) AS (
    SELECT 1 UNION ALL SELECT n + 1 FROM history WHERE n < 151
  ) INSERT INTO orchestration_events (
    event_id, aggregate_kind, stream_id, stream_version, event_type,
    occurred_at, actor_kind, payload_json, metadata_json, application_event_version
  ) SELECT 'event-' || n, 'thread', 'thread', n,
    CASE WHEN n IN (1, 51, 101) THEN 'message.updated' ELSE 'thread.visited' END,
    '2026-10-17', 'server', '{"id":"message"}', '{}', 2 FROM history`;
  // A pass a day ago marked the whole log; projections cover it.
  yield* sql`INSERT INTO orchestration_v2_projection_metadata (
    projection_name, schema_version, last_sequence, updated_at
  ) VALUES
    ('event-log-prune-mark', 2, 151, '1969-12-30T00:00:00.000Z'),
    ('thread-projections', 2, 151, '1969-12-30T00:00:00.000Z')
  ON CONFLICT(projection_name) DO UPDATE SET last_sequence = excluded.last_sequence`;
  yield* sql`WITH RECURSIVE history(n) AS (
    SELECT 1 UNION ALL SELECT n + 1 FROM history WHERE n < 100
  ) INSERT INTO orchestration_command_receipts (
    rowid, command_id, aggregate_kind, aggregate_id, accepted_at, result_sequence, status, command_type
  ) SELECT n * 2, 'command-' || n, 'thread', 'imported', '2026-10-17', 0, 'accepted', 'legacy' FROM history`;
});
