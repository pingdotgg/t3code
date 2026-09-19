import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

const INDEX_NAME = "idx_projection_thread_activities_kind_created_id";

layer("054_ProjectionThreadActivitiesKindIndex", (it) => {
  it.effect("serves the startup read of one activity kind from an ordered index", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      // The same statement ProjectionSnapshotQuery.listActivitiesByKind runs.
      const plan = () =>
        sql<{ readonly detail: string }>`
          EXPLAIN QUERY PLAN
          SELECT a.activity_id
          FROM projection_thread_activities a
          JOIN projection_threads t ON t.thread_id = a.thread_id
          WHERE a.kind = ${"worktree-setup"}
            AND t.deleted_at IS NULL
            AND t.archived_at IS NULL
          ORDER BY a.created_at ASC, a.activity_id ASC
        `.pipe(Effect.map((rows) => rows.map((row) => row.detail).join("\n")));

      yield* runMigrations({ toMigrationInclusive: 53 });
      const before = yield* plan();
      assert.notInclude(before, INDEX_NAME);

      yield* runMigrations({ toMigrationInclusive: 54 });

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA index_info('idx_projection_thread_activities_kind_created_id')
      `;
      assert.deepStrictEqual(
        columns.map((column) => column.name),
        ["kind", "created_at", "activity_id"],
      );

      const after = yield* plan();
      assert.include(after, INDEX_NAME);
      assert.notInclude(after, "TEMP B-TREE");
    }),
  );
});
