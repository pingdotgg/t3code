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
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { assert, it as effectIt } from "@effect/vitest";
import { describe, expect, it } from "vite-plus/test";

import * as ServerConfig from "../../config.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  NoOpProviderEventLoggers,
  ProviderEventLoggers,
} from "../../provider/Layers/ProviderEventLoggers.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import { decideOrchestrationCommand } from "../decider.ts";
import { createEmptyReadModel, projectEvent } from "../projector.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ThreadColdStorage } from "../Services/ThreadColdStorage.ts";
import { ThreadDeletionReactor } from "../Services/ThreadDeletionReactor.ts";
import { ThreadColdStorageLive } from "./ThreadColdStorage.ts";
import {
  logCleanupCauseUnlessInterrupted,
  ThreadDeletionReactorLive,
} from "./ThreadDeletionReactor.ts";

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
