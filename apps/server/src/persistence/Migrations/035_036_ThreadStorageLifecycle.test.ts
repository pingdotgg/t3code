import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import UpstreamMigration0035 from "./037_ProjectionThreadTitleRegeneration.ts";

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

      const executed = yield* runMigrations({ toMigrationInclusive: 38 });
      assert.deepStrictEqual(executed, [
        [36, "DeletedThreadCleanupQueue"],
        [37, "ProjectionThreadTitleRegeneration"],
        [38, "ThreadColdArchiveCompatibility"],
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
    }),
  );
});
