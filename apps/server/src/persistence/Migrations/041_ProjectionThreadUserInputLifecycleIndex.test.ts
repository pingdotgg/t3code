import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("041_ProjectionThreadUserInputLifecycleIndex", (it) => {
  it.effect("indexes only user-input lifecycle activities by thread and kind", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 40 });
      yield* runMigrations({ toMigrationInclusive: 41 });

      const indexes = yield* sql<{
        readonly name: string;
        readonly partial: number;
      }>`
        PRAGMA index_list(projection_thread_activities)
      `;
      const lifecycleIndex = indexes.find(
        (index) => index.name === "idx_projection_thread_activities_thread_user_input_lifecycle",
      );
      assert.equal(lifecycleIndex?.partial, 1);

      const columns = yield* sql<{
        readonly name: string;
      }>`
        PRAGMA index_info('idx_projection_thread_activities_thread_user_input_lifecycle')
      `;
      assert.deepStrictEqual(
        columns.map((column) => column.name),
        ["thread_id", "kind", "created_at", "activity_id"],
      );

      const queryPlan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT activity_id, kind, created_at, payload_json
        FROM projection_thread_activities
        WHERE thread_id = 'thread-1'
          AND kind IN (
            'user-input.requested',
            'user-input.resolved',
            'provider.user-input.respond.failed'
          )
      `;
      assert.match(
        queryPlan.map((row) => row.detail).join("\n"),
        /USING INDEX idx_projection_thread_activities_thread_user_input_lifecycle/,
      );
    }),
  );
});
