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
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import { OrchestrationEffectRequestV2 } from "../orchestration-v2/EffectOutbox.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as IdAllocator from "../orchestration-v2/IdAllocator.ts";
import * as LegacyV1ThreadImporter from "../orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
import * as ProjectionMaintenance from "../orchestration-v2/ProjectionMaintenance.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import { planThreadDeletion } from "../orchestration-v2/ThreadDeletion.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as ProjectEnrichmentService from "./ProjectEnrichmentService.ts";
import * as ProjectFaviconResolver from "./ProjectFaviconResolver.ts";
import * as ProjectService from "./ProjectService.ts";
import * as RepositoryIdentityResolver from "./RepositoryIdentityResolver.ts";

const layerEventPersistence = EventSink.layer.pipe(
  Layer.provideMerge(Layer.merge(EventStore.layer, ProjectionStore.layer)),
);
const layerServices = Layer.mergeAll(
  LegacyV1ThreadImporter.layer.pipe(Layer.provideMerge(layerEventPersistence)),
  ProjectionMaintenance.layer.pipe(Layer.provide(layerEventPersistence)),
  ProjectStore.layer,
  IdAllocator.layer,
  ThreadCommandExecutor.layer,
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
const layerDatabase = SqlitePersistence.layerMemory.pipe(
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
      const eventSink = yield* EventSink.EventSinkV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      yield* eventSink.write({
        events: threadIds.map((threadId) => nativeThreadCreated(projectId, threadId)),
      });
      const attempts: ThreadId[] = [];
      const failingEventSink = EventSink.EventSinkV2.of({
        ...eventSink,
        commitCommand: Effect.fn("ProjectDeletionTest.failSecondChild")(function* (
          input: Parameters<EventSink.EventSinkV2Shape["commitCommand"]>[0],
        ) {
          attempts.push(input.threadId);
          if (attempts.length === 2) {
            return yield* new EventSink.EventSinkWriteError({
              commandId: input.commandId,
              eventCount: input.events.length,
              cause: new Error("Injected failure for the second child"),
            });
          }
          return yield* eventSink.commitCommand(input);
        }),
      });
      const service = yield* ProjectService.make.pipe(
        Effect.provideService(EventSink.EventSinkV2, failingEventSink),
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
        const expectedCommandId = `${commandId}:delete-thread:${threadId}`;
        assert.deepEqual(
          finalCleanup.filter((effect) => effect.thread_id === threadId),
          [
            {
              effect_id: `effect:${expectedCommandId}:terminal.cleanup`,
              thread_id: threadId,
              command_id: expectedCommandId,
              effect_type: "terminal.cleanup",
            },
          ],
        );
      }
    }).pipe(Effect.provide(layerServices));
  }).pipe(Effect.provide(layerDatabase)),
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
        const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
        const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
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
          readonly v2_deleted_at: string | null;
          readonly project_deleted_at: string | null;
        }>`
        SELECT v2.deleted_at AS v2_deleted_at,
          project.deleted_at AS project_deleted_at
        FROM orchestration_v2_projection_threads AS v2
        JOIN projection_projects AS project ON project.project_id = v2.project_id
        WHERE v2.thread_id = ${threadId}
      `;
        assert.lengthOf(rows, 1);
        assert.isNotNull(rows[0]?.v2_deleted_at);
        assert.isNotNull(rows[0]?.project_deleted_at);
        // The legacy V1 row is only an import source; deletion writes V2 events only.
        const legacyEvents = yield* sql`
          SELECT sequence FROM orchestration_events
          WHERE application_event_version = 1 AND stream_id = ${threadId}
        `;
        assert.deepEqual(legacyEvents, []);

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
        assert.equal(cleanup[0]?.command_id, `${commandId}:delete-thread:${threadId}`);
        assert.equal(cleanup[0]?.status, "pending");
        const request = yield* decodeEffectRequest(cleanup[0]?.payload_json);
        assert.deepEqual(request, {
          type: "attachment.cleanup",
          attachmentIds: ["legacy_screenshot"],
        });
      }).pipe(Effect.provide(layerServices));
    }).pipe(Effect.provide(layerDatabase)),
);

it.effect("rejects a child deletion command ID already accepted for an unrelated thread", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const projectId = ProjectId.make("project:receipt-collision");
    const otherProjectId = ProjectId.make("project:unrelated-receipt");
    const threadId = ThreadId.make("thread:receipt-collision");
    const otherThreadId = ThreadId.make("thread:unrelated-receipt");
    const commandId = CommandId.make("command:collision-project-delete");
    yield* seedProject(projectId);
    yield* seedProject(otherProjectId);

    yield* Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const service = yield* ProjectService.make;
      yield* eventSink.write({ events: [nativeThreadCreated(projectId, threadId)] });
      const accepted = yield* eventSink.commitCommand({
        commandId: CommandId.make(`${commandId}:delete-thread:${threadId}`),
        commandType: "thread.create",
        threadId: otherThreadId,
        acceptedAt: DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"),
        events: [nativeThreadCreated(otherProjectId, otherThreadId)],
        effects: [],
      });
      assert.equal(accepted.receipt.status, "accepted");

      const failure = yield* service
        .delete({ commandId, projectId, force: true })
        .pipe(Effect.flip);
      assert.instanceOf(failure, ProjectService.ProjectOperationError);
      if (failure._tag !== "ProjectOperationError") return assert.fail("Expected a child failure");
      assert.equal(failure.operation, "delete-thread");
      assert.isTrue(Option.isSome(yield* service.getById(projectId)));
      assert.isNull((yield* projections.getThreadProjection(threadId)).thread.deletedAt);
      assert.isNull((yield* projections.getThreadProjection(otherThreadId)).thread.deletedAt);
      const deletions = yield* sql`
        SELECT sequence FROM orchestration_events
        WHERE event_type IN ('thread.deleted', 'project.deleted')
          AND stream_id IN (${threadId}, ${otherThreadId}, ${projectId})
      `;
      assert.deepEqual(deletions, []);
      const cleanup = yield* sql`
        SELECT effect_id FROM orchestration_v2_effect_outbox
        WHERE thread_id = ${threadId}
      `;
      assert.deepEqual(cleanup, []);
    }).pipe(Effect.provide(layerServices));
  }).pipe(Effect.provide(layerDatabase)),
);

it.effect("deletes a project without force once its imported threads were deleted in V2", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const projectId = ProjectId.make("project:imported-emptied");
    const threadId = ThreadId.make("thread:imported-emptied");
    yield* seedProject(projectId);
    // V2 never writes the V1 thread table, so this row stays live there.
    yield* sql`
      INSERT INTO projection_threads (
        thread_id, project_id, title, model_selection_json,
        runtime_mode, interaction_mode, branch, worktree_path, latest_turn_id,
        created_at, updated_at, archived_at, deleted_at
      ) VALUES (
        ${threadId}, ${projectId}, 'Imported thread', '{"instanceId":"codex","model":"gpt-5.4"}',
        'full-access', 'default', NULL, NULL, NULL,
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL, NULL
      )
    `;
    yield* TestClock.setTime(Date.parse("2026-09-04T12:00:00.000Z"));

    yield* Effect.gen(function* () {
      const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const service = yield* ProjectService.make;
      yield* importer.reconcileShells;
      const early = yield* service
        .delete({ commandId: CommandId.make("command:emptied:early"), projectId })
        .pipe(Effect.flip);
      assert.equal(early._tag, "ProjectNotEmptyError");

      // Delete the imported thread the way thread.delete does.
      yield* importer.ensureTranscript(threadId);
      const command = {
        type: "thread.delete" as const,
        commandId: CommandId.make("command:emptied:thread-delete"),
        threadId,
      };
      const now = yield* DateTime.now;
      const plan = yield* planThreadDeletion({
        command,
        projection: yield* projections.getThreadRecords(threadId, [
          "runs",
          "attempts",
          "nodes",
          "runtimeRequests",
          "subagents",
          "providerSessions",
        ]),
        attachmentIds: [],
        now,
        idAllocator,
      });
      yield* eventSink.commitCommand({
        commandId: command.commandId,
        commandType: command.type,
        threadId,
        acceptedAt: now,
        events: plan.events,
        effects: plan.effects,
      });
      const legacy = yield* sql<{ readonly deleted_at: string | null }>`
        SELECT deleted_at FROM projection_threads WHERE thread_id = ${threadId}
      `;
      assert.deepEqual(legacy, [{ deleted_at: null }]);

      const deleted = yield* service.delete({
        commandId: CommandId.make("command:emptied:project-delete"),
        projectId,
      });
      assert.isNotNull(deleted.deletedAt);
      assert.isTrue(Option.isNone(yield* service.getById(projectId)));
    }).pipe(Effect.provide(layerServices));
  }).pipe(Effect.provide(layerDatabase)),
);
