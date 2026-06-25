import { assert, it } from "@effect/vitest";
import {
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { EventSinkV2, layer as eventSinkLayer } from "./EventSink.ts";
import { EventStoreV2, layer as eventStoreLayer } from "./EventStore.ts";
import {
  IdAllocatorV2,
  type IdAllocatorV2Error,
  layer as idAllocatorLayer,
} from "./IdAllocator.ts";
import { ProjectionStoreV2, layer as projectionStoreLayer } from "./ProjectionStore.ts";
import {
  ProviderEventIngestorV2,
  layer as providerEventIngestorLayer,
} from "./ProviderEventIngestor.ts";
import { makeProviderFailure } from "./ProviderFailure.ts";

const TestDatabaseLayer = SqlitePersistenceMemory;
const TestStoresLayer = Layer.merge(eventStoreLayer, projectionStoreLayer).pipe(
  Layer.provide(TestDatabaseLayer),
);

const TestEventSinkLayer = eventSinkLayer.pipe(
  Layer.provide(Layer.mergeAll(TestStoresLayer, TestDatabaseLayer)),
);

const TestLayer = Layer.mergeAll(
  TestStoresLayer,
  TestEventSinkLayer,
  idAllocatorLayer,
  providerEventIngestorLayer.pipe(
    Layer.provide(Layer.mergeAll(TestStoresLayer, TestEventSinkLayer, idAllocatorLayer)),
  ),
);
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;
const CODEX_DRIVER = ProviderDriverKind.make("codex");

function threadCreatedEvent(
  now: DateTime.Utc,
): Effect.Effect<OrchestrationV2DomainEvent, IdAllocatorV2Error, IdAllocatorV2> {
  return Effect.gen(function* () {
    const idAllocator = yield* IdAllocatorV2;
    const projectId = yield* idAllocator.allocate.project({
      fixtureName: "provider-event-ingestor",
    });
    const threadId = yield* idAllocator.allocate.thread({
      fixtureName: "provider-event-ingestor",
      projectId,
    });
    const providerThreadId = idAllocator.derive.providerThread({
      driver: CODEX_DRIVER,
      nativeThreadId: "native-thread",
    });
    const thread: OrchestrationV2AppThread = {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId,
      title: "Provider event ingestor",
      providerInstanceId: modelSelection.instanceId,
      modelSelection: modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: providerThreadId,
      lineage: {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId: threadId,
      },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      deletedAt: null,
    };

    return {
      id: yield* idAllocator.allocate.event({ threadId }),
      type: "thread.created",
      threadId,
      occurredAt: now,
      payload: thread,
    };
  });
}

const layer = it.layer(TestLayer);

layer("ProviderEventIngestorV2", (it) => {
  it.effect("normalizes provider events through the real event log and projection store", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const eventSink = yield* EventSinkV2;
      const eventStore = yield* EventStoreV2;
      const projectionStore = yield* ProjectionStoreV2;
      const ingestor = yield* ProviderEventIngestorV2;
      const idAllocator = yield* IdAllocatorV2;
      const threadEvent = yield* threadCreatedEvent(now);
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId: threadEvent.threadId,
      });
      const providerThread: OrchestrationV2ProviderThread = {
        id: idAllocator.derive.providerThread({
          driver: CODEX_DRIVER,
          nativeThreadId: "native-thread",
        }),
        driver: CODEX_DRIVER,
        providerInstanceId: modelSelection.instanceId,
        providerSessionId,
        appThreadId: threadEvent.threadId,
        ownerNodeId: null,
        nativeThreadRef: {
          driver: CODEX_DRIVER,
          nativeId: "native-thread",
          strength: "strong",
        },
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: null,
        lastRunOrdinal: null,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      };

      yield* eventSink.write({ events: [threadEvent] });
      const storedEvents = yield* ingestor.ingestNormalized({
        providerSessionId,
        providerInstanceId: modelSelection.instanceId,
        threadId: threadEvent.threadId,
        event: {
          type: "provider_thread.updated",
          driver: CODEX_DRIVER,
          providerThread,
        },
      });

      const projection = yield* projectionStore.getThreadProjection(threadEvent.threadId);
      const storedDomainEvents = yield* eventStore.read({}).pipe(Stream.runCollect);
      const afterFirstEvent = yield* eventStore
        .read({ afterSequence: 1, threadId: threadEvent.threadId })
        .pipe(Stream.runCollect);
      const latestThreadSequence = yield* eventStore.latestSequence({
        threadId: threadEvent.threadId,
      });

      assert.equal(storedEvents.length, 1);
      assert.equal(storedEvents[0]?.event.type, "provider-thread.updated");
      assert.deepEqual(
        projection.providerThreads.map((thread) => thread.id),
        [providerThread.id],
      );
      assert.deepEqual(
        Array.from(storedDomainEvents).map((stored) => stored.event.type),
        ["thread.created", "provider-thread.updated"],
      );
      assert.deepEqual(
        Array.from(storedDomainEvents).map((stored) => stored.sequence),
        [1, 2],
      );
      assert.deepEqual(
        Array.from(afterFirstEvent).map((stored) => stored.event.type),
        ["provider-thread.updated"],
      );
      assert.equal(latestThreadSequence, 2);
    }),
  );

  it.effect(
    "treats successful provider terminal markers as non-persisted orchestration control signals",
    () =>
      Effect.gen(function* () {
        const ingestor = yield* ProviderEventIngestorV2;
        const idAllocator = yield* IdAllocatorV2;
        const projectId = yield* idAllocator.allocate.project({
          fixtureName: "provider-event-terminal",
        });
        const threadId = yield* idAllocator.allocate.thread({
          fixtureName: "provider-event-terminal",
          projectId,
        });
        const providerSessionId = yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId,
        });
        const normalized = yield* ingestor.normalize({
          providerSessionId,
          providerInstanceId: modelSelection.instanceId,
          threadId,
          event: {
            type: "turn.terminal",
            driver: CODEX_DRIVER,
            providerThreadId: idAllocator.derive.providerThread({
              driver: CODEX_DRIVER,
              nativeThreadId: "native-thread",
            }),
            providerTurnId: idAllocator.derive.providerTurn({
              driver: CODEX_DRIVER,
              nativeTurnId: "native-turn",
            }),
            runOrdinal: 1,
            status: "completed",
            failure: null,
            threadDisposition: "reusable",
          },
        });

        assert.deepEqual(normalized, []);
      }),
  );

  it.effect("persists a failed provider terminal as one expected error item", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const eventSink = yield* EventSinkV2;
      const projectionStore = yield* ProjectionStoreV2;
      const ingestor = yield* ProviderEventIngestorV2;
      const idAllocator = yield* IdAllocatorV2;
      const threadEvent = yield* threadCreatedEvent(now);
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId: threadEvent.threadId,
      });
      const providerThreadId = idAllocator.derive.providerThread({
        driver: CODEX_DRIVER,
        nativeThreadId: "native-thread-failed",
      });
      const providerTurnId = idAllocator.derive.providerTurn({
        driver: CODEX_DRIVER,
        nativeTurnId: "native-turn-failed",
      });

      yield* eventSink.write({ events: [threadEvent] });
      const stored = yield* ingestor.ingestNormalized({
        providerSessionId,
        providerInstanceId: modelSelection.instanceId,
        threadId: threadEvent.threadId,
        event: {
          type: "turn.terminal",
          driver: CODEX_DRIVER,
          providerThreadId,
          providerTurnId,
          runOrdinal: 1,
          failureItemOrdinal: 102,
          status: "failed",
          failure: makeProviderFailure({
            message: "Invalid reasoning effort.",
            code: "invalid_request",
            class: "validation_error",
          }),
          threadDisposition: "reusable",
        },
      });

      const projection = yield* projectionStore.getThreadProjection(threadEvent.threadId);
      const errorItems = projection.visibleTurnItems.filter(
        (candidate) => candidate.item.type === "error",
      );

      assert.equal(stored.length, 1);
      assert.equal(stored[0]?.event.type, "turn-item.updated");
      assert.equal(errorItems.length, 1);
      const errorItem = errorItems[0]?.item;
      assert.equal(errorItem?.type, "error");
      if (errorItem?.type !== "error") return;
      assert.equal(errorItem.failure.message, "Invalid reasoning effort.");
      assert.equal(errorItem.failure.code, "invalid_request");
      assert.equal(errorItem.providerThreadId, providerThreadId);
      assert.equal(errorItem.providerTurnId, providerTurnId);
    }),
  );

  it.effect("routes provider-owned child artifacts to their child app thread", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const ingestor = yield* ProviderEventIngestorV2;
      const idAllocator = yield* IdAllocatorV2;
      const rootEvent = yield* threadCreatedEvent(now);
      if (rootEvent.type !== "thread.created") {
        throw new Error("Expected a thread.created fixture event");
      }
      const childThreadId = idAllocator.derive.threadFromProviderThread({
        driver: CODEX_DRIVER,
        nativeThreadId: "native-subagent-thread",
      });
      const childRootNodeId = NodeId.make("node:subagent-root");
      const childThread: OrchestrationV2AppThread = {
        ...rootEvent.payload,
        id: childThreadId,
        title: "inspect package",
        activeProviderThreadId: null,
        lineage: {
          parentThreadId: rootEvent.threadId,
          relationshipToParent: "subagent",
          rootThreadId: rootEvent.threadId,
        },
        forkedFrom: {
          type: "node",
          nodeId: NodeId.make("node:parent-subagent"),
        },
      };
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId: rootEvent.threadId,
      });

      const threadEvents = yield* ingestor.normalize({
        providerSessionId,
        providerInstanceId: modelSelection.instanceId,
        threadId: rootEvent.threadId,
        event: {
          type: "app_thread.created",
          driver: CODEX_DRIVER,
          appThread: childThread,
        },
      });
      const messageEvents = yield* ingestor.normalize({
        providerSessionId,
        providerInstanceId: modelSelection.instanceId,
        threadId: rootEvent.threadId,
        event: {
          type: "message.updated",
          driver: CODEX_DRIVER,
          message: {
            createdBy: "agent",
            creationSource: "provider",
            id: MessageId.make("message:subagent-response"),
            threadId: childThreadId,
            runId: null,
            nodeId: childRootNodeId,
            role: "assistant",
            text: "Subagent result",
            attachments: [],
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        },
      });

      assert.equal(threadEvents[0]?.type, "thread.created");
      assert.equal(threadEvents[0]?.threadId, childThreadId);
      assert.equal(messageEvents[0]?.type, "message.updated");
      assert.equal(messageEvents[0]?.threadId, childThreadId);
    }),
  );
});
