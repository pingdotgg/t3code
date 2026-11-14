// @effect-diagnostics preferSchemaOverJson:off
// shared fixtures for ProviderEventIngestor (never imports the test file)
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

export const layerTestDatabase = SqlitePersistence.layerMemory;

export const layerTestStores = Layer.merge(EventStore.layer, ProjectionStore.layer).pipe(
  Layer.provide(layerTestDatabase),
);
export const layerTestEventSink = EventSink.layer.pipe(
  Layer.provide(Layer.mergeAll(layerTestStores, layerTestDatabase)),
);
export const layerGit = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "ingestor-git-" })),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);


export const layerEmptyInstances = Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
  // @effect-diagnostics-next-line effectSucceedWithVoid:off - Optional instances require undefined rather than void.
  getInstance: () => Effect.succeed(undefined),
});




export const makeLayerTest = <E>(
  ingestorEventSink: Layer.Layer<EventSink.EventSinkV2, E>,
  instances = layerEmptyInstances,
) =>
  Layer.mergeAll(
    instances,
    layerTestDatabase,
    layerTestStores,
    layerTestEventSink,
    IdAllocator.layer,
    ThreadCommandExecutor.layer,
    layerGit,
    ProviderEventIngestor.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          instances,
          layerTestStores,
          ingestorEventSink,
          IdAllocator.layer,
          ThreadCommandExecutor.layer,
          layerGit,
        ),
      ),
    ),
  );
export const layerTest = makeLayerTest(layerTestEventSink);
export const layer = it.layer(layerTest);




export const lockTimeout = new EventSink.EventSinkWriteError({
  eventCount: 1,
  cause: new SqlError.SqlError({ reason: new SqlError.LockTimeoutError({ cause: null }) }),
});

export const constraintFailure = new EventSink.EventSinkWriteError({
  eventCount: 1,
  cause: new SqlError.SqlError({ reason: new SqlError.ConstraintError({ cause: null }) }),
});


export const layerFailingWrites = (
  errors: ReadonlyArray<EventSink.EventSinkWriteError>,
  matches: (events: ReadonlyArray<OrchestrationV2DomainEvent>) => boolean = () => true,
) =>
  makeLayerTest(
    Layer.effect(
      EventSink.EventSinkV2,
      Effect.gen(function* () {
        const eventSink = yield* EventSink.EventSinkV2;
        const pending = [...errors];
        const failNext = <A, R>(
          events: ReadonlyArray<OrchestrationV2DomainEvent>,
          write: Effect.Effect<A, EventSink.EventSinkV2Error, R>,
        ) => Effect.suspend(() => (matches(events) ? (pending.shift() ?? write) : write));
        return EventSink.EventSinkV2.of({
          ...eventSink,
          write: (input) => failNext(input.events, eventSink.write(input)),
          writeIfRunCurrent: (input) => failNext(input.events, eventSink.writeIfRunCurrent(input)),
          writeIfProviderThreadOwner: (input) =>
            failNext(input.events, eventSink.writeIfProviderThreadOwner(input)),
        });
      }),
    ).pipe(Layer.provide(layerTestEventSink)),
  );


export const makeSharedWorktree = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "ingestor-worktree-" });
  const repo = `${directory}/repo`;
  const worktreePath = `${directory}/shared`;
  yield* fs.makeDirectory(repo);
  const command = (cwd: string, args: string[]) =>
    git.execute({ operation: "ingestor-test", cwd, args });
  yield* command(repo, ["init", "-b", "main"]);
  yield* command(repo, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.test",
    "commit",
    "--allow-empty",
    "-m",
    "initial",
  ]);
  yield* command(repo, ["worktree", "add", "-b", "t3/src/orchestration-v2/ProviderEventIngestor-fixtures.testkit/makeSharedWorktree", worktreePath]);
  return { repo, worktreePath, command };
});

export const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;

export const CODEX_DRIVER = ProviderDriverKind.make("codex");


export function threadCreatedEvent(
  now: DateTime.Utc,
): Effect.Effect<
  OrchestrationV2DomainEvent,
  IdAllocator.IdAllocatorV2Error,
  IdAllocator.IdAllocatorV2
> {
  return Effect.gen(function* () {
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
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
      branchPullRequest: null,
      activeOrderKey: null,
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
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
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

export const ingestCompletedProviderTurn = (
  guard: Pick<
    Parameters<ProviderEventIngestor.ProviderEventIngestorV2Shape["ingestNormalized"]>[0],
    "writeIfRunCurrent" | "writeIfProviderThreadOwner"
  >,
) =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const eventSink = yield* EventSink.EventSinkV2;
    const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
    const ingestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const threadEvent = yield* threadCreatedEvent(now);
    yield* eventSink.write({ events: [threadEvent] });
    const providerTurnId = ProviderTurnId.make("provider-turn:locked");
    const exit = yield* ingestor
      .ingestNormalized({
        providerSessionId: yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId: threadEvent.threadId,
        }),
        providerInstanceId: modelSelection.instanceId,
        threadId: threadEvent.threadId,
        event: {
          type: "provider_turn.updated",
          driver: CODEX_DRIVER,
          providerTurn: {
            id: providerTurnId,
            providerThreadId: ProviderThreadId.make("provider-thread:locked"),
            nodeId: NodeId.make("node:locked-turn"),
            runAttemptId: null,
            nativeTurnRef: null,
            ordinal: 1,
            status: "completed",
            startedAt: now,
            completedAt: now,
          },
        },
        ...guard,
      })
      .pipe(Effect.exit);
    const projection = yield* projectionStore.getThreadProjection(threadEvent.threadId);
    return { exit, providerTurnId, persisted: projection.providerTurns.map((turn) => turn.id) };
  });
