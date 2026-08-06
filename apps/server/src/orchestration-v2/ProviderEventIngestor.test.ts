import { assert, it } from "@effect/vitest";
import {
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2TurnItem,
  ProviderDriverKind,
  ProviderInstanceId,
  RunAttemptId,
  RunId,
  RuntimeRequestId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { EventSinkV2, layer as eventSinkLayer } from "./EventSink.ts";
import { EventStoreV2, layer as eventStoreLayer } from "./EventStore.ts";
import {
  IdAllocatorV2,
  type IdAllocatorV2Error,
  layer as idAllocatorLayer,
} from "./IdAllocator.ts";
import {
  applyToProjection,
  ProjectionStoreV2,
  layer as projectionStoreLayer,
} from "./ProjectionStore.ts";
import {
  isSettledClearingProviderActivity,
  providerActivityTimestamp,
  ProviderEventIngestorV2,
  layer as providerEventIngestorLayer,
} from "./ProviderEventIngestor.ts";
import { makeProviderFailure } from "./ProviderFailure.ts";
import {
  makeProviderEventRoutingState,
  type ProviderEventRouteIdentity,
  routeProviderEvent,
  selectInheritedBackgroundTurnItems,
} from "./RunExecutionService.ts";

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
  options: {
    readonly fixtureName?: string;
    readonly settledOverride?: OrchestrationV2AppThread["settledOverride"];
    readonly settledAt?: DateTime.Utc | null;
  } = {},
): Effect.Effect<OrchestrationV2DomainEvent, IdAllocatorV2Error, IdAllocatorV2> {
  return Effect.gen(function* () {
    const idAllocator = yield* IdAllocatorV2;
    const fixtureName = options.fixtureName ?? "provider-event-ingestor";
    const projectId = yield* idAllocator.allocate.project({
      fixtureName,
    });
    const threadId = yield* idAllocator.allocate.thread({
      fixtureName,
      projectId,
    });
    const providerThreadId = idAllocator.derive.providerThread({
      driver: CODEX_DRIVER,
      nativeThreadId: `native-thread:${fixtureName}`,
    });
    const settledOverride = options.settledOverride ?? null;
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
      lastVisitedAt: null,
      deletedAt: null,
      settledOverride,
      settledAt:
        options.settledAt !== undefined
          ? options.settledAt
          : settledOverride === "settled"
            ? now
            : null,
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

function makeProviderSession(input: {
  readonly id: OrchestrationV2ProviderSession["id"];
  readonly status: OrchestrationV2ProviderSession["status"];
  readonly now: DateTime.Utc;
}): OrchestrationV2ProviderSession {
  return {
    id: input.id,
    driver: CODEX_DRIVER,
    providerInstanceId: modelSelection.instanceId,
    status: input.status,
    cwd: "/tmp",
    model: modelSelection.model,
    capabilities: CodexProviderCapabilitiesV2,
    createdAt: input.now,
    updatedAt: input.now,
    lastError: null,
  };
}

function makeRuntimeRequest(input: {
  readonly id: string;
  readonly kind: OrchestrationV2RuntimeRequest["kind"];
  readonly status: OrchestrationV2RuntimeRequest["status"];
  readonly providerSessionId: OrchestrationV2ProviderSession["id"];
  readonly now: DateTime.Utc;
}): OrchestrationV2RuntimeRequest {
  return {
    id: RuntimeRequestId.make(input.id),
    nodeId: NodeId.make(`node:${input.id}`),
    providerTurnId: null,
    nativeRequestRef: null,
    kind: input.kind,
    status: input.status,
    responseCapability: {
      type: "live",
      providerSessionId: input.providerSessionId,
    },
    createdAt: input.now,
    resolvedAt: input.status === "pending" ? null : input.now,
  };
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

  it.effect("persists an interrupted run's inherited terminal through the live run router", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const eventSink = yield* EventSinkV2;
      const projectionStore = yield* ProjectionStoreV2;
      const ingestor = yield* ProviderEventIngestorV2;
      const idAllocator = yield* IdAllocatorV2;
      const threadEvent = yield* threadCreatedEvent(now);
      const priorRunId = RunId.make("run:provider-event-inherited:prior");
      const currentRunId = RunId.make("run:provider-event-inherited:current");
      const itemId = TurnItemId.make("turn-item:provider-event-inherited");
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId: threadEvent.threadId,
      });
      const providerThreadId = idAllocator.derive.providerThread({
        driver: CODEX_DRIVER,
        nativeThreadId: "native-thread-inherited",
      });
      const providerTurnId = idAllocator.derive.providerTurn({
        driver: CODEX_DRIVER,
        nativeTurnId: "native-turn-inherited",
      });
      const runningItem = {
        id: itemId,
        threadId: threadEvent.threadId,
        runId: priorRunId,
        nodeId: NodeId.make("node:provider-event-inherited"),
        providerThreadId,
        providerTurnId,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 101,
        status: "running",
        title: "Inherited background command",
        startedAt: now,
        completedAt: null,
        updatedAt: now,
        type: "command_execution",
        input: "sleep 60",
      } satisfies OrchestrationV2TurnItem;
      const terminalItem = {
        ...runningItem,
        status: "completed" as const,
        completedAt: now,
        updatedAt: now,
      };

      yield* eventSink.write({ events: [threadEvent] });
      yield* ingestor.ingestNormalized({
        providerSessionId,
        providerInstanceId: modelSelection.instanceId,
        threadId: threadEvent.threadId,
        runId: priorRunId,
        event: { type: "turn_item.updated", driver: CODEX_DRIVER, turnItem: runningItem },
      });

      const identity: ProviderEventRouteIdentity = {
        threadId: threadEvent.threadId,
        runId: currentRunId,
        attemptId: RunAttemptId.make("attempt:provider-event-inherited:current"),
        providerThreadId,
      };
      const inheritedBackgroundTurnItems = selectInheritedBackgroundTurnItems({
        threadId: threadEvent.threadId,
        currentProviderThreadId: providerThreadId,
        currentRunOrdinal: 2,
        runs: [
          {
            id: priorRunId,
            threadId: threadEvent.threadId,
            ordinal: 1,
            status: "interrupted",
          } as OrchestrationV2Run,
          {
            id: currentRunId,
            threadId: threadEvent.threadId,
            ordinal: 2,
            status: "running",
          } as OrchestrationV2Run,
        ],
        turnItems: [runningItem],
      });
      const routeState = makeProviderEventRoutingState({
        identity,
        inheritedBackgroundTurnItems,
        providerTurnId: null,
      });
      const terminalEvent = {
        type: "turn_item.updated",
        driver: CODEX_DRIVER,
        turnItem: terminalItem,
      } as const;
      const [accepted] = routeProviderEvent(terminalEvent, identity, routeState);
      assert.isTrue(accepted);

      const stored = yield* ingestor.ingestNormalized({
        providerSessionId,
        providerInstanceId: modelSelection.instanceId,
        threadId: threadEvent.threadId,
        runId: currentRunId,
        event: terminalEvent,
      });
      const projection = yield* projectionStore.getThreadProjection(threadEvent.threadId);
      const persisted = projection.turnItems.find((item) => item.id === itemId);

      assert.equal(stored.length, 1);
      assert.equal(stored[0]?.event.type, "turn-item.updated");
      assert.equal(persisted?.runId, priorRunId);
      assert.equal(persisted?.threadId, threadEvent.threadId);
      assert.equal(persisted?.status, "completed");
    }),
  );

  it.effect("persists a completed run's late background terminal exactly once", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const eventSink = yield* EventSinkV2;
      const eventStore = yield* EventStoreV2;
      const ingestor = yield* ProviderEventIngestorV2;
      const idAllocator = yield* IdAllocatorV2;
      const threadEvent = yield* threadCreatedEvent(now);
      const priorRunId = RunId.make("run:provider-event-completed:prior");
      const currentRunId = RunId.make("run:provider-event-completed:current");
      const itemId = TurnItemId.make("turn-item:provider-event-completed");
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId: threadEvent.threadId,
      });
      const providerThreadId = idAllocator.derive.providerThread({
        driver: CODEX_DRIVER,
        nativeThreadId: "native-thread-completed",
      });
      const providerTurnId = idAllocator.derive.providerTurn({
        driver: CODEX_DRIVER,
        nativeTurnId: "native-turn-completed",
      });
      const runningItem = {
        id: itemId,
        threadId: threadEvent.threadId,
        runId: priorRunId,
        nodeId: NodeId.make("node:provider-event-completed"),
        providerThreadId,
        providerTurnId,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 101,
        status: "running",
        title: "Completed run background command",
        startedAt: now,
        completedAt: null,
        updatedAt: now,
        type: "command_execution",
        input: "sleep 60",
      } satisfies OrchestrationV2TurnItem;
      const terminalEvent = {
        type: "turn_item.updated",
        driver: CODEX_DRIVER,
        turnItem: {
          ...runningItem,
          status: "completed" as const,
          completedAt: now,
          updatedAt: now,
        },
      } as const;

      yield* eventSink.write({ events: [threadEvent] });
      yield* ingestor.ingestNormalized({
        providerSessionId,
        providerInstanceId: modelSelection.instanceId,
        threadId: threadEvent.threadId,
        runId: priorRunId,
        event: { type: "turn_item.updated", driver: CODEX_DRIVER, turnItem: runningItem },
      });

      const priorIdentity: ProviderEventRouteIdentity = {
        threadId: threadEvent.threadId,
        runId: priorRunId,
        attemptId: RunAttemptId.make("attempt:provider-event-completed:prior"),
        providerThreadId,
      };
      const currentIdentity: ProviderEventRouteIdentity = {
        threadId: threadEvent.threadId,
        runId: currentRunId,
        attemptId: RunAttemptId.make("attempt:provider-event-completed:current"),
        providerThreadId,
      };
      const inheritedBackgroundTurnItems = selectInheritedBackgroundTurnItems({
        threadId: threadEvent.threadId,
        currentProviderThreadId: providerThreadId,
        currentRunOrdinal: 2,
        runs: [
          {
            id: priorRunId,
            threadId: threadEvent.threadId,
            ordinal: 1,
            status: "completed",
          } as OrchestrationV2Run,
          {
            id: currentRunId,
            threadId: threadEvent.threadId,
            ordinal: 2,
            status: "running",
          } as OrchestrationV2Run,
        ],
        turnItems: [runningItem],
      });
      const routers = [
        {
          identity: priorIdentity,
          state: makeProviderEventRoutingState({
            identity: priorIdentity,
            providerTurnId: providerTurnId,
          }),
        },
        {
          identity: currentIdentity,
          state: makeProviderEventRoutingState({
            identity: currentIdentity,
            inheritedBackgroundTurnItems,
            providerTurnId: null,
          }),
        },
      ];
      const acceptedRouters = routers.filter(
        ({ identity, state }) => routeProviderEvent(terminalEvent, identity, state)[0],
      );

      yield* Effect.forEach(
        acceptedRouters,
        ({ identity }) =>
          ingestor.ingestNormalized({
            providerSessionId,
            providerInstanceId: modelSelection.instanceId,
            threadId: threadEvent.threadId,
            runId: identity.runId,
            event: terminalEvent,
          }),
        { concurrency: 1 },
      );

      const storedEvents = yield* eventStore
        .read({ threadId: threadEvent.threadId })
        .pipe(Stream.runCollect);
      const storedTerminals = Array.from(storedEvents).filter(
        (stored) =>
          stored.event.type === "turn-item.updated" &&
          stored.event.payload.id === itemId &&
          stored.event.payload.status === "completed",
      );

      assert.equal(storedTerminals.length, 1);
      assert.equal(acceptedRouters.length, 1);
      assert.equal(acceptedRouters[0]?.identity.runId, priorRunId);
    }),
  );

  it.effect("persists a failed provider terminal as one expected error item", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const retryStartedAt = DateTime.makeUnsafe(DateTime.toEpochMillis(now) - 5_000);
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
          retry: {
            attempt: 3,
            maxAttempts: 3,
            retryDelayMs: 2_000,
          },
          retryStartedAt,
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
      assert.deepEqual(errorItem.retry, {
        attempt: 3,
        maxAttempts: 3,
        retryDelayMs: 2_000,
      });
      const errorStartedAt = errorItem.startedAt;
      assert.ok(errorStartedAt);
      assert.equal(DateTime.toEpochMillis(errorStartedAt), DateTime.toEpochMillis(retryStartedAt));
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

  it.effect(
    "clears an explicit settled pin when a pending approval request arrives via provider ingest",
    () =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const eventSink = yield* EventSinkV2;
        const projectionStore = yield* ProjectionStoreV2;
        const ingestor = yield* ProviderEventIngestorV2;
        const idAllocator = yield* IdAllocatorV2;
        const threadEvent = yield* threadCreatedEvent(now, {
          fixtureName: "provider-event-settle-approval",
          settledOverride: "settled",
        });
        const providerSessionId = yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId: threadEvent.threadId,
        });

        yield* eventSink.write({ events: [threadEvent] });
        const stored = yield* ingestor.ingestNormalized({
          providerSessionId,
          providerInstanceId: modelSelection.instanceId,
          threadId: threadEvent.threadId,
          event: {
            type: "runtime_request.updated",
            driver: CODEX_DRIVER,
            runtimeRequest: makeRuntimeRequest({
              id: "approval-wake",
              kind: "command",
              status: "pending",
              providerSessionId,
              now,
            }),
          },
        });

        assert.equal(stored[0]?.event.type, "thread.unsettled");
        assert.equal(stored[1]?.event.type, "runtime-request.updated");
        const projection = yield* projectionStore.getThreadProjection(threadEvent.threadId);
        assert.isNull(projection.thread.settledOverride);
        assert.isNull(projection.thread.settledAt);
      }),
  );

  it.effect(
    "clears a keep-active pin when a provider session reactivates via provider ingest",
    () =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const eventSink = yield* EventSinkV2;
        const projectionStore = yield* ProjectionStoreV2;
        const ingestor = yield* ProviderEventIngestorV2;
        const idAllocator = yield* IdAllocatorV2;
        const threadEvent = yield* threadCreatedEvent(now, {
          fixtureName: "provider-event-active-session",
          settledOverride: "active",
        });
        const providerSessionId = yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId: threadEvent.threadId,
        });

        yield* eventSink.write({ events: [threadEvent] });
        const stored = yield* ingestor.ingestNormalized({
          providerSessionId,
          providerInstanceId: modelSelection.instanceId,
          threadId: threadEvent.threadId,
          event: {
            type: "provider_session.updated",
            driver: CODEX_DRIVER,
            providerSession: makeProviderSession({
              id: providerSessionId,
              status: "running",
              now,
            }),
          },
        });

        assert.equal(stored[0]?.event.type, "thread.unsettled");
        assert.equal(stored[1]?.event.type, "provider-session.updated");
        const projection = yield* projectionStore.getThreadProjection(threadEvent.threadId);
        assert.isNull(projection.thread.settledOverride);
      }),
  );

  it.effect("does not clear settle pins for non-activity provider updates", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const eventSink = yield* EventSinkV2;
      const projectionStore = yield* ProjectionStoreV2;
      const ingestor = yield* ProviderEventIngestorV2;
      const idAllocator = yield* IdAllocatorV2;
      const threadEvent = yield* threadCreatedEvent(now, {
        fixtureName: "provider-event-non-activity",
        settledOverride: "settled",
      });
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId: threadEvent.threadId,
      });
      const providerThread: OrchestrationV2ProviderThread = {
        id: idAllocator.derive.providerThread({
          driver: CODEX_DRIVER,
          nativeThreadId: "native-thread-non-activity",
        }),
        driver: CODEX_DRIVER,
        providerInstanceId: modelSelection.instanceId,
        providerSessionId,
        appThreadId: threadEvent.threadId,
        ownerNodeId: null,
        nativeThreadRef: {
          driver: CODEX_DRIVER,
          nativeId: "native-thread-non-activity",
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

      // Terminal/status-after-the-fact session write.
      const readyStored = yield* ingestor.ingestNormalized({
        providerSessionId,
        providerInstanceId: modelSelection.instanceId,
        threadId: threadEvent.threadId,
        event: {
          type: "provider_session.updated",
          driver: CODEX_DRIVER,
          providerSession: makeProviderSession({
            id: providerSessionId,
            status: "ready",
            now,
          }),
        },
      });
      assert.deepEqual(
        readyStored.map((stored) => stored.event.type),
        ["provider-session.updated"],
      );

      // Request resolution is not activity that wakes a pin.
      const resolvedStored = yield* ingestor.ingestNormalized({
        providerSessionId,
        providerInstanceId: modelSelection.instanceId,
        threadId: threadEvent.threadId,
        event: {
          type: "runtime_request.updated",
          driver: CODEX_DRIVER,
          runtimeRequest: makeRuntimeRequest({
            id: "resolved-approval",
            kind: "command",
            status: "resolved",
            providerSessionId,
            now,
          }),
        },
      });
      assert.deepEqual(
        resolvedStored.map((stored) => stored.event.type),
        ["runtime-request.updated"],
      );

      // Arbitrary provider thread roster write.
      const threadStored = yield* ingestor.ingestNormalized({
        providerSessionId,
        providerInstanceId: modelSelection.instanceId,
        threadId: threadEvent.threadId,
        event: {
          type: "provider_thread.updated",
          driver: CODEX_DRIVER,
          providerThread,
        },
      });
      assert.deepEqual(
        threadStored.map((stored) => stored.event.type),
        ["provider-thread.updated"],
      );

      const projection = yield* projectionStore.getThreadProjection(threadEvent.threadId);
      assert.equal(projection.thread.settledOverride, "settled");
      assert.isNotNull(projection.thread.settledAt);
    }),
  );

  it.effect("classifies only pending request and live session events as settle-clearing", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const idAllocator = yield* IdAllocatorV2;
      const threadId = yield* idAllocator.allocate.thread({
        fixtureName: "provider-event-classifier",
        projectId: yield* idAllocator.allocate.project({
          fixtureName: "provider-event-classifier",
        }),
      });
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });
      const base = {
        id: yield* idAllocator.allocate.event({ threadId }),
        threadId,
        providerInstanceId: modelSelection.instanceId,
        occurredAt: now,
      } as const;

      assert.isTrue(
        isSettledClearingProviderActivity({
          ...base,
          type: "runtime-request.updated",
          payload: makeRuntimeRequest({
            id: "pending-input",
            kind: "user_input",
            status: "pending",
            providerSessionId,
            now,
          }),
        }),
      );
      assert.isFalse(
        isSettledClearingProviderActivity({
          ...base,
          type: "runtime-request.updated",
          payload: makeRuntimeRequest({
            id: "auth",
            kind: "auth_refresh",
            status: "pending",
            providerSessionId,
            now,
          }),
        }),
      );
      assert.isTrue(
        isSettledClearingProviderActivity({
          ...base,
          type: "provider-session.updated",
          payload: makeProviderSession({ id: providerSessionId, status: "starting", now }),
        }),
      );
      assert.isFalse(
        isSettledClearingProviderActivity({
          ...base,
          type: "provider-session.updated",
          payload: makeProviderSession({ id: providerSessionId, status: "stopped", now }),
        }),
      );
      assert.isFalse(
        isSettledClearingProviderActivity({
          ...base,
          type: "message.updated",
          payload: {
            createdBy: "agent",
            creationSource: "provider",
            id: MessageId.make("message:classifier"),
            threadId,
            runId: null,
            nodeId: null,
            role: "assistant",
            text: "hi",
            attachments: [],
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        }),
      );
      const pending = {
        ...base,
        type: "runtime-request.updated" as const,
        payload: makeRuntimeRequest({
          id: "pending-ts",
          kind: "command",
          status: "pending",
          providerSessionId,
          now,
        }),
      };
      assert.equal(
        providerActivityTimestamp(pending) === null
          ? null
          : DateTime.formatIso(providerActivityTimestamp(pending)!),
        DateTime.formatIso(now),
      );
    }),
  );

  it.effect(
    "clears settlement without restoring concurrent metadata from a stale full-thread payload",
    () =>
      Effect.gen(function* () {
        const pinAt = DateTime.makeUnsafe("2026-07-01T10:00:00.000Z");
        const activityAt = DateTime.makeUnsafe("2026-07-01T10:05:00.000Z");
        const renameAt = DateTime.makeUnsafe("2026-07-01T10:10:00.000Z");
        const eventSink = yield* EventSinkV2;
        const projectionStore = yield* ProjectionStoreV2;
        const idAllocator = yield* IdAllocatorV2;
        const threadEvent = yield* threadCreatedEvent(pinAt, {
          fixtureName: "provider-event-stale-payload",
          settledOverride: "settled",
        });
        if (threadEvent.type !== "thread.created") {
          return yield* Effect.die("expected thread.created fixture");
        }
        const thread = threadEvent.payload;
        yield* eventSink.write({ events: [threadEvent] });

        // Concurrent rename after the pin, before delayed unsettle reduction.
        const renamed: OrchestrationV2AppThread = {
          ...thread,
          title: "Concurrent rename",
          updatedAt: renameAt,
        };
        const renameEvent: OrchestrationV2DomainEvent = {
          id: yield* idAllocator.allocate.event({ threadId: threadEvent.threadId }),
          type: "thread.metadata-updated",
          threadId: threadEvent.threadId,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: renameAt,
          payload: renamed,
        };
        yield* eventSink.write({ events: [renameEvent] });

        // Stale full-thread unsettle payload still carries the pre-rename title.
        const staleUnsettle: OrchestrationV2DomainEvent = {
          id: yield* idAllocator.allocate.event({ threadId: threadEvent.threadId }),
          type: "thread.unsettled",
          threadId: threadEvent.threadId,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: activityAt,
          payload: {
            ...thread,
            title: "Stale pre-rename title",
            settledOverride: null,
            settledAt: null,
            updatedAt: activityAt,
          },
        };
        // applyToProjection is the in-memory reducer used by getProjectionWithPendingEvents.
        const afterRename = yield* projectionStore.getThreadProjection(threadEvent.threadId);
        const reduced = applyToProjection(afterRename, staleUnsettle);
        assert.equal(reduced.thread.title, "Concurrent rename");
        assert.isNull(reduced.thread.settledOverride);

        // Durable SQL path must agree.
        yield* eventSink.write({ events: [staleUnsettle] });
        const durable = yield* projectionStore.getThreadProjection(threadEvent.threadId);
        assert.equal(durable.thread.title, "Concurrent rename");
        assert.isNull(durable.thread.settledOverride);
      }),
  );

  it.effect("always emits an activity-unsettle candidate even when the thread is neutral", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const eventSink = yield* EventSinkV2;
      const projectionStore = yield* ProjectionStoreV2;
      const ingestor = yield* ProviderEventIngestorV2;
      const idAllocator = yield* IdAllocatorV2;
      // Neutral thread: pre-TX optimistic skip used to omit the candidate
      // and lose a concurrent settle that lands before write.
      const threadEvent = yield* threadCreatedEvent(now, {
        fixtureName: "provider-event-neutral-unsettle",
        settledOverride: null,
      });
      yield* eventSink.write({ events: [threadEvent] });
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId: threadEvent.threadId,
      });

      const stored = yield* ingestor.ingestNormalized({
        providerSessionId,
        providerInstanceId: modelSelection.instanceId,
        threadId: threadEvent.threadId,
        event: {
          type: "runtime_request.updated",
          driver: CODEX_DRIVER,
          runtimeRequest: makeRuntimeRequest({
            id: "neutral-approval",
            kind: "command",
            status: "pending",
            providerSessionId,
            now,
          }),
        },
      });

      assert.equal(stored[0]?.event.type, "thread.unsettled");
      assert.equal(stored[1]?.event.type, "runtime-request.updated");
      // Reducer no-ops when already neutral; pin stays null.
      const projection = yield* projectionStore.getThreadProjection(threadEvent.threadId);
      assert.isNull(projection.thread.settledOverride);
    }),
  );

  it.effect(
    "does not clear a newer settled or active pin when delayed provider activity is ingested",
    () =>
      Effect.gen(function* () {
        const activityAt = DateTime.makeUnsafe("2026-07-01T09:00:00.000Z");
        const pinAt = DateTime.makeUnsafe("2026-07-01T10:00:00.000Z");
        const eventSink = yield* EventSinkV2;
        const projectionStore = yield* ProjectionStoreV2;
        const ingestor = yield* ProviderEventIngestorV2;
        const idAllocator = yield* IdAllocatorV2;

        for (const override of ["settled", "active"] as const) {
          const threadEvent = yield* threadCreatedEvent(pinAt, {
            fixtureName: `provider-event-delayed-${override}`,
            settledOverride: override,
          });
          if (threadEvent.type !== "thread.created") {
            return yield* Effect.die("expected thread.created fixture");
          }
          // Pin time is later than the delayed activity.
          const pinnedEvent: OrchestrationV2DomainEvent = {
            ...threadEvent,
            occurredAt: pinAt,
            payload: {
              ...threadEvent.payload,
              settledOverride: override,
              settledAt: override === "settled" ? pinAt : null,
              updatedAt: pinAt,
            },
          };
          yield* eventSink.write({ events: [pinnedEvent] });

          const providerSessionId = yield* idAllocator.allocate.providerSession({
            providerInstanceId: modelSelection.instanceId,
            threadId: threadEvent.threadId,
          });

          const stored =
            override === "settled"
              ? yield* ingestor.ingestNormalized({
                  providerSessionId,
                  providerInstanceId: modelSelection.instanceId,
                  threadId: threadEvent.threadId,
                  event: {
                    type: "runtime_request.updated",
                    driver: CODEX_DRIVER,
                    runtimeRequest: makeRuntimeRequest({
                      id: `delayed-approval-${override}`,
                      kind: "command",
                      status: "pending",
                      providerSessionId,
                      now: activityAt,
                    }),
                  },
                })
              : yield* ingestor.ingestNormalized({
                  providerSessionId,
                  providerInstanceId: modelSelection.instanceId,
                  threadId: threadEvent.threadId,
                  event: {
                    type: "provider_session.updated",
                    driver: CODEX_DRIVER,
                    providerSession: makeProviderSession({
                      id: providerSessionId,
                      status: "running",
                      now: activityAt,
                    }),
                  },
                });

          // Candidate is always included; transactional ordering keeps the pin.
          const unsettle = stored.find((row) => row.event.type === "thread.unsettled");
          assert.isDefined(unsettle);
          if (unsettle !== undefined) {
            assert.equal(
              DateTime.formatIso(unsettle.event.occurredAt),
              DateTime.formatIso(activityAt),
            );
          }
          const projection = yield* projectionStore.getThreadProjection(threadEvent.threadId);
          assert.equal(projection.thread.settledOverride, override);
        }
      }),
  );

  it.effect(
    "stamps ordinary provider session/runtime events at ingestion time, not payload history",
    () =>
      Effect.gen(function* () {
        const historicalAt = DateTime.makeUnsafe("2026-07-01T08:00:00.000Z");
        const threadCreatedAt = yield* DateTime.now;
        const eventSink = yield* EventSinkV2;
        const projectionStore = yield* ProjectionStoreV2;
        const ingestor = yield* ProviderEventIngestorV2;
        const idAllocator = yield* IdAllocatorV2;
        const threadEvent = yield* threadCreatedEvent(threadCreatedAt, {
          fixtureName: "provider-event-ingest-time",
          settledOverride: null,
        });
        yield* eventSink.write({ events: [threadEvent] });
        const providerSessionId = yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId: threadEvent.threadId,
        });

        // Delayed "ready" is not settle-clearing activity, but must not rewrite
        // occurredAt (and thus thread.updatedAt) to historical payload time.
        const stored = yield* ingestor.ingestNormalized({
          providerSessionId,
          providerInstanceId: modelSelection.instanceId,
          threadId: threadEvent.threadId,
          event: {
            type: "provider_session.updated",
            driver: CODEX_DRIVER,
            providerSession: makeProviderSession({
              id: providerSessionId,
              status: "ready",
              now: historicalAt,
            }),
          },
        });

        assert.equal(stored.length, 1);
        assert.equal(stored[0]?.event.type, "provider-session.updated");
        const sessionEvent = stored[0]!.event;
        // Ingestion stamp, not the delayed payload updatedAt.
        assert.notEqual(
          DateTime.formatIso(sessionEvent.occurredAt),
          DateTime.formatIso(historicalAt),
        );
        if (sessionEvent.type === "provider-session.updated") {
          assert.equal(
            DateTime.formatIso(sessionEvent.payload.updatedAt),
            DateTime.formatIso(historicalAt),
          );
        }
        const after = yield* projectionStore.getThreadProjection(threadEvent.threadId);
        assert.equal(
          DateTime.formatIso(after.thread.updatedAt),
          DateTime.formatIso(sessionEvent.occurredAt),
        );
        assert.notEqual(
          DateTime.formatIso(after.thread.updatedAt),
          DateTime.formatIso(historicalAt),
        );
      }),
  );
});
