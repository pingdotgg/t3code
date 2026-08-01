import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("060_ProjectionThreadActivityChronologyIndexes", (it) => {
  it.effect("uses the kind index before parsing lifecycle payloads", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 60 });

      const queryPlan = yield* sql<{
        readonly detail: string;
      }>`
        EXPLAIN QUERY PLAN
        SELECT
          activities.*,
          ROW_NUMBER() OVER (
            PARTITION BY json_extract(payload_json, '$.requestId')
            ORDER BY created_at DESC, activity_id DESC
          ) AS lifecycle_rank
        FROM projection_thread_activities AS activities
        WHERE thread_id = 'thread-1'
          AND kind IN (
            'approval.requested',
            'approval.resolved',
            'provider.approval.respond.failed'
          )
          AND json_extract(payload_json, '$.requestId') IS NOT NULL
          AND (
            kind <> 'provider.approval.respond.failed'
            OR lower(COALESCE(json_extract(payload_json, '$.detail'), ''))
              LIKE '%stale pending approval request%'
          )
      `;

      assert.ok(
        queryPlan.some(
          (row) =>
            row.detail.includes("idx_projection_thread_activities_thread_kind_created") &&
            row.detail.includes("thread_id=?") &&
            row.detail.includes("kind=?"),
        ),
      );
      assert.ok(queryPlan.every((row) => !row.detail.includes("SCAN activities")));
    }),
  );
});
