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
  activeAttemptId,
  makeLayerTest,
  layerTestEventSink,
  runId,
  constraintFailure,
  ingestCompletedProviderTurn,
  layerFailingWrites,
  layerTest,
  lockTimeout,
  makeSharedWorktree,
  modelSelection,
  threadCreatedEvent,
} = fixtures;

it.effect("refreshes the failing instance snapshot after a committed usage_limit terminal", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const refreshed = yield* Deferred.make<void>();
      const adapter = yield* ProviderAdapter.ProviderAdapterV2.pipe(
        Effect.provide(
          Layer.mock(ProviderAdapter.ProviderAdapterV2)({
            instanceId: ProviderInstanceId.make("cursor-work"),
            driver: ProviderDriverKind.make("cursor"),
          }),
        ),
      );
      const instance: ProviderInstance = {
        instanceId: ProviderInstanceId.make("cursor-work"),
        driverKind: ProviderDriverKind.make("cursor"),
        continuationIdentity: {
          driverKind: ProviderDriverKind.make("cursor"),
          continuationKey: "work",
        },
        enabled: true,
        displayName: undefined,
        orchestrationAdapter: adapter,
        textGeneration: {
          generateBranchName: () => Effect.die("unused"),
          generateCommitMessage: () => Effect.die("unused"),
          generatePrContent: () => Effect.die("unused"),
          generateThreadTitle: () => Effect.die("unused"),
          generateReviewGuide: () => Effect.die("unused"),
        },
        snapshot: {
          refreshUsage: Deferred.succeed(refreshed, undefined).pipe(Effect.asVoid),
          getSnapshot: Effect.die("unused"),
          refresh: Effect.die("unused"),
          resolveMaintenance: () => Effect.die("unused"),
          applyUsageLimits: () => Effect.die("unused"),
          streamChanges: Stream.empty,
        },
      };
      const lookups: ProviderInstanceId[] = [];
      const instances = Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
        getInstance: (id) =>
          Effect.sync(() => {
            lookups.push(id);
            return id === instance.instanceId ? instance : undefined;
          }),
      });
      yield* Effect.gen(function* () {
        const now = yield* DateTime.now;
        const eventSink = yield* EventSink.EventSinkV2;
        const ingestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const threadEvent = yield* threadCreatedEvent(now);
        yield* eventSink.write({ events: [threadEvent] });
        const input = {
          providerSessionId: yield* idAllocator.allocate.providerSession({
            providerInstanceId: instance.instanceId,
            threadId: threadEvent.threadId,
          }),
          providerInstanceId: instance.instanceId,
          threadId: threadEvent.threadId,
        };
        for (const failureClass of ["validation_error", "usage_limit"] as const) {
          const stored = yield* ingestor.ingestNormalized({
            ...input,
            event: {
              type: "turn.terminal",
              driver: instance.driverKind,
              providerThreadId: idAllocator.derive.providerThread({
                driver: instance.driverKind,
                nativeThreadId: "limited",
              }),
              providerTurnId: idAllocator.derive.providerTurn({
                driver: instance.driverKind,
                nativeTurnId: failureClass,
              }),
              runOrdinal: 1,
              failureItemOrdinal: 1,
              status: "failed",
              failure: makeProviderFailure({
                class: failureClass,
                message: "Provider rejected turn.",
              }),
              threadDisposition: "reusable",
            },
          });
          assert.equal(stored.length, 1);
          if (failureClass === "validation_error") assert.deepEqual(lookups, []);
        }
        assert.deepEqual(lookups, [instance.instanceId]);
        yield* Deferred.await(refreshed);
      }).pipe(Effect.provide(makeLayerTest(layerTestEventSink, instances)));
    }),
  ),
);

it.effect("records accepted billed turn usage once without billing the context window", () => {
  const recorded: Array<ProviderUsageAnalytics.ProviderTurnReport> = [];
  const layerAnalytics = Layer.succeed(ProviderUsageAnalytics.ProviderTurnAnalytics, {
    runStarted: () => Effect.void,
    turnCompleted: (report) =>
      Effect.sync(() => {
        recorded.push(report);
      }),
    runSettled: () => Effect.void,
  });
  return Effect.gen(function* () {
    const now = yield* DateTime.now;
    const eventSink = yield* EventSink.EventSinkV2;
    const ingestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const threadEvent = yield* threadCreatedEvent(now);
    yield* eventSink.write({ events: [threadEvent] });
    const providerSessionId = yield* idAllocator.allocate.providerSession({
      providerInstanceId: modelSelection.instanceId,
      threadId: threadEvent.threadId,
    });
    const providerThreadId = idAllocator.derive.providerThread({
      driver: CODEX_DRIVER,
      nativeThreadId: "billing-thread",
    });
    const providerTurn = {
      id: idAllocator.derive.providerTurn({ driver: CODEX_DRIVER, nativeTurnId: "billing-turn" }),
      providerThreadId,
      nodeId: NodeId.make("node:billing-turn"),
      runAttemptId: null,
      nativeTurnRef: null,
      ordinal: 1,
      status: "completed" as const,
      startedAt: now,
      completedAt: DateTime.makeUnsafe(DateTime.toEpochMillis(now) + 120),
      tokenUsage: {
        inputTokens: 4000,
        cachedInputTokens: 3000,
        outputTokens: 100,
        usedTokens: 4100,
        updatedAt: DateTime.formatIso(now),
      },
      turnTokenUsage: {
        usageStatus: "complete" as const,
        usageScope: "main_agent" as const,
        hasSubagents: false,
        inputTokens: 40,
        cachedInputTokens: 30,
        outputTokens: 10,
      },
    };
    const input = {
      providerSessionId,
      providerInstanceId: modelSelection.instanceId,
      threadId: threadEvent.threadId,
      analyticsContext: {
        modelSelection,
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        origin: {
          createdBy: "agent" as const,
          creationSource: "provider" as const,
          scheduled: false,
          subagent: true,
        },
      },
      event: { type: "provider_turn.updated" as const, driver: CODEX_DRIVER, providerTurn },
    };
    yield* ingestor.ingestNormalized(input);
    yield* ingestor.ingestNormalized(input);
    const ignored = yield* ingestor.ingestNormalized({
      ...input,
      event: {
        ...input.event,
        providerTurn: {
          ...providerTurn,
          id: idAllocator.derive.providerTurn({
            driver: CODEX_DRIVER,
            nativeTurnId: "stale-billing-turn",
          }),
        },
      },
      writeIfRunCurrent: {
        runId: RunId.make("missing-run"),
        activeAttemptId: RunAttemptId.make("stale-attempt"),
        expectedStatus: "running",
      },
    });
    assert.isEmpty(ignored);
    assert.lengthOf(recorded, 1);
    assert.deepEqual(recorded[0], {
      driver: CODEX_DRIVER,
      providerTurn,
      context: input.analyticsContext,
    });
  }).pipe(Effect.provide(layerTest.pipe(Layer.provide(layerAnalytics))));
});

it.effect.each([
  { route: "write", guard: {} },
  {
    route: "writeIfRunCurrent",
    guard: { writeIfRunCurrent: { runId, activeAttemptId, expectedStatus: "running" } },
  },
  {
    route: "writeIfProviderThreadOwner",
    guard: {
      writeIfProviderThreadOwner: {
        providerThreadId: ProviderThreadId.make("provider-thread:locked"),
        runId,
        activeAttemptId,
        expectedLastRunOrdinal: 1,
      },
    },
  },
] as const)("a provider event $route outlasts a brief database lock", ({ route, guard }) =>
  Effect.gen(function* () {
    const { exit, providerTurnId, persisted } = yield* ingestCompletedProviderTurn(guard);
    assert.isTrue(Exit.isSuccess(exit));
    assert.deepEqual(persisted, route === "write" ? [providerTurnId] : []);
  }).pipe(Effect.provide(layerFailingWrites([lockTimeout, lockTimeout]))),
);

// The write after the queued errors would succeed, so failing proves the retries stopped.
it.effect.each([
  { failure: "stays locked", errors: [lockTimeout, lockTimeout, lockTimeout] },
  { failure: "fails for another reason", errors: [constraintFailure] },
])("fails a provider event write that $failure", ({ errors }) =>
  Effect.gen(function* () {
    const { exit, persisted } = yield* ingestCompletedProviderTurn({});
    assert.instanceOf(
      Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined,
      ProviderEventIngestor.ProviderEventPublishError,
    );
    assert.isEmpty(persisted);
  }).pipe(Effect.provide(layerFailingWrites(errors))),
);
