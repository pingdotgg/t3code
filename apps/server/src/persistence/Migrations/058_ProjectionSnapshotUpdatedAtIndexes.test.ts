import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("058_ProjectionSnapshotUpdatedAtIndexes", (it) => {
  it.effect("serves the shell snapshot freshness aggregates from covering indexes", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 58 });

      const threadIndexColumns = yield* sql<{
        readonly name: string;
      }>`
        PRAGMA index_info('idx_projection_threads_updated_at')
      `;
      assert.deepStrictEqual(
        threadIndexColumns.map((column) => column.name),
        ["updated_at"],
      );

      const sessionIndexColumns = yield* sql<{
        readonly name: string;
      }>`
        PRAGMA index_info('idx_projection_thread_sessions_updated_at')
      `;
      assert.deepStrictEqual(
        sessionIndexColumns.map((column) => column.name),
        ["updated_at"],
      );

      const threadPlan = yield* sql<{
        readonly detail: string;
      }>`
        EXPLAIN QUERY PLAN
        SELECT MAX(updated_at) FROM projection_threads
      `;
      assert.ok(threadPlan.some((row) => row.detail.includes("idx_projection_threads_updated_at")));

      const sessionPlan = yield* sql<{
        readonly detail: string;
      }>`
        EXPLAIN QUERY PLAN
        SELECT MAX(updated_at) FROM projection_thread_sessions
      `;
      assert.ok(
        sessionPlan.some((row) => row.detail.includes("idx_projection_thread_sessions_updated_at")),
      );
    }),
  );
});
