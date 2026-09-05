import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  type OrchestrationV2AppThread,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { TestClock } from "effect/testing";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../config.ts";
import { OrchestrationLayerLive } from "../orchestration/runtimeLayer.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { OrchestrationEffectRequestV2 } from "../orchestration-v2/EffectOutbox.ts";
import {
  EventSinkV2,
  type EventSinkV2Shape,
  EventSinkWriteError,
  layer as eventSinkLayer,
} from "../orchestration-v2/EventSink.ts";
import { layer as eventStoreLayer } from "../orchestration-v2/EventStore.ts";
import { layer as idAllocatorLayer } from "../orchestration-v2/IdAllocator.ts";
import {
  LegacyV1ThreadImporter,
  layer as legacyImporterLayer,
} from "../orchestration-v2/LegacyV1ThreadImporter.ts";
import {
  ProjectionMaintenanceV2,
  layer as projectionMaintenanceLayer,
} from "../orchestration-v2/ProjectionMaintenance.ts";
import {
  ProjectionStoreV2,
  layer as projectionStoreLayer,
} from "../orchestration-v2/ProjectionStore.ts";
import { layer as threadCommandExecutorLayer } from "../orchestration-v2/ThreadCommandExecutor.ts";
import { ProjectionProjectRepositoryLive } from "../persistence/Layers/ProjectionProjects.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as ProjectEnrichmentService from "./ProjectEnrichmentService.ts";
import * as ProjectFaviconResolver from "./ProjectFaviconResolver.ts";
import * as ProjectService from "./ProjectService.ts";
import * as RepositoryIdentityResolver from "./RepositoryIdentityResolver.ts";

const eventPersistenceLayer = eventSinkLayer.pipe(
  Layer.provideMerge(Layer.merge(eventStoreLayer, projectionStoreLayer)),
);
const servicesLayer = Layer.mergeAll(
  legacyImporterLayer.pipe(Layer.provideMerge(eventPersistenceLayer)),
  projectionMaintenanceLayer.pipe(Layer.provide(eventPersistenceLayer)),
  OrchestrationLayerLive,
  ProjectionProjectRepositoryLive,
  idAllocatorLayer,
  threadCommandExecutorLayer,
  Layer.succeed(WorkspacePaths.WorkspacePaths, {
    normalizeWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
    resolveRelativePathWithinRoot: ({ workspaceRoot, relativePath }) =>
      Effect.succeed({ absolutePath: `${workspaceRoot}/${relativePath}`, relativePath }),
  }),
).pipe(
  Layer.provideMerge(
    ProjectEnrichmentService.layer.pipe(
      Layer.provide(
        Layer.merge(
          Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
            resolve: () => Effect.succeed(null),
          }),
          Layer.succeed(ProjectFaviconResolver.ProjectFaviconResolver, {
            resolvePath: () => Effect.succeed(null),
          }),
        ),
      ),
    ),
  ),
);
const databaseLayer = SqlitePersistenceMemory.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "project-deletion-test-" })),
  Layer.provideMerge(NodeServices.layer),
);
const decodeEffectRequest = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationEffectRequestV2),
);

const seedProject = Effect.fn("ProjectDeletionTest.seedProject")(function* (projectId: ProjectId) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO projection_projects (
      project_id, title, workspace_root, default_model_selection_json,
      scripts_json, created_at, updated_at, deleted_at
    ) VALUES (
      ${projectId}, 'Deletion test', ${`/work/${projectId}`}, NULL,
      '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL
    )
  `;
});

function nativeThreadCreated(projectId: ProjectId, threadId: ThreadId) {
  const createdAt = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");
  const providerInstanceId = ProviderInstanceId.make("codex");
  const payload: OrchestrationV2AppThread = {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId,
    title: threadId,
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt,
    updatedAt: createdAt,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
  return {
    id: EventId.make(`created:${threadId}`),
    type: "thread.created" as const,
    threadId,
    providerInstanceId,
    occurredAt: createdAt,
    payload,
  };
}

it.effect("retries a partial project deletion without repeating child events or cleanup", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const projectId = ProjectId.make("project:partial-deletion");
    const threadIds = [ThreadId.make("thread:delete-a"), ThreadId.make("thread:delete-b")] as const;
    const commandId = CommandId.make("command:partial-project-delete");
    yield* seedProject(projectId);
    yield* TestClock.setTime(Date.parse("2026-09-04T12:00:00.000Z"));

    yield* Effect.gen(function* () {
      const eventSink = yield* EventSinkV2;
      const projections = yield* ProjectionStoreV2;
      yield* eventSink.write({
        events: threadIds.map((threadId) => nativeThreadCreated(projectId, threadId)),
      });
      const attempts: ThreadId[] = [];
      const failingEventSink = EventSinkV2.of({
        ...eventSink,
        commitCommand: Effect.fn("ProjectDeletionTest.failSecondChild")(function* (
          input: Parameters<EventSinkV2Shape["commitCommand"]>[0],
        ) {
          attempts.push(input.threadId);
          if (attempts.length === 2) {
            return yield* new EventSinkWriteError({
              commandId: input.commandId,
              eventCount: input.events.length,
              cause: new Error("Injected failure for the second child"),
            });
          }
          return yield* eventSink.commitCommand(input);
        }),
      });
      const service = yield* ProjectService.make.pipe(
        Effect.provideService(EventSinkV2, failingEventSink),
      );
      const input = { commandId, projectId, force: true };
      const failure = yield* service.delete(input).pipe(Effect.flip);
      assert.instanceOf(failure, ProjectService.ProjectOperationError);
      if (failure._tag !== "ProjectOperationError") return assert.fail("Expected a child failure");
      assert.equal(failure.operation, "delete-thread");
      assert.lengthOf(attempts, 2);
      const firstThreadId = attempts[0] ?? assert.fail("The first child was not attempted");
      const failedThreadId = attempts[1] ?? assert.fail("The second child was not attempted");
      assert.notEqual(firstThreadId, failedThreadId);
      assert.isTrue(Option.isSome(yield* service.getById(projectId)));
      assert.isNotNull((yield* projections.getThreadProjection(firstThreadId)).thread.deletedAt);
      assert.isNull((yield* projections.getThreadProjection(failedThreadId)).thread.deletedAt);

      const readDeletions = sql<{
        readonly sequence: number;
        readonly stream_id: string;
        readonly command_id: string;
        readonly event_type: string;
      }>`
        SELECT sequence, stream_id, command_id, event_type
        FROM orchestration_events
        WHERE event_type IN ('thread.deleted', 'project.deleted')
          AND stream_id IN (${threadIds[0]}, ${threadIds[1]}, ${projectId})
        ORDER BY sequence ASC
      `;
      const readCleanup = sql<{
        readonly effect_id: string;
        readonly thread_id: string;
        readonly command_id: string;
        readonly effect_type: string;
      }>`
        SELECT effect_id, thread_id, command_id, effect_type
        FROM orchestration_v2_effect_outbox
        WHERE thread_id IN (${threadIds[0]}, ${threadIds[1]})
        ORDER BY effect_id ASC
      `;
      const partialEvents = yield* readDeletions;
      const partialCleanup = yield* readCleanup;
      assert.lengthOf(partialEvents, 1);
      assert.equal(partialEvents[0]?.stream_id, firstThreadId);
      assert.equal(partialEvents[0]?.event_type, "thread.deleted");
      assert.lengthOf(partialCleanup, 1);
      assert.equal(partialCleanup[0]?.thread_id, firstThreadId);
      assert.equal(partialCleanup[0]?.effect_type, "terminal.cleanup");

      const deletedProject = yield* service.delete(input);
      assert.isNotNull(deletedProject.deletedAt);
      assert.isTrue(Option.isNone(yield* service.getById(projectId)));
      assert.deepEqual(attempts, [firstThreadId, failedThreadId, failedThreadId]);
      for (const threadId of threadIds) {
        assert.isNotNull((yield* projections.getThreadProjection(threadId)).thread.deletedAt);
      }
      const finalEvents = yield* readDeletions;
      assert.deepEqual(
        finalEvents.map((event) => [event.stream_id, event.event_type]),
        [
          [firstThreadId, "thread.deleted"],
          [failedThreadId, "thread.deleted"],
          [projectId, "project.deleted"],
        ],
      );
      assert.deepEqual(finalEvents[0], partialEvents[0]);
      assert.equal(finalEvents[2]?.command_id, commandId);
      const finalCleanup = yield* readCleanup;
      assert.lengthOf(finalCleanup, 2);
      assert.deepEqual(
        finalCleanup.filter((effect) => effect.thread_id === firstThreadId),
        partialCleanup,
      );
      for (const threadId of threadIds) {
        const deletedEvent = finalEvents.find((event) => event.stream_id === threadId);
        assert.isDefined(deletedEvent);
        assert.deepEqual(
          finalCleanup.filter((effect) => effect.thread_id === threadId),
          [
            {
              effect_id: `effect:${deletedEvent.command_id}:terminal.cleanup`,
              thread_id: threadId,
              command_id: deletedEvent.command_id,
              effect_type: "terminal.cleanup",
            },
          ],
        );
      }
    }).pipe(Effect.provide(servicesLayer));
  }).pipe(Effect.provide(databaseLayer)),
);

it.effect(
  "hydrates a migrated transcript before deleting its project and cleaning attachments",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const projectId = ProjectId.make("project:legacy-deletion");
      const threadId = ThreadId.make("thread:legacy-deletion");
      const commandId = CommandId.make("command:legacy-project-delete");
      yield* seedProject(projectId);
      yield* sql`
      INSERT INTO projection_threads (
        thread_id, project_id, title, model_selection_json,
        runtime_mode, interaction_mode, branch, worktree_path, latest_turn_id,
        created_at, updated_at, archived_at, deleted_at
      ) VALUES (
        ${threadId}, ${projectId}, 'Legacy thread', '{"instanceId":"codex","model":"gpt-5.4"}',
        'full-access', 'default', NULL, NULL, NULL,
        '2026-01-01T00:00:00.000Z', '2026-01-04T00:00:00.000Z', NULL, NULL
      )
    `;
      yield* sql`
      INSERT INTO projection_thread_messages (
        message_id, thread_id, turn_id, role, text, attachments_json,
        is_streaming, created_at, updated_at
      ) VALUES
        (
          'message:legacy-delete:1', ${threadId}, NULL, 'user', 'First question with screenshot',
          '[{"type":"image","id":"legacy_screenshot","name":"screenshot.png","mimeType":"image/png","sizeBytes":128}]',
          0, '2026-01-01T01:00:00.000Z', '2026-01-01T01:00:00.000Z'
        ),
        (
          'message:legacy-delete:2', ${threadId}, NULL, 'assistant', 'First answer', '[]',
          0, '2026-01-02T01:00:00.000Z', '2026-01-02T01:00:00.000Z'
        ),
        (
          'message:legacy-delete:3', ${threadId}, NULL, 'user', 'Follow-up question', '[]',
          0, '2026-01-03T01:00:00.000Z', '2026-01-03T01:00:00.000Z'
        ),
        (
          'message:legacy-delete:4', ${threadId}, NULL, 'assistant', 'Follow-up answer', '[]',
          0, '2026-01-04T01:00:00.000Z', '2026-01-04T01:00:00.000Z'
        )
    `;
      yield* TestClock.setTime(Date.parse("2026-09-04T12:00:00.000Z"));

      // Build the engine after seeding the legacy database, as on a real restart.
      yield* Effect.gen(function* () {
        const importer = yield* LegacyV1ThreadImporter;
        const maintenance = yield* ProjectionMaintenanceV2;
        const projections = yield* ProjectionStoreV2;
        const service = yield* ProjectService.make;
        assert.deepEqual(yield* importer.reconcileShells, {
          importedThreadCount: 1,
          importedMessageCount: 2,
        });
        assert.equal(yield* importer.pendingThreadCount, 1);
        assert.isTrue((yield* maintenance.rebuild).valid);
        const shellProjection = yield* projections.getThreadProjection(threadId);
        assert.deepEqual(
          shellProjection.messages.map((message) => message.id),
          ["message:legacy-delete:3", "message:legacy-delete:4"],
        );
        assert.deepEqual(
          shellProjection.messages.flatMap((message) => message.attachments),
          [],
        );

        const deletedProject = yield* service.delete({ commandId, projectId, force: true });
        assert.isNotNull(deletedProject.deletedAt);
        assert.isTrue(Option.isNone(yield* service.getById(projectId)));
        const projection = yield* projections.getThreadProjection(threadId);
        assert.isNotNull(projection.thread.deletedAt);
        assert.lengthOf(projection.messages, 4);
        assert.equal(yield* importer.pendingThreadCount, 0);
        const rows = yield* sql<{
          readonly legacy_deleted_at: string | null;
          readonly v2_deleted_at: string | null;
          readonly project_deleted_at: string | null;
        }>`
        SELECT legacy.deleted_at AS legacy_deleted_at,
          v2.deleted_at AS v2_deleted_at,
          project.deleted_at AS project_deleted_at
        FROM projection_threads AS legacy
        JOIN orchestration_v2_projection_threads AS v2 ON v2.thread_id = legacy.thread_id
        JOIN projection_projects AS project ON project.project_id = legacy.project_id
        WHERE legacy.thread_id = ${threadId}
      `;
        assert.lengthOf(rows, 1);
        assert.isNotNull(rows[0]?.legacy_deleted_at);
        assert.isNotNull(rows[0]?.v2_deleted_at);
        assert.isNotNull(rows[0]?.project_deleted_at);

        const cleanup = yield* sql<{
          readonly command_id: string;
          readonly payload_json: string;
          readonly status: string;
        }>`
        SELECT command_id, payload_json, status
        FROM orchestration_v2_effect_outbox
        WHERE thread_id = ${threadId} AND effect_type = 'attachment.cleanup'
      `;
        assert.lengthOf(cleanup, 1);
        const deletionEvents = yield* sql<{ readonly command_id: string }>`
          SELECT command_id
          FROM orchestration_events
          WHERE stream_id = ${threadId}
            AND event_type = 'thread.deleted'
            AND application_event_version = 2
        `;
        assert.lengthOf(deletionEvents, 1);
        assert.equal(cleanup[0]?.command_id, deletionEvents[0]?.command_id);
        assert.equal(cleanup[0]?.status, "pending");
        const request = yield* decodeEffectRequest(cleanup[0]?.payload_json);
        assert.deepEqual(request, {
          type: "attachment.cleanup",
          attachmentIds: ["legacy_screenshot"],
        });
      }).pipe(Effect.provide(servicesLayer));
    }).pipe(Effect.provide(databaseLayer)),
);

it.effect("retries a rejected child deletion with a fresh command ID", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const projectId = ProjectId.make("project:rejected-child-retry");
    const threadId = ThreadId.make("thread:rejected-child-retry");
    const commandId = CommandId.make("command:rejected-child-retry");
    yield* seedProject(projectId);

    yield* Effect.gen(function* () {
      const eventSink = yield* EventSinkV2;
      const projections = yield* ProjectionStoreV2;
      yield* eventSink.write({ events: [nativeThreadCreated(projectId, threadId)] });
      const attempts: CommandId[] = [];
      let rejectedCommandId: CommandId | undefined;
      const rejectingEventSink = EventSinkV2.of({
        ...eventSink,
        commitCommand: Effect.fn("ProjectDeletionTest.rejectFirstChild")(function* (
          input: Parameters<EventSinkV2Shape["commitCommand"]>[0],
        ) {
          attempts.push(input.commandId);
          if (rejectedCommandId === undefined) {
            rejectedCommandId = input.commandId;
            const receipt = yield* eventSink.commitRejectedCommand({
              commandId: input.commandId,
              threadId: input.threadId,
              commandType: input.commandType,
              rejectedAt: input.acceptedAt,
              error: "Injected child rejection",
            });
            return {
              receipt,
              storedEvents: [],
              committed: false,
              cancelledEffectCount: 0,
            };
          }
          return yield* eventSink.commitCommand(input);
        }),
      });
      const service = yield* ProjectService.make.pipe(
        Effect.provideService(EventSinkV2, rejectingEventSink),
      );

      const failure = yield* service
        .delete({ commandId, projectId, force: true })
        .pipe(Effect.flip);
      assert.instanceOf(failure, ProjectService.ProjectOperationError);
      if (failure._tag !== "ProjectOperationError") return assert.fail("Expected a child failure");
      assert.equal(failure.operation, "delete-thread");
      assert.isTrue(Option.isSome(yield* service.getById(projectId)));
      assert.isNull((yield* projections.getThreadProjection(threadId)).thread.deletedAt);

      const deleted = yield* service.delete({ commandId, projectId, force: true });
      assert.isNotNull(deleted.deletedAt);
      assert.lengthOf(attempts, 2);
      assert.notEqual(attempts[0], attempts[1]);
      assert.equal(attempts[0], rejectedCommandId);
      const successfulCommandId = attempts[1] ?? assert.fail("Retry was not attempted");
      assert.isNotNull((yield* projections.getThreadProjection(threadId)).thread.deletedAt);
      const deletionEvents = yield* sql<{ readonly command_id: string }>`
        SELECT command_id
        FROM orchestration_events
        WHERE stream_id = ${threadId} AND event_type = 'thread.deleted'
      `;
      assert.deepEqual(deletionEvents, [{ command_id: successfulCommandId }]);
    }).pipe(Effect.provide(servicesLayer));
  }).pipe(Effect.provide(databaseLayer)),
);

it.effect("rejects a parent command receipt with the wrong type before deleting children", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const projectId = ProjectId.make("project:wrong-parent-receipt");
    const threadId = ThreadId.make("thread:wrong-parent-receipt");
    const commandId = CommandId.make("command:wrong-parent-receipt");
    yield* seedProject(projectId);

    yield* Effect.gen(function* () {
      const eventSink = yield* EventSinkV2;
      const projections = yield* ProjectionStoreV2;
      const service = yield* ProjectService.make;
      yield* eventSink.write({ events: [nativeThreadCreated(projectId, threadId)] });
      yield* service.update({ commandId, projectId, title: "Updated title" });

      const failure = yield* service
        .delete({ commandId, projectId, force: true })
        .pipe(Effect.flip);
      assert.instanceOf(failure, ProjectService.ProjectOperationError);
      if (failure._tag !== "ProjectOperationError") return assert.fail("Expected receipt conflict");
      assert.equal(failure.operation, "dispatch-project-command");
      assert.isTrue(Option.isSome(yield* service.getById(projectId)));
      assert.isNull((yield* projections.getThreadProjection(threadId)).thread.deletedAt);
      const deletionEvents = yield* sql`
        SELECT sequence
        FROM orchestration_events
        WHERE event_type IN ('thread.deleted', 'project.deleted')
          AND stream_id IN (${threadId}, ${projectId})
      `;
      assert.deepEqual(deletionEvents, []);
    }).pipe(Effect.provide(servicesLayer));
  }).pipe(Effect.provide(databaseLayer)),
);

it.effect("rejects a parent receipt committed after the deletion preflight", () =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("project:racing-parent-receipt");
    const threadId = ThreadId.make("thread:racing-parent-receipt");
    const commandId = CommandId.make("command:racing-parent-receipt");
    yield* seedProject(projectId);

    yield* Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const eventSink = yield* EventSinkV2;
      const projections = yield* ProjectionStoreV2;
      yield* eventSink.write({ events: [nativeThreadCreated(projectId, threadId)] });
      let injectedReceipt = false;
      const racingEventSink = EventSinkV2.of({
        ...eventSink,
        commitCommand: Effect.fn("ProjectDeletionTest.commitRacingParentReceipt")(function* (
          input: Parameters<EventSinkV2Shape["commitCommand"]>[0],
        ) {
          const result = yield* eventSink.commitCommand(input);
          if (!injectedReceipt) {
            injectedReceipt = true;
            yield* engine
              .dispatch({
                type: "project.meta.update",
                commandId,
                projectId,
                title: "Concurrent update",
              })
              .pipe(Effect.orDie);
          }
          return result;
        }),
      });
      const service = yield* ProjectService.make.pipe(
        Effect.provideService(EventSinkV2, racingEventSink),
      );

      const failure = yield* service
        .delete({ commandId, projectId, force: true })
        .pipe(Effect.flip);
      assert.equal(failure._tag, "ProjectOperationError");
      if (failure._tag !== "ProjectOperationError") return assert.fail("Expected receipt conflict");
      assert.equal(failure.operation, "dispatch-project-command");
      assert.isTrue(Option.isSome(yield* service.getById(projectId)));
      assert.isNotNull((yield* projections.getThreadProjection(threadId)).thread.deletedAt);

      const retry = yield* service.delete({
        commandId: CommandId.make("command:racing-parent-receipt-retry"),
        projectId,
        force: true,
      });
      assert.isNotNull(retry.deletedAt);
    }).pipe(Effect.provide(servicesLayer));
  }).pipe(Effect.provide(databaseLayer)),
);

it.effect("replays an accepted deletion before checking project existence", () =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("project:accepted-delete-replay");
    const commandId = CommandId.make("command:accepted-delete-replay");
    yield* seedProject(projectId);

    yield* Effect.gen(function* () {
      const service = yield* ProjectService.make;
      const input = { commandId, projectId, force: true } as const;
      const deleted = yield* service.delete(input);
      assert.isNotNull(deleted.deletedAt);
      assert.isTrue(Option.isNone(yield* service.getById(projectId)));
      assert.deepEqual(yield* service.delete(input), deleted);
    }).pipe(Effect.provide(servicesLayer));
  }).pipe(Effect.provide(databaseLayer)),
);

it.effect("prevents either commit order from orphaning a V2 thread", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const projectId = ProjectId.make("project:commit-order-guard");
    const threadId = ThreadId.make("thread:commit-order-existing");
    const lateThreadId = ThreadId.make("thread:commit-order-late");
    const commandId = CommandId.make("command:commit-order-delete");
    yield* seedProject(projectId);

    yield* Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const eventSink = yield* EventSinkV2;
      const projections = yield* ProjectionStoreV2;
      const service = yield* ProjectService.make;
      yield* eventSink.write({ events: [nativeThreadCreated(projectId, threadId)] });

      const blockedDelete = yield* engine
        .dispatch({ type: "project.delete", commandId, projectId, force: true })
        .pipe(Effect.flip);
      assert.equal(blockedDelete._tag, "PersistenceSqlError");
      assert.isTrue(Option.isSome(yield* service.getById(projectId)));

      const deleted = yield* service.delete({ commandId, projectId, force: true });
      assert.isNotNull(deleted.deletedAt);
      assert.isNotNull((yield* projections.getThreadProjection(threadId)).thread.deletedAt);

      const blockedCreate = yield* eventSink
        .write({ events: [nativeThreadCreated(projectId, lateThreadId)] })
        .pipe(Effect.flip);
      assert.instanceOf(blockedCreate, EventSinkWriteError);
      const lateThreads = yield* sql`
        SELECT thread_id
        FROM orchestration_v2_projection_threads
        WHERE thread_id = ${lateThreadId}
      `;
      assert.deepEqual(lateThreads, []);
    }).pipe(Effect.provide(servicesLayer));
  }).pipe(Effect.provide(databaseLayer)),
);
