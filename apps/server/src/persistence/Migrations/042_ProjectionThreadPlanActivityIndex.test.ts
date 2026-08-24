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
        WITH latest_unsettled_turn AS (
          SELECT thread.latest_turn_id AS turn_id
          FROM projection_threads AS thread
          LEFT JOIN projection_turns AS turn
            ON turn.thread_id = thread.thread_id
            AND turn.turn_id = thread.latest_turn_id
          LEFT JOIN projection_thread_sessions AS session
            ON session.thread_id = thread.thread_id
          WHERE thread.thread_id = 'thread-1'
            AND thread.latest_turn_id IS NOT NULL
            AND (
              turn.started_at IS NULL
              OR turn.completed_at IS NULL
              OR session.status = 'running'
            )
        ),
        active_plan_activities AS (
          SELECT activity.activity_id
          FROM latest_unsettled_turn AS active_turn
          CROSS JOIN projection_thread_activities AS activity
          WHERE activity.thread_id = 'thread-1'
            AND activity.turn_id = active_turn.turn_id
            AND activity.kind = 'turn.plan.updated'
          ORDER BY
            activity.sequence DESC,
            activity.created_at DESC,
            activity.activity_id DESC
          LIMIT 1
        )
        SELECT activity_id
        FROM active_plan_activities
      `;

      assert.ok(
        queryPlan.some((row) =>
          row.detail.includes("idx_projection_thread_activities_plan_thread_turn_sequence"),
        ),
      );
      assert.equal(
        queryPlan.some((row) => row.detail.includes("USE TEMP B-TREE")),
        false,
      );
    }),
  );
});
