import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));
const divergentLedgerLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("087_ProjectionThreadActivityJsonIndexes", (it) => {
  it.effect("materializes hot JSON paths and serves lifecycle lookups from indexes", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 87 });

      // Generated columns are hidden from PRAGMA table_info; table_xinfo
      // lists them (hidden=2 for VIRTUAL).
      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_xinfo(projection_thread_activities)
      `;
      for (const name of ["task_id", "request_id", "task_type"]) {
        assert.ok(
          columns.some((column) => column.name === name),
          `expected generated column ${name}`,
        );
      }

      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id,
          thread_id,
          turn_id,
          tone,
          kind,
          summary,
          payload_json,
          sequence,
          created_at
        )
        VALUES (
          'activity-1',
          'thread-1',
          'turn-1',
          'info',
          'task.started',
          'started',
          '{"taskId":"task-1","taskType":"background-agent"}',
          1,
          '2026-09-01T00:00:00.000Z'
        ),
        (
          'activity-invalid',
          'thread-1',
          'turn-1',
          'info',
          'runtime.note',
          'invalid payload still inserts',
          'invalid json',
          2,
          '2026-09-01T00:00:01.000Z'
        )
      `;

      const backfilled = yield* sql<{
        readonly task_id: string | null;
        readonly request_id: string | null;
        readonly task_type: string | null;
      }>`
        SELECT task_id, request_id, task_type
        FROM projection_thread_activities
        WHERE activity_id = 'activity-1'
      `;
      assert.equal(backfilled[0]?.task_id, "task-1");
      assert.equal(backfilled[0]?.task_type, "background-agent");
      assert.equal(backfilled[0]?.request_id, null);

      const invalidBackfill = yield* sql<{ readonly task_id: string | null }>`
        SELECT task_id
        FROM projection_thread_activities
        WHERE activity_id = 'activity-invalid'
      `;
      assert.equal(invalidBackfill[0]?.task_id, null);

      // Equality lookups on the stored task id (the background-agent join and
      // EXISTS probe shape) resolve from the composite index without sorting.
      const taskLookupPlan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT activity_id
        FROM projection_thread_activities
        WHERE thread_id = 'thread-1'
          AND kind = 'task.started'
          AND task_id = 'task-1'
        ORDER BY created_at DESC, activity_id DESC
      `;
      assert.ok(
        taskLookupPlan.some((row) =>
          row.detail.includes("idx_projection_thread_activities_thread_kind_task"),
        ),
      );
      assert.ok(taskLookupPlan.every((row) => !row.detail.includes("USE TEMP B-TREE")));

      // Same for the approval / user-input lifecycle request id.
      const requestLookupPlan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT activity_id
        FROM projection_thread_activities
        WHERE thread_id = 'thread-1'
          AND kind = 'approval.requested'
          AND request_id = 'request-1'
        ORDER BY created_at DESC, activity_id DESC
      `;
      assert.ok(
        requestLookupPlan.some((row) =>
          row.detail.includes("idx_projection_thread_activities_thread_kind_request"),
        ),
      );
      assert.ok(requestLookupPlan.every((row) => !row.detail.includes("USE TEMP B-TREE")));

      const startedProbePlan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT 1
        FROM projection_thread_activities
        WHERE thread_id = 'thread-1'
          AND kind = 'task.started'
          AND task_type = 'background-agent'
          AND task_id = 'task-1'
      `;
      assert.ok(
        startedProbePlan.some((row) =>
          row.detail.includes("idx_projection_thread_activities_thread_kind_task"),
        ),
      );

      const turnPagePlan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT activity_id
        FROM projection_thread_activities
        WHERE thread_id = 'thread-1'
          AND turn_id = 'turn-1'
          AND created_at < '2026-09-02T00:00:00.000Z'
        ORDER BY created_at DESC, activity_id DESC
        LIMIT 201
      `;
      assert.ok(
        turnPagePlan.some((row) =>
          row.detail.includes("idx_projection_thread_activities_thread_turn_created"),
        ),
      );
      assert.ok(turnPagePlan.every((row) => !row.detail.includes("USE TEMP B-TREE")));
    }),
  );
});

divergentLedgerLayer("087_ProjectionThreadActivityJsonIndexes/divergent ledger", (it) => {
  it.effect("recreates a skipped activities table instead of failing startup", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 86 });
      // Simulate a ledger that advanced past 005 without creating the table.
      yield* sql`DROP TABLE projection_thread_activities`;

      const executed = yield* runMigrations();
      assert.deepStrictEqual(
        executed.map(([id]) => id),
        [
          87, 88, 89, 90, 91, 92, 93, 94, 95, 96, 97, 98, 99, 100, 101, 102, 103, 104, 105, 106,
          107, 108, 109, 110, 111, 112, 113, 114, 115,
        ],
      );

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_xinfo(projection_thread_activities)
      `;
      for (const name of ["payload_json", "task_id", "request_id", "task_type"]) {
        assert.ok(
          columns.some((column) => column.name === name),
          `expected column ${name} after repair`,
        );
      }

      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id,
          thread_id,
          turn_id,
          tone,
          kind,
          summary,
          payload_json,
          sequence,
          created_at
        )
        VALUES (
          'activity-repaired',
          'thread-1',
          NULL,
          'info',
          'task.started',
          'started',
          '{"taskId":"task-1"}',
          1,
          '2026-09-01T00:00:00.000Z'
        )
      `;
      const rows = yield* sql<{ readonly task_id: string | null }>`
        SELECT task_id
        FROM projection_thread_activities
        WHERE activity_id = 'activity-repaired'
      `;
      assert.equal(rows[0]?.task_id, "task-1");
    }),
  );
});
