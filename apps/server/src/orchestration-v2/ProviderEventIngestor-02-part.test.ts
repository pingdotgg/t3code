import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  MessageId,
  GitCommandError,
  type ModelSelection,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  RuntimeRequestId,
  TurnItemId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlError from "effect/sql/SqlError";
import * as Stream from "effect/Stream";

import { toolOutputImages } from "@t3tools/shared/toolOutput";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderEventIngestor from "./ProviderEventIngestor.ts";
import * as ProviderUsageAnalytics from "../telemetry/ProviderUsageAnalytics.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import {
  makeProviderEventRoutingState,
  type ProviderEventRouteIdentity,
  routeProviderEvent,
  selectInheritedBackgroundTurnItems,
} from "./RunExecutionService.ts";


import * as fixtures from "./ProviderEventIngestor-fixtures.testkit.ts";

const {
  CODEX_DRIVER,
  constraintFailure,
  ingestCompletedProviderTurn,
  layerFailingWrites,
  layerTest,
  lockTimeout,
  makeSharedWorktree,
  modelSelection,
  threadCreatedEvent,
} = fixtures;

const layer = it.layer(layerTest);

layer("ProviderEventIngestorV2", (it) => {
  it.effect("normalizes provider events through the real event log and projection store", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const eventSink = yield* EventSink.EventSinkV2;
      const eventStore = yield* EventStore.EventStoreV2;
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const ingestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
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


  it.effect("skips a node update only when it matches the stored node", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const eventSink = yield* EventSink.EventSinkV2;
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const ingestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const threadEvent = yield* threadCreatedEvent(now);
      const threadId = threadEvent.threadId;
      yield* eventSink.write({ events: [threadEvent] });
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });
      const nodeId = NodeId.make(`${threadId}:approval`);
      const node: OrchestrationV2ExecutionNode = {
        id: nodeId,
        threadId,
        runId: null,
        parentNodeId: null,
        rootNodeId: nodeId,
        kind: "approval_request",
        status: "waiting",
        countsForRun: false,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        runtimeRequestId: null,
        checkpointScopeId: null,
        startedAt: now,
        completedAt: null,
      };
      const ingestNode = (sent: OrchestrationV2ExecutionNode) =>
        ingestor.ingestNormalized({
          providerSessionId,
          providerInstanceId: modelSelection.instanceId,
          threadId,
          event: { type: "node.updated", driver: CODEX_DRIVER, node: sent },
        });

      assert.lengthOf(yield* ingestNode(node), 1);
      assert.isEmpty(yield* ingestNode({ ...node }));
      yield* eventSink.write({
        events: [
          {
            id: yield* idAllocator.allocate.event({ threadId }),
            type: "node.updated",
            threadId,
            occurredAt: now,
            payload: { ...node, status: "completed", completedAt: now },
          },
        ],
      });
      assert.lengthOf(yield* ingestNode(node), 1);
      const projection = yield* projectionStore.getThreadProjection(threadId);
      assert.equal(projection.nodes.find((entry) => entry.id === nodeId)?.status, "waiting");
    }),
  );


  it.effect("rolls back runs a provider rewound off its active branch", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const eventSink = yield* EventSink.EventSinkV2;
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const ingestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const threadEvent = yield* threadCreatedEvent(now);
      const threadId = threadEvent.threadId;
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });
      const rewoundThreadId = idAllocator.derive.providerThread({
        driver: CODEX_DRIVER,
        nativeThreadId: "rewound-thread",
      });
      const otherThreadId = idAllocator.derive.providerThread({
        driver: CODEX_DRIVER,
        nativeThreadId: "other-thread",
      });
      const scopeId = CheckpointScopeId.make("checkpoint-scope:rewound");
      const seedRun = Effect.fnUntraced(function* (input: {
        readonly ordinal: number;
        readonly providerThreadId: ProviderThreadId;
        readonly status: "completed" | "interrupted" | "running";
        readonly nativeTurnId: string | null;
      }) {
        const runId = RunId.make(`run:rewound:${input.ordinal}`);
        const attemptId = RunAttemptId.make(`attempt:rewound:${input.ordinal}`);
        const nodeId = NodeId.make(`node:rewound:${input.ordinal}`);
        const providerTurnId = ProviderTurnId.make(`provider-turn:rewound:${input.ordinal}`);
        const completedAt = input.status === "running" ? null : now;
        const eventId = () => idAllocator.allocate.event({ threadId });
        const events: Array<OrchestrationV2DomainEvent> = [
          {
            id: yield* eventId(),
            type: "run.created",
            threadId,
            occurredAt: now,
            payload: {
              id: runId,
              threadId,
              ordinal: input.ordinal,
              providerInstanceId: modelSelection.instanceId,
              modelSelection,
              providerThreadId: input.providerThreadId,
              userMessageId: MessageId.make(`message:rewound:${input.ordinal}`),
              rootNodeId: nodeId,
              activeAttemptId: attemptId,
              status: input.status,
              requestedAt: now,
              startedAt: now,
              completedAt,
              checkpointId: null,
              contextHandoffId: null,
            },
          },
          {
            id: yield* eventId(),
            type: "run-attempt.created",
            threadId,
            occurredAt: now,
            payload: {
              id: attemptId,
              runId,
              attemptOrdinal: 1,
              rootNodeId: nodeId,
              providerInstanceId: modelSelection.instanceId,
              providerThreadId: input.providerThreadId,
              providerTurnId,
              reason: "initial",
              status: input.status,
              startedAt: now,
              completedAt,
            },
          },
          {
            id: yield* eventId(),
            type: "provider-turn.updated",
            threadId,
            occurredAt: now,
            payload: {
              id: providerTurnId,
              providerThreadId: input.providerThreadId,
              nodeId,
              runAttemptId: attemptId,
              nativeTurnRef:
                input.nativeTurnId === null
                  ? {
                      driver: CODEX_DRIVER,
                      nativeId: `synthetic:${input.ordinal}`,
                      strength: "weak",
                    }
                  : { driver: CODEX_DRIVER, nativeId: input.nativeTurnId, strength: "strong" },
              ordinal: input.ordinal,
              status: input.status,
              startedAt: now,
              completedAt,
            },
          },
          {
            id: yield* eventId(),
            type: "node.updated",
            threadId,
            occurredAt: now,
            payload: {
              id: nodeId,
              threadId,
              runId,
              parentNodeId: null,
              rootNodeId: nodeId,
              kind: "root_turn",
              status: input.status,
              countsForRun: true,
              providerThreadId: input.providerThreadId,
              providerTurnId,
              nativeItemRef: null,
              runtimeRequestId: null,
              checkpointScopeId: scopeId,
              startedAt: now,
              completedAt,
            },
          },
          ...(input.status === "completed"
            ? [
                {
                  id: yield* eventId(),
                  type: "checkpoint.captured" as const,
                  threadId,
                  occurredAt: now,
                  payload: {
                    id: CheckpointId.make(`checkpoint:rewound:${input.ordinal}`),
                    threadId,
                    scopeId,
                    runId,
                    nodeId,
                    parentCheckpointId: null,
                    ordinalWithinScope: input.ordinal,
                    appRunOrdinal: input.ordinal,
                    ref: CheckpointRef.make(`refs/t3/checkpoints/rewound/${input.ordinal}`),
                    status: "ready" as const,
                    files: [],
                    capturedAt: now,
                  },
                },
              ]
            : []),
        ];
        yield* eventSink.write({ events });
        return runId;
      });

      yield* eventSink.write({ events: [threadEvent] });
      const otherProviderRun = yield* seedRun({
        ordinal: 1,
        providerThreadId: otherThreadId,
        status: "completed",
        nativeTurnId: "other-turn",
      });
      const keptRun = yield* seedRun({
        ordinal: 2,
        providerThreadId: rewoundThreadId,
        status: "completed",
        nativeTurnId: "kept-turn",
      });
      const abandonedRun = yield* seedRun({
        ordinal: 3,
        providerThreadId: rewoundThreadId,
        status: "completed",
        nativeTurnId: "abandoned-turn",
      });
      const unlocatedRun = yield* seedRun({
        ordinal: 4,
        providerThreadId: rewoundThreadId,
        status: "interrupted",
        nativeTurnId: null,
      });
      const rewindingRun = yield* seedRun({
        ordinal: 5,
        providerThreadId: rewoundThreadId,
        status: "running",
        nativeTurnId: null,
      });

      yield* ingestor.ingestNormalized({
        providerSessionId,
        providerInstanceId: modelSelection.instanceId,
        threadId,
        runId: rewindingRun,
        event: {
          type: "provider_thread.updated",
          driver: CODEX_DRIVER,
          providerThread: {
            id: rewoundThreadId,
            driver: CODEX_DRIVER,
            providerInstanceId: modelSelection.instanceId,
            providerSessionId,
            appThreadId: threadId,
            ownerNodeId: null,
            nativeThreadRef: {
              driver: CODEX_DRIVER,
              nativeId: "rewound-thread",
              strength: "strong",
            },
            nativeConversationHeadRef: {
              driver: CODEX_DRIVER,
              nativeId: "kept-turn-reply",
              strength: "strong",
            },
            status: "idle",
            firstRunOrdinal: 2,
            lastRunOrdinal: 5,
            handoffIds: [],
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
          },
          retainedNativeTurnIds: ["turn-started-outside-t3", "kept-turn"],
        },
      });

      const projection = yield* projectionStore.getThreadProjection(threadId);
      const runIds = [otherProviderRun, keptRun, abandonedRun, unlocatedRun, rewindingRun];
      assert.deepEqual(
        runIds.map((runId) => projection.runs.find((run) => run.id === runId)?.status),
        ["completed", "completed", "rolled_back", "rolled_back", "running"],
      );
      assert.deepEqual(
        runIds.map((runId) => projection.nodes.find((node) => node.runId === runId)?.status),
        ["completed", "completed", "rolled_back", "rolled_back", "running"],
      );
      assert.deepEqual(
        [otherProviderRun, keptRun, abandonedRun].map(
          (runId) =>
            projection.checkpoints.find((checkpoint) => checkpoint.runId === runId)?.status,
        ),
        ["ready", "ready", "stale"],
      );
      assert.equal(
        projection.providerThreads.find((thread) => thread.id === rewoundThreadId)?.lastRunOrdinal,
        5,
      );
    }),
  );


  it.effect(
    "treats successful provider terminal markers as non-persisted orchestration control signals",
    () =>
      Effect.gen(function* () {
        const ingestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
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
      const eventSink = yield* EventSink.EventSinkV2;
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const ingestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
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

});

