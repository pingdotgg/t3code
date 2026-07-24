import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import { assert, it as effectIt } from "@effect/vitest";
import { describe, expect, it } from "vite-plus/test";

import * as ServerConfig from "../../config.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  NoOpProviderEventLoggers,
  ProviderEventLoggers,
} from "../../provider/Layers/ProviderEventLoggers.ts";
import { ProviderValidationError } from "../../provider/Errors.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ProviderSessionDirectory } from "../../provider/Services/ProviderSessionDirectory.ts";
import { ProjectionThreadSessionRepository } from "../../persistence/Services/ProjectionThreadSessions.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import { decideOrchestrationCommand } from "../decider.ts";
import { createEmptyReadModel, projectEvent } from "../projector.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ThreadColdStorage, ThreadColdStorageError } from "../Services/ThreadColdStorage.ts";
import { ThreadDeletionReactor } from "../Services/ThreadDeletionReactor.ts";
import { ThreadColdStorageLive } from "./ThreadColdStorage.ts";
import {
  enqueueLifecycleJobOnce,
  logCleanupCauseUnlessInterrupted,
  THREAD_LIFECYCLE_RETRY_DELAY,
  ThreadDeletionReactorLive,
} from "./ThreadDeletionReactor.ts";

const archivedEvent = (threadId: ThreadId): OrchestrationEvent => ({
  sequence: 1,
  eventId: EventId.make(`event-archive-${threadId}`),
  aggregateKind: "thread",
  aggregateId: threadId,
  type: "thread.archived",
  occurredAt: "2026-07-20T00:00:00.000Z",
  commandId: CommandId.make(`command-archive-${threadId}`),
  causationEventId: null,
  correlationId: CommandId.make(`command-archive-${threadId}`),
  metadata: {},
  payload: {
    threadId,
    archivedAt: "2026-07-20T00:00:00.000Z",
    updatedAt: "2026-07-20T00:00:00.000Z",
  },
});

function testReactorLayer(input: {
  readonly eventStream: Stream.Stream<OrchestrationEvent>;
  readonly stopSession: ProviderService["Service"]["stopSession"];
  readonly getBinding: ProviderSessionDirectory["Service"]["getBinding"];
  readonly getProjectedSession: ProjectionThreadSessionRepository["Service"]["getByThreadId"];
  readonly archiveThread: ThreadColdStorage["Service"]["archiveThread"];
  readonly pendingArchives?: ReadonlyArray<ThreadId>;
}) {
  return ThreadDeletionReactorLive.pipe(
    Layer.provide(
      Layer.succeed(OrchestrationEngineService, {
        readEvents: () => Stream.empty,
        dispatch: () => Effect.succeed({ sequence: 0 }),
        streamDomainEvents: input.eventStream,
        latestSequence: Effect.succeed(0),
      }),
    ),
    Layer.provide(Layer.mock(ProviderService)({ stopSession: input.stopSession })),
    Layer.provide(
      Layer.mock(ProviderSessionDirectory)({
        getBinding: input.getBinding,
      }),
    ),
    Layer.provide(
      Layer.mock(ProjectionThreadSessionRepository)({
        getByThreadId: input.getProjectedSession,
      }),
    ),
    Layer.provide(
      Layer.mock(TerminalManager.TerminalManager)({
        close: () => Effect.void,
      }),
    ),
    Layer.provide(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
    Layer.provide(
      Layer.mock(ThreadColdStorage)({
        archiveThread: input.archiveThread,
        deleteThread: () => Effect.void,
        compactLegacyStorage: Effect.void,
        listPendingArchiveThreadIds: Effect.succeed(input.pendingArchives ?? []),
        listPendingDeleteThreadIds: Effect.succeed([]),
      }),
    ),
  );
}

describe("logCleanupCauseUnlessInterrupted", () => {
  const threadId = ThreadId.make("thread-deletion-reactor-test");

  it("swallows ordinary cleanup failures", async () => {
    const exit = await Effect.runPromiseExit(
      logCleanupCauseUnlessInterrupted({
        effect: Effect.fail("cleanup failed"),
        message: "thread deletion cleanup skipped provider session stop",
        threadId,
      }),
    );

    expect(Exit.isSuccess(exit)).toBe(true);
  });

  it("preserves interrupt causes", async () => {
    const exit = await Effect.runPromiseExit(
      logCleanupCauseUnlessInterrupted({
        effect: Effect.interrupt,
        message: "thread deletion cleanup skipped provider session stop",
        threadId,
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    }
  });
});

effectIt.effect("releases a lifecycle job reservation when enqueueing is interrupted", () =>
  Effect.gen(function* () {
    const scheduledJobs = new Set<string>();
    const enqueueCalls = yield* Ref.make(0);

    const interrupted = yield* Effect.exit(
      enqueueLifecycleJobOnce(scheduledJobs, "archive:thread-interrupted", Effect.interrupt),
    );
    expect(Exit.isFailure(interrupted)).toBe(true);
    expect(scheduledJobs.has("archive:thread-interrupted")).toBe(false);

    yield* enqueueLifecycleJobOnce(
      scheduledJobs,
      "archive:thread-interrupted",
      Ref.update(enqueueCalls, (count) => count + 1),
    );
    expect(yield* Ref.get(enqueueCalls)).toBe(1);
  }),
);

effectIt.effect("archives a settled thread when its provider binding is already absent", () =>
  Effect.gen(function* () {
    const events = yield* PubSub.unbounded<OrchestrationEvent>();
    const subscription = yield* PubSub.subscribe(events);
    const threadId = ThreadId.make("thread-archive-missing-binding");
    const archived = yield* Deferred.make<void>();
    const stopCalls = yield* Ref.make(0);
    const layer = testReactorLayer({
      eventStream: Stream.fromSubscription(subscription),
      stopSession: () => Ref.update(stopCalls, (count) => count + 1),
      getBinding: () => Effect.succeed(Option.none()),
      getProjectedSession: () => Effect.succeed(Option.none()),
      archiveThread: () => Deferred.succeed(archived, undefined).pipe(Effect.asVoid),
    });

    yield* Effect.gen(function* () {
      const reactor = yield* ThreadDeletionReactor;
      yield* reactor.start();
      yield* PubSub.publish(events, archivedEvent(threadId));
      yield* Deferred.await(archived);
      yield* reactor.drain;

      expect(yield* Ref.get(stopCalls)).toBe(0);
    }).pipe(Effect.provide(layer));
  }),
);

effectIt.effect(
  "keeps archive cleanup fail-closed without a binding for an active projection",
  () =>
    Effect.gen(function* () {
      const events = yield* PubSub.unbounded<OrchestrationEvent>();
      const subscription = yield* PubSub.subscribe(events);
      const threadId = ThreadId.make("thread-archive-active-missing-binding");
      const stopAttempted = yield* Deferred.make<void>();
      const archiveCalls = yield* Ref.make(0);
      const layer = testReactorLayer({
        eventStream: Stream.fromSubscription(subscription),
        stopSession: () =>
          Deferred.succeed(stopAttempted, undefined).pipe(
            Effect.andThen(
              Effect.fail(
                new ProviderValidationError({
                  operation: "ProviderService.stopSession",
                  issue: "missing provider binding",
                }),
              ),
            ),
          ),
        getBinding: () => Effect.succeed(Option.none()),
        getProjectedSession: () =>
          Effect.succeed(
            Option.some({
              threadId,
              status: "running",
              providerName: "codex",
              providerInstanceId: ProviderInstanceId.make("codex"),
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: null,
              updatedAt: "2026-07-20T00:00:00.000Z",
            }),
          ),
        archiveThread: () => Ref.update(archiveCalls, (count) => count + 1),
      });

      yield* Effect.gen(function* () {
        const reactor = yield* ThreadDeletionReactor;
        yield* reactor.start();
        yield* PubSub.publish(events, archivedEvent(threadId));
        yield* Deferred.await(stopAttempted);
        yield* reactor.drain;

        expect(yield* Ref.get(archiveCalls)).toBe(0);
      }).pipe(Effect.provide(layer));
    }),
);

effectIt.effect("retries a failed durable archive job after a delay", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread-archive-retry");
    const firstAttempt = yield* Deferred.make<void>();
    const secondAttempt = yield* Deferred.make<void>();
    const archiveAttempts = yield* Ref.make(0);
    const layer = testReactorLayer({
      eventStream: Stream.empty,
      stopSession: () => Effect.void,
      getBinding: () => Effect.succeed(Option.none()),
      getProjectedSession: () => Effect.succeed(Option.none()),
      pendingArchives: [threadId],
      archiveThread: () =>
        Ref.updateAndGet(archiveAttempts, (count) => count + 1).pipe(
          Effect.flatMap((attempt) =>
            attempt === 1
              ? Deferred.succeed(firstAttempt, undefined).pipe(
                  Effect.andThen(
                    Effect.fail(
                      new ThreadColdStorageError({
                        operation: "archive",
                        threadId,
                        cause: new Error("temporary archive failure"),
                      }),
                    ),
                  ),
                )
              : Deferred.succeed(secondAttempt, undefined).pipe(Effect.asVoid),
          ),
        ),
    });

    yield* Effect.gen(function* () {
      const reactor = yield* ThreadDeletionReactor;
      yield* reactor.start();
      yield* Deferred.await(firstAttempt);
      yield* reactor.drain;
      yield* Effect.yieldNow;
      yield* TestClock.adjust(THREAD_LIFECYCLE_RETRY_DELAY);
      yield* Deferred.await(secondAttempt);
      yield* reactor.drain;

      expect(yield* Ref.get(archiveAttempts)).toBe(2);
    }).pipe(Effect.provide(layer));
  }),
);

effectIt.effect("coalesces concurrent lifecycle failures into one delayed rescan", () =>
  Effect.gen(function* () {
    const firstThreadId = ThreadId.make("thread-archive-retry-first");
    const secondThreadId = ThreadId.make("thread-archive-retry-second");
    const retryCompleted = yield* Deferred.make<void>();
    const archiveAttempts = yield* Ref.make(0);
    const layer = testReactorLayer({
      eventStream: Stream.empty,
      stopSession: () => Effect.void,
      getBinding: () => Effect.succeed(Option.none()),
      getProjectedSession: () => Effect.succeed(Option.none()),
      pendingArchives: [firstThreadId, secondThreadId],
      archiveThread: (threadId) =>
        Ref.updateAndGet(archiveAttempts, (count) => count + 1).pipe(
          Effect.flatMap((attempt) => {
            if (attempt <= 2) {
              return Effect.fail(
                new ThreadColdStorageError({
                  operation: "archive",
                  threadId,
                  cause: new Error("temporary archive failure"),
                }),
              );
            }
            return attempt === 4
              ? Deferred.succeed(retryCompleted, undefined).pipe(Effect.asVoid)
              : Effect.void;
          }),
        ),
    });

    yield* Effect.gen(function* () {
      const reactor = yield* ThreadDeletionReactor;
      yield* reactor.start();
      yield* reactor.drain;
      expect(yield* Ref.get(archiveAttempts)).toBe(2);

      yield* TestClock.adjust(THREAD_LIFECYCLE_RETRY_DELAY);
      yield* Deferred.await(retryCompleted);
      yield* reactor.drain;
      expect(yield* Ref.get(archiveAttempts)).toBe(4);

      yield* TestClock.adjust(THREAD_LIFECYCLE_RETRY_DELAY);
      yield* Effect.yieldNow;
      yield* reactor.drain;
      expect(yield* Ref.get(archiveAttempts)).toBe(4);
    }).pipe(Effect.provide(layer));
  }),
);

effectIt.effect("force-deleting a project removes an already-cold archived thread", () =>
  Effect.gen(function* () {
    const events = yield* PubSub.unbounded<OrchestrationEvent>();
    const eventSubscription = yield* PubSub.subscribe(events);
    const now = "2026-07-20T00:00:00.000Z";
    const projectId = ProjectId.make("project-force-delete-cold");
    const threadId = ThreadId.make("thread-force-delete-cold");
    const commandId = CommandId.make("command-force-delete-cold");
    const deleteStarted = yield* Deferred.make<void>();

    const orchestrationEngineLayer = Layer.succeed(OrchestrationEngineService, {
      readEvents: () => Stream.empty,
      dispatch: () => Effect.succeed({ sequence: 0 }),
      streamDomainEvents: Stream.fromSubscription(eventSubscription),
      latestSequence: Effect.succeed(0),
    });
    const providerLayer = Layer.mock(ProviderService)({
      stopSession: () => Deferred.succeed(deleteStarted, undefined).pipe(Effect.asVoid),
    });
    const terminalLayer = Layer.mock(TerminalManager.TerminalManager)({
      close: () => Effect.void,
    });
    const loggerLayer = Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers);
    const coldStorageLayer = ThreadColdStorageLive.pipe(
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-force-delete-cold-" }),
      ),
      Layer.provideMerge(NodeServices.layer),
    );
    const runtimeLayer = ThreadDeletionReactorLive.pipe(
      Layer.provide(orchestrationEngineLayer),
      Layer.provide(providerLayer),
      Layer.provide(
        Layer.mock(ProviderSessionDirectory)({
          getBinding: () => Effect.succeed(Option.none()),
        }),
      ),
      Layer.provide(
        Layer.mock(ProjectionThreadSessionRepository)({
          getByThreadId: () => Effect.succeed(Option.none()),
        }),
      ),
      Layer.provide(terminalLayer),
      Layer.provide(loggerLayer),
      Layer.provideMerge(coldStorageLayer),
    );

    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const storage = yield* ThreadColdStorage;
      const reactor = yield* ThreadDeletionReactor;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          interaction_mode, created_at, updated_at, archived_at
        ) VALUES (
          ${threadId}, ${projectId}, 'Cold forced-delete thread',
          '{"instanceId":"codex","model":"gpt-5.5","options":[]}',
          'full-access', 'default', ${now}, ${now}, ${now}
        )
      `;
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, turn_id, role, text, attachments_json,
          is_streaming, created_at, updated_at
        ) VALUES (
          'message-force-delete-cold', ${threadId}, NULL, 'user',
          'delete this cold content', '[]', 0, ${now}, ${now}
        )
      `;
      yield* storage.archiveThread(threadId);
      const coldShells = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM projection_threads WHERE thread_id = ${threadId}
      `;
      const coldManifests = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM thread_archive_manifests WHERE thread_id = ${threadId}
      `;
      const coldChunks = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM cold_archive.archive_thread_chunks WHERE thread_id = ${threadId}
      `;
      assert.deepStrictEqual(coldShells, [{ count: 1 }]);
      assert.deepStrictEqual(coldManifests, [{ count: 1 }]);
      assert.isAbove(coldChunks[0]?.count ?? 0, 0);

      let readModel = createEmptyReadModel(now);
      readModel = yield* projectEvent(readModel, {
        sequence: 1,
        eventId: EventId.make("event-force-delete-project-created"),
        aggregateKind: "project",
        aggregateId: projectId,
        type: "project.created",
        occurredAt: now,
        commandId: CommandId.make("command-force-delete-project-created"),
        causationEventId: null,
        correlationId: CommandId.make("command-force-delete-project-created"),
        metadata: {},
        payload: {
          projectId,
          title: "Force Delete Cold",
          workspaceRoot: "/tmp/project-force-delete-cold",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });
      readModel = yield* projectEvent(readModel, {
        sequence: 2,
        eventId: EventId.make("event-force-delete-thread-created"),
        aggregateKind: "thread",
        aggregateId: threadId,
        type: "thread.created",
        occurredAt: now,
        commandId: CommandId.make("command-force-delete-thread-created"),
        causationEventId: null,
        correlationId: CommandId.make("command-force-delete-thread-created"),
        metadata: {},
        payload: {
          threadId,
          projectId,
          title: "Cold forced-delete thread",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.5",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      });
      readModel = yield* projectEvent(readModel, {
        sequence: 3,
        eventId: EventId.make("event-force-delete-thread-archived"),
        aggregateKind: "thread",
        aggregateId: threadId,
        type: "thread.archived",
        occurredAt: now,
        commandId: CommandId.make("command-force-delete-thread-archived"),
        causationEventId: null,
        correlationId: CommandId.make("command-force-delete-thread-archived"),
        metadata: {},
        payload: { threadId, archivedAt: now, updatedAt: now },
      });

      const planned = yield* decideOrchestrationCommand({
        command: { type: "project.delete", commandId, projectId, force: true },
        readModel,
      });
      const plannedEvents = Array.isArray(planned) ? planned : [planned];
      const deletedEvent = plannedEvents.find(
        (event): event is Extract<(typeof plannedEvents)[number], { type: "thread.deleted" }> =>
          event.type === "thread.deleted" && event.payload.threadId === threadId,
      );
      assert.isDefined(deletedEvent);

      yield* reactor.start();
      yield* PubSub.publish(events, { ...deletedEvent, sequence: 4 });
      yield* Deferred.await(deleteStarted);
      yield* reactor.drain;

      const hotRows = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM projection_threads WHERE thread_id = ${threadId}
      `;
      const manifests = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM thread_archive_manifests WHERE thread_id = ${threadId}
      `;
      const chunks = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM cold_archive.archive_thread_chunks WHERE thread_id = ${threadId}
      `;
      assert.deepStrictEqual(hotRows, [{ count: 0 }]);
      assert.deepStrictEqual(manifests, [{ count: 0 }]);
      assert.deepStrictEqual(chunks, [{ count: 0 }]);
    }).pipe(Effect.provide(runtimeLayer));
  }),
);
