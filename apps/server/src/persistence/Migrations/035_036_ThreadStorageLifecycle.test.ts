import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import UpstreamMigration0035 from "./037_ProjectionThreadTitleRegeneration.ts";
import UpstreamMigration0036 from "./039_ProjectionThreadsPinned.ts";
import UpstreamMigration0037 from "./040_ProjectionTurnsKeysetIndex.ts";
import UpstreamMigration0038 from "./041_ProjectionThreadsPinOrderKey.ts";
import UpstreamMigration0039 from "./042_ProjectionProjectsDefaultThreadEnvMode.ts";
import UpstreamMigration0040 from "./043_ProjectionProjectFaviconPath.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("035-036 thread storage lifecycle migrations", (it) => {
  it.effect("queues archived and deleted threads", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 32 });

      const insertThread = (input: {
        readonly threadId: string;
        readonly archivedAt: string | null;
        readonly deletedAt: string | null;
      }) => sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          interaction_mode, created_at, updated_at, archived_at, deleted_at
        ) VALUES (
          ${input.threadId}, 'project-1', ${input.threadId},
          '{"instanceId":"codex","model":"gpt-5.5","options":[]}',
          'full-access', 'default', '2026-07-01T00:00:00.000Z',
          '2026-07-01T00:00:00.000Z', ${input.archivedAt}, ${input.deletedAt}
        )
      `;

      yield* insertThread({
        threadId: "archived-thread",
        archivedAt: "2026-07-02T00:00:00.000Z",
        deletedAt: null,
      });
      yield* insertThread({
        threadId: "deleted-thread",
        archivedAt: null,
        deletedAt: "2026-07-03T00:00:00.000Z",
      });

      yield* runMigrations({ toMigrationInclusive: 36 });

      const manifests = yield* sql<{
        readonly threadId: string;
        readonly rootThreadId: string;
        readonly status: string;
      }>`
        SELECT thread_id AS "threadId", root_thread_id AS "rootThreadId", status
        FROM thread_archive_manifests
        ORDER BY thread_id
      `;
      assert.deepStrictEqual(manifests, [
        {
          threadId: "archived-thread",
          rootThreadId: "archived-thread",
          status: "pending",
        },
      ]);

      const cleanup = yield* sql<{ readonly threadId: string; readonly reason: string }>`
        SELECT thread_id AS "threadId", reason FROM thread_cleanup_queue
      `;
      assert.deepStrictEqual(cleanup, [{ threadId: "deleted-thread", reason: "deleted" }]);
    }),
  );
});

const branchHistoryLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

branchHistoryLayer("038 branch-history compatibility", (it) => {
  it.effect("preserves lifecycle state when cold archive setup reruns", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 34 });

      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          interaction_mode, created_at, updated_at, archived_at, deleted_at
        ) VALUES
          (
            'cold-thread', 'project-1', 'Cold thread',
            '{"instanceId":"codex","model":"gpt-5.5","options":[]}',
            'full-access', 'default', '2026-07-01T00:00:00.000Z',
            '2026-07-01T00:00:00.000Z', '2026-07-02T00:00:00.000Z', NULL
          ),
          (
            'cleanup-pending-thread', 'project-1', 'Cleanup pending thread',
            '{"instanceId":"codex","model":"gpt-5.5","options":[]}',
            'full-access', 'default', '2026-07-01T00:00:00.000Z',
            '2026-07-01T00:00:00.000Z', '2026-07-03T00:00:00.000Z', NULL
          )
      `;

      yield* runMigrations({ toMigrationInclusive: 36 });
      yield* sql`
        UPDATE thread_archive_manifests
        SET
          status = CASE thread_id
            WHEN 'cold-thread' THEN 'cold'
            ELSE 'cleanup_pending'
          END,
          original_bytes = CASE thread_id
            WHEN 'cold-thread' THEN 1024
            ELSE 2048
          END,
          compressed_bytes = CASE thread_id
            WHEN 'cold-thread' THEN 512
            ELSE 1024
          END
        WHERE thread_id IN ('cold-thread', 'cleanup-pending-thread')
      `;
      yield* sql`
        UPDATE thread_storage_maintenance
        SET status = 'complete'
        WHERE task = 'compact-legacy-thread-storage'
      `;

      const beforeManifests = yield* sql<{
        readonly threadId: string;
        readonly status: string;
        readonly originalBytes: number;
        readonly compressedBytes: number;
      }>`
        SELECT
          thread_id AS "threadId",
          status,
          original_bytes AS "originalBytes",
          compressed_bytes AS "compressedBytes"
        FROM thread_archive_manifests
        ORDER BY thread_id
      `;
      const beforeMaintenance = yield* sql<{
        readonly task: string;
        readonly status: string;
      }>`
        SELECT task, status
        FROM thread_storage_maintenance
        ORDER BY task
      `;

      const executed = yield* runMigrations({ toMigrationInclusive: 41 });
      assert.deepStrictEqual(executed, [
        [37, "ProjectionThreadTitleRegeneration"],
        [38, "ThreadColdArchiveCompatibility"],
        [39, "ProjectionThreadsPinned"],
        [40, "ProjectionTurnsKeysetIndex"],
        [41, "ProjectionThreadsPinOrderKey"],
      ]);

      const afterManifests = yield* sql<{
        readonly threadId: string;
        readonly status: string;
        readonly originalBytes: number;
        readonly compressedBytes: number;
      }>`
        SELECT
          thread_id AS "threadId",
          status,
          original_bytes AS "originalBytes",
          compressed_bytes AS "compressedBytes"
        FROM thread_archive_manifests
        ORDER BY thread_id
      `;
      const afterMaintenance = yield* sql<{
        readonly task: string;
        readonly status: string;
      }>`
        SELECT task, status
        FROM thread_storage_maintenance
        ORDER BY task
      `;

      assert.deepStrictEqual(afterManifests, beforeManifests);
      assert.deepStrictEqual(afterMaintenance, beforeMaintenance);

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      assert.ok(columns.some((column) => column.name === "pinned_at"));
      assert.ok(columns.some((column) => column.name === "pin_order_key"));
      const turnIndexes = yield* sql<{ readonly name: string }>`
        PRAGMA index_list(projection_turns)
      `;
      assert.ok(turnIndexes.some((index) => index.name === "idx_projection_turns_thread_keyset"));
    }),
  );
});

const upstreamHistoryLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

upstreamHistoryLayer("035 upstream title-regeneration compatibility", (it) => {
  it.effect("bridges databases that recorded upstream migration 35", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 34 });

      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          interaction_mode, created_at, updated_at, archived_at, deleted_at
        ) VALUES (
          'upstream-archived-thread', 'project-1', 'Upstream archived thread',
          '{"instanceId":"codex","model":"gpt-5.5","options":[]}',
          'full-access', 'default', '2026-07-01T00:00:00.000Z',
          '2026-07-01T00:00:00.000Z', '2026-07-02T00:00:00.000Z', NULL
        )
      `;

      yield* UpstreamMigration0035;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (35, 'ProjectionThreadTitleRegeneration')
      `;

      const executed = yield* runMigrations({ toMigrationInclusive: 41 });
      assert.deepStrictEqual(executed, [
        [36, "DeletedThreadCleanupQueue"],
        [37, "ProjectionThreadTitleRegeneration"],
        [38, "ThreadColdArchiveCompatibility"],
        [39, "ProjectionThreadsPinned"],
        [40, "ProjectionTurnsKeysetIndex"],
        [41, "ProjectionThreadsPinOrderKey"],
      ]);

      const manifests = yield* sql<{
        readonly threadId: string;
        readonly status: string;
      }>`
        SELECT thread_id AS "threadId", status
        FROM thread_archive_manifests
      `;
      assert.deepStrictEqual(manifests, [
        { threadId: "upstream-archived-thread", status: "pending" },
      ]);

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      const names = new Set(columns.map((column) => column.name));
      assert.ok(names.has("title_regeneration_request_id"));
      assert.ok(names.has("title_regeneration_started_at"));
      assert.ok(names.has("pinned_at"));
      assert.ok(names.has("pin_order_key"));
      const turnIndexes = yield* sql<{ readonly name: string }>`
        PRAGMA index_list(projection_turns)
      `;
      assert.ok(turnIndexes.some((index) => index.name === "idx_projection_turns_thread_keyset"));
    }),
  );
});

const currentUpstreamHistoryLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

currentUpstreamHistoryLayer("044 current-upstream compatibility", (it) => {
  it.effect("creates lifecycle tables after upstream migrations through 40", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 34 });

      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          interaction_mode, created_at, updated_at, archived_at, deleted_at
        ) VALUES
          (
            'upstream-current-archived', 'project-1', 'Archived',
            '{"instanceId":"codex","model":"gpt-5.5","options":[]}',
            'full-access', 'default', '2026-07-01T00:00:00.000Z',
            '2026-07-01T00:00:00.000Z', '2026-07-02T00:00:00.000Z', NULL
          ),
          (
            'upstream-current-deleted', 'project-1', 'Deleted',
            '{"instanceId":"codex","model":"gpt-5.5","options":[]}',
            'full-access', 'default', '2026-07-01T00:00:00.000Z',
            '2026-07-01T00:00:00.000Z', NULL, '2026-07-03T00:00:00.000Z'
          )
      `;

      yield* UpstreamMigration0035;
      yield* UpstreamMigration0036;
      yield* UpstreamMigration0037;
      yield* UpstreamMigration0038;
      yield* UpstreamMigration0039;
      yield* UpstreamMigration0040;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES
          (35, 'ProjectionThreadTitleRegeneration'),
          (36, 'ProjectionThreadsPinned'),
          (37, 'ProjectionTurnsKeysetIndex'),
          (38, 'ProjectionThreadsPinOrderKey'),
          (39, 'ProjectionProjectsDefaultThreadEnvMode'),
          (40, 'ProjectionProjectFaviconPath')
      `;

      const executed = yield* runMigrations({ toMigrationInclusive: 44 });
      assert.deepStrictEqual(executed, [
        [41, "ProjectionThreadsPinOrderKey"],
        [42, "ProjectionProjectsDefaultThreadEnvMode"],
        [43, "ProjectionProjectFaviconPath"],
        [44, "ThreadStorageLifecycleCompatibility"],
      ]);

      const manifests = yield* sql<{ readonly threadId: string; readonly status: string }>`
        SELECT thread_id AS "threadId", status FROM thread_archive_manifests
      `;
      assert.deepStrictEqual(manifests, [
        { threadId: "upstream-current-archived", status: "pending" },
      ]);

      const cleanup = yield* sql<{ readonly threadId: string; readonly reason: string }>`
        SELECT thread_id AS "threadId", reason FROM thread_cleanup_queue
      `;
      assert.deepStrictEqual(cleanup, [
        { threadId: "upstream-current-deleted", reason: "deleted" },
      ]);
    }),
  );
});
