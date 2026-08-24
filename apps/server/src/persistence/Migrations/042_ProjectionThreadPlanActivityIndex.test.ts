import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("042_ProjectionThreadPlanActivityIndex", (it) => {
  it.effect("indexes the latest plan lookup for one thread turn", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 41 });
      yield* runMigrations({ toMigrationInclusive: 42 });

      const queryPlan = yield* sql<{
        readonly detail: string;
      }>`
        EXPLAIN QUERY PLAN
        SELECT activity_id
        FROM projection_thread_activities
        WHERE thread_id = 'thread-1'
          AND turn_id = 'turn-1'
          AND kind = 'turn.plan.updated'
        ORDER BY sequence DESC, created_at DESC, activity_id DESC
        LIMIT 1
      `;

      assert.ok(
        queryPlan.some((row) =>
          row.detail.includes("idx_projection_thread_activities_plan_thread_turn_sequence"),
        ),
      );
    }),
  );
});
