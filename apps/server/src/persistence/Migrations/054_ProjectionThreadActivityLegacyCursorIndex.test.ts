import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("054_ProjectionThreadActivityLegacyCursorIndex", (it) => {
  it.effect("creates a partial index covering legacy activity pagination", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 54 });

      const indexes = yield* sql<{
        readonly name: string;
        readonly partial: number;
      }>`
        PRAGMA index_list(projection_thread_activities)
      `;
      const cursorIndex = indexes.find(
        (index) => index.name === "idx_projection_thread_activities_legacy_cursor",
      );
      assert.equal(cursorIndex?.partial, 1);

      const columns = yield* sql<{
        readonly name: string;
      }>`
        PRAGMA index_info('idx_projection_thread_activities_legacy_cursor')
      `;
      assert.deepStrictEqual(
        columns.map((column) => column.name),
        ["thread_id", "created_at", "activity_id"],
      );

      const queryPlan = yield* sql<{
        readonly detail: string;
      }>`
        EXPLAIN QUERY PLAN
        SELECT
          activity_id,
          thread_id,
          turn_id,
          tone,
          kind,
          summary,
          payload_json,
          sequence,
          created_at
        FROM projection_thread_activities
        WHERE thread_id = 'thread-1'
          AND sequence IS NULL
          AND (
            created_at < '2026-07-28T00:00:00.000Z'
            OR (
              created_at = '2026-07-28T00:00:00.000Z'
              AND activity_id < 'activity-0201'
            )
          )
        ORDER BY created_at DESC, activity_id DESC
        LIMIT 201
      `;
      assert.ok(
        queryPlan.some((row) =>
          row.detail.includes("idx_projection_thread_activities_legacy_cursor"),
        ),
      );
      assert.ok(queryPlan.every((row) => !row.detail.includes("USE TEMP B-TREE")));
    }),
  );
});
