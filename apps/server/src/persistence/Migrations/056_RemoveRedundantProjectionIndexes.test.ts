import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

layer("056_RemoveRedundantProjectionIndexes", (it) => {
  it.effect("keeps the covering indexes and removes their prefix indexes", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 55 });
      yield* runMigrations({ toMigrationInclusive: 56 });

      const rows = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'index'
          AND name LIKE 'idx_projection_%'
      `;
      const indexes = new Set(rows.map((row) => row.name));

      for (const removed of [
        "idx_projection_threads_project_id",
        "idx_projection_thread_messages_thread_created",
        "idx_projection_thread_activities_thread_sequence",
        "idx_projection_turns_thread_requested",
      ]) {
        assert.isFalse(indexes.has(removed), removed);
      }
      for (const covering of [
        "idx_projection_threads_project_deleted_created",
        "idx_projection_thread_messages_thread_created_id",
        "idx_projection_thread_activities_thread_sequence_created_id",
        "idx_projection_turns_thread_keyset",
      ]) {
        assert.isTrue(indexes.has(covering), covering);
      }
    }),
  );
});
