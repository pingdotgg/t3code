import { assert, it } from "@effect/vitest";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";

import * as ProjectEnrichment from "./project/ProjectEnrichmentService.ts";
import * as ProjectService from "./project/ProjectService.ts";
import * as ProjectStore from "./orchestration-v2/ProjectStore.ts";
import * as ThreadManagement from "./orchestration-v2/ThreadManagementService.ts";
import * as OrchestrationEventStore from "./persistence/OrchestrationEventStore.ts";
import * as SqlitePersistence from "./persistence/Sqlite.ts";
import { subscribeOrchestrationV2Shell } from "./ws.ts";

const ReplayTestLayer = OrchestrationEventStore.layer.pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);

it.effect("shell resume below the history replay floor sends a snapshot", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const now = "2026-01-05T00:00:00.000Z";
    const projectId = ProjectId.make("project:retention-floor");
    const insert = (version: number) => sql<{ readonly sequence: number }>`
      INSERT INTO orchestration_events (
        event_id, aggregate_kind, stream_id, stream_version, event_type,
        occurred_at, actor_kind, payload_json, metadata_json, application_event_version
      ) VALUES (
        ${`retention-floor:${version}`}, 'project', ${projectId}, ${version}, 'project.meta-updated',
        ${now}, 'server', ${JSON.stringify({ projectId, updatedAt: now })}, '{}', 2
      ) RETURNING sequence
    `;
    const [before] = yield* insert(0);
    const [after] = yield* insert(1);
    const resume = subscribeOrchestrationV2Shell({
      afterSequence: before!.sequence,
      requestCompletionMarker: true,
    }).pipe(
      Effect.flatMap((stream) =>
        stream.pipe(
          Stream.takeUntil((item) => item.kind === "synchronized"),
          Stream.map((item) => item.kind as string),
          Stream.runCollect,
        ),
      ),
      Effect.provideService(ThreadManagement.ThreadManagementService, {
        listActiveShellIndex: () => Effect.succeed([]),
        readShellSnapshot: () => Effect.succeed(Effect.succeed({ schemaVersion: 1, threads: [] })),
        listActiveSubagentThreadIds: () => Effect.succeed([]),
      } as unknown as ThreadManagement.ThreadManagementService["Service"]),
      Effect.provideService(ProjectStore.ProjectStoreV2, {
        listShells: () => Effect.succeed([]),
      } as unknown as ProjectStore.ProjectStoreV2["Service"]),
      Effect.provideService(ProjectService.ProjectService, {
        getShell: () => Effect.succeedNone,
      } as unknown as ProjectService.ProjectService["Service"]),
      Effect.provideService(ProjectEnrichment.ProjectEnrichmentService, {
        subscribeChanges: PubSub.subscribe(yield* PubSub.unbounded()),
      } as ProjectEnrichment.ProjectEnrichmentService["Service"]),
    );
    assert.deepEqual(Array.from(yield* resume), ["project.removed", "synchronized"]);
    yield* sql`
      INSERT INTO orchestration_v2_event_retention (thread_id, replay_floor)
      VALUES ('thread:pruned', ${after!.sequence})
    `;
    assert.deepEqual(Array.from(yield* resume), ["snapshot", "synchronized"]);
  }).pipe(Effect.scoped, Effect.provide(ReplayTestLayer)),
);

it.effect("shell resume falls back when retention commits during the replay read", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-01-05T00:00:00.000Z";
      const projectId = ProjectId.make("project:retention-race");
      const threadId = ThreadId.make("thread:retention-race");
      const insertProject = (version: number) => sql<{ readonly sequence: number }>`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, actor_kind, payload_json, metadata_json, application_event_version
        ) VALUES (
          ${`retention-race:project:${version}`}, 'project', ${projectId}, ${version}, 'project.meta-updated',
          ${now}, 'server', ${JSON.stringify({ projectId, updatedAt: now })}, '{}', 2
        ) RETURNING sequence
      `;
      const [before] = yield* insertProject(0);
      const [pruned] = yield* sql<{ readonly sequence: number }>`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, actor_kind, payload_json, metadata_json, application_event_version
        ) VALUES (
          'retention-race:thread', 'thread', ${threadId}, 0, 'thread.metadata-updated',
          ${now}, 'server', '{}', '{}', 2
        ) RETURNING sequence
      `;
      yield* insertProject(1);

      const replayReadStarted = yield* Deferred.make<void>();
      const releaseReplayRead = yield* Deferred.make<void>();
      let blocked = false;
      const blockReplayRead: Statement.Transformer = (statement) => {
        const [query] = statement.compile();
        if (
          !blocked &&
          query.includes("FROM orchestration_events") &&
          query.includes("ORDER BY sequence ASC")
        ) {
          blocked = true;
          return Deferred.succeed(replayReadStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseReplayRead)),
            Effect.as(statement),
          );
        }
        return Effect.succeed(statement);
      };
      const resume = subscribeOrchestrationV2Shell({
        afterSequence: before!.sequence,
        requestCompletionMarker: true,
      }).pipe(
        Effect.flatMap((stream) =>
          stream.pipe(
            Stream.takeUntil((item) => item.kind === "synchronized"),
            Stream.map((item) => item.kind as string),
            Stream.runCollect,
          ),
        ),
        Effect.provideService(ThreadManagement.ThreadManagementService, {
          listActiveShellIndex: () => Effect.succeed([]),
          readShellSnapshot: () =>
            Effect.succeed(Effect.succeed({ schemaVersion: 1, threads: [] })),
          listActiveSubagentThreadIds: () => Effect.succeed([]),
        } as unknown as ThreadManagement.ThreadManagementService["Service"]),
        Effect.provideService(ProjectStore.ProjectStoreV2, {
          listShells: () => Effect.succeed([]),
        } as unknown as ProjectStore.ProjectStoreV2["Service"]),
        Effect.provideService(ProjectService.ProjectService, {
          getShell: () => Effect.succeedNone,
        } as unknown as ProjectService.ProjectService["Service"]),
        Effect.provideService(ProjectEnrichment.ProjectEnrichmentService, {
          subscribeChanges: PubSub.subscribe(yield* PubSub.unbounded()),
        } as ProjectEnrichment.ProjectEnrichmentService["Service"]),
        Effect.provideService(Statement.CurrentTransformer, blockReplayRead),
      );
      const resumedFiber = yield* Effect.forkScoped(resume);
      yield* Deferred.await(replayReadStarted);
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`DELETE FROM orchestration_events WHERE sequence = ${pruned!.sequence}`;
          yield* sql`
            INSERT INTO orchestration_v2_event_retention (thread_id, replay_floor)
            VALUES (${threadId}, ${pruned!.sequence})
          `;
        }),
      );
      yield* Deferred.succeed(releaseReplayRead, undefined);

      assert.deepEqual(Array.from(yield* Fiber.join(resumedFiber)), ["snapshot", "synchronized"]);
    }).pipe(Effect.provide(ReplayTestLayer)),
  ),
);
