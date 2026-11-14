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
  it.effect("persists a completed run's late background terminal exactly once", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const eventSink = yield* EventSink.EventSinkV2;
      const eventStore = yield* EventStore.EventStoreV2;
      const ingestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
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

  it.effect.each(["interrupted", "control"] as const)(
    "dismisses only native questions when a provider turn ends with %s",
    (terminal) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const eventSink = yield* EventSink.EventSinkV2;
        const eventStore = yield* EventStore.EventStoreV2;
        const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
        const ingestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const threadEvent = yield* threadCreatedEvent(now);
        const threadId = threadEvent.threadId;
        const providerSessionId = yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId,
        });
        const providerThreadId = idAllocator.derive.providerThread({
          driver: CODEX_DRIVER,
          nativeThreadId: `${threadId}:questions`,
        });
        const providerTurnId = idAllocator.derive.providerTurn({
          driver: CODEX_DRIVER,
          nativeTurnId: `${threadId}:questions`,
        });
        const otherTurnId = idAllocator.derive.providerTurn({
          driver: CODEX_DRIVER,
          nativeTurnId: `${threadId}:other-turn`,
        });
        const specs = [
          { key: "native", responseCapability: { type: "live", providerSessionId } },
          {
            key: "unavailable",
            responseCapability: { type: "not_resumable", reason: "Turn ended" },
          },
          { key: "message", responseCapability: { type: "message" } },
          { key: "answered", responseCapability: { type: "live", providerSessionId } },
          { key: "other-turn", responseCapability: { type: "live", providerSessionId } },
          { key: "approval", responseCapability: { type: "live", providerSessionId } },
        ] as const;
        const fixtures = specs.map((spec, ordinal) => {
          const nodeId = NodeId.make(`${threadId}:${spec.key}`);
          const resolved = spec.key === "answered";
          const request: OrchestrationV2RuntimeRequest = {
            id: RuntimeRequestId.make(`${threadId}:${spec.key}`),
            nodeId,
            providerTurnId: spec.key === "other-turn" ? otherTurnId : providerTurnId,
            nativeRequestRef: null,
            kind: spec.key === "approval" ? "command" : "user_input",
            status: resolved ? "resolved" : "pending",
            responseCapability: spec.responseCapability,
            createdAt: now,
            resolvedAt: resolved ? now : null,
          };
          const node: OrchestrationV2ExecutionNode = {
            id: nodeId,
            threadId,
            runId: null,
            parentNodeId: null,
            rootNodeId: nodeId,
            kind: spec.key === "approval" ? "approval_request" : "user_input_request",
            status: resolved ? "completed" : "waiting",
            countsForRun: false,
            providerThreadId,
            providerTurnId: request.providerTurnId,
            nativeItemRef: null,
            runtimeRequestId: request.id,
            checkpointScopeId: null,
            startedAt: now,
            completedAt: resolved ? now : null,
          };
          const item: OrchestrationV2TurnItem = {
            id: TurnItemId.make(`${threadId}:${spec.key}`),
            threadId,
            runId: null,
            nodeId,
            providerThreadId,
            providerTurnId: request.providerTurnId,
            nativeItemRef: null,
            parentItemId: null,
            ordinal,
            status: resolved ? "completed" : "waiting",
            title: "Which option?",
            startedAt: now,
            completedAt: resolved ? now : null,
            updatedAt: now,
            ...(spec.key === "approval"
              ? { type: "approval_request", requestId: request.id, requestKind: "command" }
              : {
                  type: "user_input_request",
                  requestId: request.id,
                  questions: [],
                  ...(spec.key === "message" ? { responseMode: "message" as const } : {}),
                }),
          };
          return { key: spec.key, request, node, item };
        });
        const seedEvents: Array<OrchestrationV2DomainEvent> = [threadEvent];
        for (const fixture of fixtures) {
          for (const payload of [
            { type: "runtime-request.updated" as const, payload: fixture.request },
            { type: "node.updated" as const, payload: fixture.node },
            { type: "turn-item.updated" as const, payload: fixture.item },
          ]) {
            seedEvents.push({
              id: yield* idAllocator.allocate.event({ threadId }),
              threadId,
              occurredAt: now,
              ...payload,
            });
          }
        }
        yield* eventSink.write({ events: seedEvents });
        const input = {
          providerSessionId,
          providerInstanceId: modelSelection.instanceId,
          threadId,
          event:
            terminal === "control"
              ? {
                  type: "turn.terminal" as const,
                  driver: CODEX_DRIVER,
                  providerThreadId,
                  providerTurnId,
                  runOrdinal: 1,
                  status: "completed" as const,
                  failure: null,
                  threadDisposition: "reusable" as const,
                }
              : {
                  type: "provider_turn.updated" as const,
                  driver: CODEX_DRIVER,
                  providerTurn: {
                    id: providerTurnId,
                    providerThreadId,
                    nodeId: NodeId.make(`${threadId}:root`),
                    runAttemptId: null,
                    nativeTurnRef: null,
                    ordinal: 1,
                    status: terminal,
                    startedAt: now,
                    completedAt: now,
                  },
                },
        };
        const stored = yield* ingestor.ingestNormalized(input);
        const projection = yield* projectionStore.getThreadProjection(threadId);
        for (const fixture of fixtures) {
          const closed = fixture.key === "native" || fixture.key === "unavailable";
          const request = projection.runtimeRequests.find(
            (item) => item.id === fixture.request.id,
          )!;
          const node = projection.nodes.find((item) => item.id === fixture.node.id)!;
          const item = projection.turnItems.find((item) => item.id === fixture.item.id)!;
          if (closed) {
            assert.equal(request.status, "cancelled");
            assert.isNotNull(request.resolvedAt);
            assert.equal(node.status, "cancelled");
            assert.isNotNull(node.completedAt);
            assert.equal(item.status, "cancelled");
            assert.isNotNull(item.completedAt);
          } else {
            assert.equal(request.status, fixture.request.status);
            assert.equal(node.status, fixture.node.status);
            assert.equal(item.status, fixture.item.status);
          }
        }
        assert.equal(
          stored.filter((entry) => entry.event.type === "runtime-request.updated").length,
          2,
        );
        assert.isEmpty(
          (yield* projectionStore.getPendingNativeUserInputs(threadId, providerTurnId))
            .runtimeRequests,
        );
        const replayed = yield* eventStore.read({ threadId }).pipe(Stream.runCollect);
        assert.equal(
          replayed.filter(
            (entry) =>
              entry.event.type === "runtime-request.updated" &&
              entry.event.payload.status === "cancelled",
          ).length,
          2,
        );
        const repeated = yield* ingestor.ingestNormalized(input);
        assert.isFalse(repeated.some((entry) => entry.event.type === "runtime-request.updated"));
      }),
  );


  it.effect(
    "preserves an answer committed after terminal normalization reads a pending question",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const eventSink = yield* EventSink.EventSinkV2;
          const eventStore = yield* EventStore.EventStoreV2;
          const projections = yield* ProjectionStore.ProjectionStoreV2;
          const idAllocator = yield* IdAllocator.IdAllocatorV2;
          const now = yield* DateTime.now;
          const threadEvent = yield* threadCreatedEvent(now);
          const threadId = threadEvent.threadId;
          const providerSessionId = yield* idAllocator.allocate.providerSession({
            providerInstanceId: modelSelection.instanceId,
            threadId,
          });
          const providerThreadId = idAllocator.derive.providerThread({
            driver: CODEX_DRIVER,
            nativeThreadId: `${threadId}:race`,
          });
          const providerTurnId = idAllocator.derive.providerTurn({
            driver: CODEX_DRIVER,
            nativeTurnId: `${threadId}:race`,
          });
          const nodeId = NodeId.make(`${threadId}:question`);
          const request: OrchestrationV2RuntimeRequest = {
            id: RuntimeRequestId.make(`${threadId}:question`),
            nodeId,
            providerTurnId,
            nativeRequestRef: null,
            kind: "user_input",
            status: "pending",
            responseCapability: { type: "live", providerSessionId },
            createdAt: now,
            resolvedAt: null,
          };
          const node: OrchestrationV2ExecutionNode = {
            id: nodeId,
            threadId,
            runId: null,
            parentNodeId: null,
            rootNodeId: nodeId,
            kind: "user_input_request",
            status: "waiting",
            countsForRun: false,
            providerThreadId,
            providerTurnId,
            nativeItemRef: null,
            runtimeRequestId: request.id,
            checkpointScopeId: null,
            startedAt: now,
            completedAt: null,
          };
          const item: OrchestrationV2TurnItem = {
            id: TurnItemId.make(`${threadId}:question`),
            threadId,
            runId: null,
            nodeId,
            providerThreadId,
            providerTurnId,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 1,
            status: "waiting",
            title: "Which option?",
            startedAt: now,
            completedAt: null,
            updatedAt: now,
            type: "user_input_request",
            requestId: request.id,
            questions: [],
          };
          const seedEvents: Array<OrchestrationV2DomainEvent> = [threadEvent];
          for (const payload of [
            { type: "runtime-request.updated" as const, payload: request },
            { type: "node.updated" as const, payload: node },
            { type: "turn-item.updated" as const, payload: item },
          ])
            seedEvents.push({
              id: yield* idAllocator.allocate.event({ threadId }),
              threadId,
              occurredAt: now,
              ...payload,
            });
          yield* eventSink.write({ events: seedEvents });
          const normalized = yield* Deferred.make<void>();
          const releaseTerminalWrite = yield* Deferred.make<void>();
          const gatedSink = EventSink.EventSinkV2.of({
            ...eventSink,
            write: (input) =>
              Deferred.succeed(normalized, undefined).pipe(
                Effect.andThen(Deferred.await(releaseTerminalWrite)),
                Effect.andThen(eventSink.write(input)),
              ),
          });
          const ingestor = yield* ProviderEventIngestor.ProviderEventIngestorV2.pipe(
            Effect.provide(Layer.fresh(ProviderEventIngestor.layer)),
            Effect.provideService(EventSink.EventSinkV2, gatedSink),
          );
          const terminal = yield* ingestor
            .ingestNormalized({
              providerSessionId,
              providerInstanceId: modelSelection.instanceId,
              threadId,
              event: {
                type: "provider_turn.updated",
                driver: CODEX_DRIVER,
                providerTurn: {
                  id: providerTurnId,
                  providerThreadId,
                  nodeId,
                  runAttemptId: null,
                  nativeTurnRef: null,
                  ordinal: 1,
                  status: "completed",
                  startedAt: now,
                  completedAt: now,
                },
              },
            })
            .pipe(Effect.forkScoped);
          yield* Deferred.await(normalized);
          const answers = { decision: "Use the existing workspace" };
          const responseEvents: Array<OrchestrationV2DomainEvent> = [];
          for (const payload of [
            {
              type: "runtime-request.updated" as const,
              payload: { ...request, status: "resolved" as const, answers, resolvedAt: now },
            },
            {
              type: "node.updated" as const,
              payload: { ...node, status: "completed" as const, completedAt: now },
            },
            {
              type: "turn-item.updated" as const,
              payload: { ...item, status: "completed" as const, completedAt: now },
            },
          ])
            responseEvents.push({
              id: yield* idAllocator.allocate.event({ threadId }),
              threadId,
              occurredAt: now,
              ...payload,
            });
          yield* eventSink.write({ events: responseEvents });
          yield* Deferred.succeed(releaseTerminalWrite, undefined);
          const committedTerminal = yield* Fiber.join(terminal);
          assert.deepEqual(
            committedTerminal.map((stored) => stored.event.type),
            ["provider-turn.updated"],
          );
          const projection = yield* projections.getThreadProjection(threadId);
          const answered = projection.runtimeRequests.find((entry) => entry.id === request.id)!;
          assert.equal(answered.status, "resolved");
          assert.deepEqual(answered.answers, answers);
          assert.equal(projection.nodes.find((entry) => entry.id === nodeId)!.status, "completed");
          assert.equal(
            projection.turnItems.find((entry) => entry.id === item.id)!.status,
            "completed",
          );
          const history = yield* eventStore.read({ threadId }).pipe(Stream.runCollect);
          assert.isFalse(
            history.some(
              (stored) =>
                stored.event.type === "runtime-request.updated" &&
                stored.event.payload.status === "cancelled",
            ),
          );
        }),
      ),
  );


  it.effect("persists a failed provider terminal as one expected error item", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const retryStartedAt = DateTime.makeUnsafe(DateTime.toEpochMillis(now) - 5_000);
      const eventSink = yield* EventSink.EventSinkV2;
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const ingestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
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


  it.effect("stores tool image bytes only where a tool-output-image asset serves them", () =>
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
      const readBase64 = Buffer.alloc(30_000, 7).toString("base64");
      const screenshotBase64 = Buffer.alloc(20_000, 9).toString("base64");
      const toolItem = (
        id: string,
        ordinal: number,
        toolName: string,
        output: unknown,
      ): OrchestrationV2TurnItem => ({
        id: TurnItemId.make(id),
        threadId: threadEvent.threadId,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal,
        status: "completed",
        title: toolName,
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        type: "dynamic_tool",
        toolName,
        input: {},
        output,
      });
      const read = toolItem("turn-item:read-image", 1, "Read", {
        type: "image",
        file: { base64: readBase64, type: "image/png", originalSize: 30_000 },
      });
      const screenshot = toolItem("turn-item:screenshot", 2, "mcp__t3-code__device_screenshot", {
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: screenshotBase64 },
          },
        ],
      });

      yield* eventSink.write({ events: [threadEvent] });
      for (const turnItem of [read, screenshot]) {
        yield* ingestor.ingestNormalized({
          providerSessionId,
          providerInstanceId: modelSelection.instanceId,
          threadId: threadEvent.threadId,
          event: { type: "turn_item.updated", driver: CODEX_DRIVER, turnItem },
        });
      }

      const storedEvents = yield* eventStore
        .read({ threadId: threadEvent.threadId, eventType: "turn-item.updated" })
        .pipe(Stream.runCollect);
      const storedJson = JSON.stringify(Array.from(storedEvents, (stored) => stored.event));
      const projectedRead = yield* projectionStore.getTurnItem({
        threadId: threadEvent.threadId,
        itemId: read.id,
      });
      const projectedScreenshot = yield* projectionStore.getTurnItem({
        threadId: threadEvent.threadId,
        itemId: screenshot.id,
      });

      assert.equal(storedJson.includes(readBase64), false);
      assert.equal(storedJson.includes(screenshotBase64), true);
      assert.deepEqual(projectedRead?.type === "dynamic_tool" ? projectedRead.output : null, {
        type: "image",
        file: { type: "image/png", originalSize: 30_000, sizeBytes: 30_000 },
      });
      assert.deepEqual(
        toolOutputImages(
          projectedScreenshot?.type === "dynamic_tool" ? projectedScreenshot.output : null,
        ),
        [{ mimeType: "image/png", data: screenshotBase64 }],
      );
    }),
  );

});

