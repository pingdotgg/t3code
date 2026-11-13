// @effect-diagnostics nodeBuiltinImport:off -- fixtures and tests use Node builtins

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

import {
  encodeJson,
  isLiveStreamBufferError,
  layerCommandReceiptStoreProvided,
  layerDatabase,
  layerEffectOutboxProvided,
  layerEventSinkProvided,
  layerEventStoreProvided,
  layerIsolatedOutbox,
  layerProjectionMaintenanceProvided,
  layerProjectionReplayProvided,
  layerProjectionStoreProvided,
  layerStoresProvided,
  layerTest,
  makeThread,
  modelSelection,
  providerDriver,
  providerInstanceId,
  seedCompaction,
  threadCreatedEvent,
} from "./FoundationPersistence-fixtures.testkit.ts";

it.layer(layerTest)("orchestration V2 foundation persistence", (it) => {
  it.effect("settles a native subagent's child thread when its provider process is gone", () =>
    Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const parentId = ThreadId.make("thread:foundation-native-subagent-parent");
      const childId = ThreadId.make("thread:foundation-native-subagent-child");
      const runId = RunId.make("run:foundation-native-subagent");
      const subagentId = NodeId.make("node:foundation-native-subagent");
      const childRootId = NodeId.make("node:foundation-native-subagent-child-root");
      const parent = makeThread(parentId, now);
      const child: OrchestrationV2AppThread = {
        ...makeThread(childId, now),
        createdBy: "agent",
        creationSource: "provider",
        lineage: {
          parentThreadId: parentId,
          relationshipToParent: "subagent",
          rootThreadId: parentId,
        },
        forkedFrom: { type: "node", nodeId: subagentId },
      };
      const node = (input: {
        readonly id: NodeId;
        readonly threadId: ThreadId;
        readonly runId: RunId | null;
        readonly kind: "root_turn" | "subagent";
      }) => ({
        ...input,
        parentNodeId: null,
        rootNodeId: input.id,
        status: "running" as const,
        countsForRun: false,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        runtimeRequestId: null,
        checkpointScopeId: null,
        startedAt: now,
        completedAt: null,
      });
      yield* eventSink.commitCommand({
        commandId: CommandId.make("command:foundation-native-subagent"),
        threadId: parentId,
        commandType: "foundation.native-subagent",
        acceptedAt: now,
        events: [
          threadCreatedEvent({
            id: "event:foundation-native-subagent:parent",
            thread: parent,
            now,
          }),
          threadCreatedEvent({ id: "event:foundation-native-subagent:child", thread: child, now }),
          {
            id: EventId.make("event:foundation-native-subagent:run"),
            type: "run.created",
            threadId: parentId,
            runId,
            providerInstanceId,
            occurredAt: now,
            payload: {
              id: runId,
              threadId: parentId,
              ordinal: 1,
              providerInstanceId,
              modelSelection,
              providerThreadId: null,
              userMessageId: MessageId.make("message:foundation-native-subagent"),
              rootNodeId: null,
              activeAttemptId: null,
              status: "completed",
              queuePosition: null,
              requestedAt: now,
              startedAt: now,
              completedAt: now,
              checkpointId: null,
              contextHandoffId: null,
            },
          },
          {
            id: EventId.make("event:foundation-native-subagent:subagent-node"),
            type: "node.updated",
            threadId: parentId,
            runId,
            nodeId: subagentId,
            occurredAt: now,
            payload: node({ id: subagentId, threadId: parentId, runId, kind: "subagent" }),
          },
          {
            id: EventId.make("event:foundation-native-subagent:child-root"),
            type: "node.updated",
            threadId: childId,
            nodeId: childRootId,
            occurredAt: now,
            payload: node({ id: childRootId, threadId: childId, runId: null, kind: "root_turn" }),
          },
          {
            id: EventId.make("event:foundation-native-subagent:child-progress"),
            type: "turn-item.updated",
            threadId: childId,
            nodeId: childRootId,
            occurredAt: now,
            payload: {
              id: TurnItemId.make("item:foundation-native-subagent:progress"),
              threadId: childId,
              runId: null,
              nodeId: childRootId,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 101,
              type: "reasoning",
              status: "running",
              title: "Thinking",
              startedAt: now,
              completedAt: null,
              updatedAt: now,
              text: "Checking the diff.",
              streaming: true,
            },
          },
          {
            id: EventId.make("event:foundation-native-subagent:subagent"),
            type: "subagent.updated",
            threadId: parentId,
            runId,
            nodeId: subagentId,
            driver: providerDriver,
            providerInstanceId,
            occurredAt: now,
            payload: {
              id: subagentId,
              threadId: parentId,
              runId,
              parentNodeId: subagentId,
              origin: "provider_native",
              createdBy: "agent",
              driver: providerDriver,
              providerInstanceId,
              providerThreadId: null,
              childThreadId: childId,
              nativeTaskRef: null,
              prompt: "Audit the adapters",
              title: null,
              model: null,
              status: "running",
              result: null,
              startedAt: now,
              completedAt: null,
              updatedAt: now,
            },
          },
          {
            id: EventId.make("event:foundation-native-subagent:item"),
            type: "turn-item.updated",
            threadId: parentId,
            runId,
            nodeId: subagentId,
            occurredAt: now,
            payload: {
              id: TurnItemId.make("item:foundation-native-subagent"),
              threadId: parentId,
              runId,
              nodeId: subagentId,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 1,
              type: "subagent",
              status: "interrupted",
              title: null,
              startedAt: now,
              completedAt: null,
              updatedAt: now,
              subagentId,
              origin: "provider_native",
              driver: providerDriver,
              providerInstanceId,
              childThreadId: childId,
              prompt: "Audit the adapters",
              result: null,
            },
          },
        ],
        effects: [],
      });

      const recovery = yield* ProviderRuntimeRecovery.make.pipe(
        Effect.provide(ServerSettings.layerTest()),
        Effect.provideService(
          EffectWorker.OrchestrationEffectWorkerV2,
          EffectWorker.OrchestrationEffectWorkerV2.of({
            awaitWork: Effect.void,
            runRecoveryOnce: Effect.succeed(false),
            runOnce: Effect.succeed(false),
            nextClaimableAt: Effect.succeedNone,
            drain: () => Effect.succeed(0),
          }),
        ),
      );
      assert.include(yield* projectionStore.getRecoveryThreadIds("runtime"), childId);
      yield* recovery.recover;

      const parentProjection = yield* projectionStore.getThreadProjection(parentId);
      assert.equal(parentProjection.subagents[0]?.status, "cancelled");
      assert.equal(
        parentProjection.nodes.find((node) => node.id === subagentId)?.status,
        "cancelled",
      );
      const childProjection = yield* projectionStore.getThreadProjection(childId);
      const childRoot = childProjection.nodes.find((candidate) => candidate.id === childRootId);
      assert.equal(childRoot?.status, "cancelled");
      assert.isNotNull(childRoot?.completedAt ?? null);
      const progress = childProjection.turnItems.find((item) => item.type === "reasoning");
      assert.equal(progress?.status, "cancelled");
      assert.isFalse(progress?.type === "reasoning" && progress.streaming);
      assert.isNotNull(progress?.completedAt ?? null);
      assert.notInclude(yield* projectionStore.getRecoveryThreadIds("runtime"), childId);
    }),
  );

  it.effect("allocates collision-free positions beyond 100 items and rebuilds equivalently", () =>
    Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const maintenance = yield* ProjectionReplay.ProjectionReplay;
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:foundation-many-items");
      const runId = RunId.make("run:foundation-many-items");
      const providerThreadId = ProviderThreadId.make("provider-thread:foundation-many-items");
      const thread = makeThread(threadId, now);
      const providerThreadEvent = {
        id: EventId.make("event:foundation-many-items:provider-thread"),
        type: "provider-thread.updated" as const,
        threadId,
        providerInstanceId,
        occurredAt: now,
        payload: {
          id: providerThreadId,
          driver: providerDriver,
          providerInstanceId,
          providerSessionId: null,
          appThreadId: threadId,
          ownerNodeId: null,
          nativeThreadRef: null,
          nativeConversationHeadRef: null,
          status: "active" as const,
          firstRunOrdinal: 1,
          lastRunOrdinal: 1,
          handoffIds: [],
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
        },
      } satisfies OrchestrationV2DomainEvent;
      const runEvent = {
        id: EventId.make("event:foundation-many-items:run"),
        type: "run.created" as const,
        threadId,
        runId,
        providerInstanceId,
        occurredAt: now,
        payload: {
          id: runId,
          threadId,
          ordinal: 1,
          providerInstanceId,
          modelSelection,
          providerThreadId: null,
          userMessageId: MessageId.make("message:foundation-many-items"),
          rootNodeId: null,
          activeAttemptId: null,
          status: "completed" as const,
          queuePosition: null,
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          checkpointId: null,
          contextHandoffId: null,
        },
      } satisfies OrchestrationV2DomainEvent;
      const items = Array.from({ length: 151 }, (_, index) => ({
        id: TurnItemId.make(`turn-item:foundation-many-items:${index}`),
        threadId,
        runId,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: index % 3,
        status: "completed" as const,
        title: null,
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        type: "dynamic_tool" as const,
        toolName: `tool-${index}`,
        input: { index },
        output: { completed: true },
      }));
      const itemEvents = items.map(
        (item, index) =>
          ({
            id: EventId.make(`event:foundation-many-items:item:${index}`),
            type: "turn-item.updated",
            threadId,
            runId,
            providerInstanceId,
            occurredAt: now,
            payload: item,
          }) satisfies OrchestrationV2DomainEvent,
      );

      yield* eventSink.write({
        events: [
          threadCreatedEvent({ id: "event:foundation-many-items:thread", thread, now }),
          providerThreadEvent,
          runEvent,
          ...itemEvents,
        ],
      });
      const beforeUpdate = yield* projectionStore.getThreadProjection(threadId);
      assert.equal(beforeUpdate.thread.activeProviderThreadId, providerThreadId);
      const ordinals = beforeUpdate.turnItems.map((item) => item.ordinal);
      assert.lengthOf(ordinals, 151);
      assert.equal(new Set(ordinals).size, 151);
      assert.isTrue(ordinals.every((ordinal) => ordinal > 1_000_000));
      assert.isTrue(
        ordinals.every((ordinal, index) => index === 0 || ordinal > ordinals[index - 1]!),
      );

      yield* eventSink.write({
        events: [
          {
            id: EventId.make("event:foundation-many-items:update"),
            type: "turn-item.updated",
            threadId,
            runId,
            providerInstanceId,
            occurredAt: now,
            payload: { ...items[0]!, ordinal: 99_999_999, title: "Updated" },
          },
        ],
      });
      const afterUpdate = yield* projectionStore.getThreadProjection(threadId);
      assert.equal(afterUpdate.turnItems[0]?.ordinal, ordinals[0]);
      assert.equal((yield* maintenance.verify).valid, true);

      yield* sql`
        UPDATE orchestration_v2_projection_turn_items
        SET payload_json = '{}'
        WHERE turn_item_id = ${items[75]!.id}
      `;
      const broken = yield* maintenance.verify;
      assert.isFalse(broken.valid);
      assert.deepEqual(broken.unreadableThreadIds, [threadId]);

      const rebuilt = yield* maintenance.rebuild;
      assert.isTrue(rebuilt.valid);
      assert.lengthOf((yield* projectionStore.getThreadProjection(threadId)).turnItems, 151);
    }),
  );
});
