import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))(
  "077_BackgroundRecoveryIndexes",
  (it) => {
    it.effect(
      "seeks usage-limit failures and the latest executed run without scanning payloads or sorting history",
      () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* runMigrations({ toMigrationInclusive: 76 });
          assert.deepEqual(
            yield* sql`SELECT name FROM effect_sql_migrations WHERE migration_id = 76`,
            [{ name: "ProjectionProjectsPinArchive" }],
          );
          for (const [id, type, status, failureClass] of [
            ["limit", "error", "failed", "usage_limit"],
            ["other", "error", "failed", "provider"],
            ["running", "error", "running", "usage_limit"],
            ["message", "user_message", "failed", "usage_limit"],
          ]) {
            yield* sql`INSERT INTO orchestration_v2_projection_turn_items
          (turn_item_id, thread_id, ordinal, type, status, updated_at, payload_json)
          VALUES (${id}, ${id}, 1, ${type}, ${status}, '2026-10-01',
            ${JSON.stringify({ failure: { class: failureClass } })})`;
          }
          for (const [ordinal, [id, status, completedAt, startedAt]] of [
            ["done", "completed", "2026-10-01", "2026-10-01"],
            ["failed", "failed", "2026-10-02", "2026-10-01"],
            ["active", "running", null, "2026-10-03"],
            ["queued", "queued", null, null],
            ["unstarted-cancel", "cancelled", null, null],
          ].entries()) {
            yield* sql`INSERT INTO orchestration_v2_projection_runs
          (run_id, thread_id, ordinal, provider, status, requested_at, completed_at, payload_json)
          VALUES (${id}, 'thread', ${ordinal}, 'codex', ${status}, '2026-10-01',
            ${completedAt}, ${JSON.stringify({ startedAt })})`;
          }
          const recovery = `SELECT failure.thread_id FROM orchestration_v2_projection_turn_items failure
        WHERE failure.type = 'error' AND failure.status = 'failed'
          AND json_extract(failure.payload_json, '$.failure.class') = 'usage_limit'`;
          const latest = `SELECT latest.run_id FROM orchestration_v2_projection_runs latest
        WHERE latest.thread_id = 'thread' AND latest.status <> 'queued'
          AND NOT (latest.status = 'cancelled' AND json_extract(latest.payload_json, '$.startedAt') IS NULL)
        ORDER BY latest.completed_at IS NULL DESC, latest.completed_at DESC,
          latest.ordinal DESC, latest.run_id DESC LIMIT 1`;
          const before = yield* Effect.forEach([recovery, latest], (query) => sql.unsafe(query));
          assert.deepEqual(yield* runMigrations(), [[77, "BackgroundRecoveryIndexes"]]);
          assert.deepEqual(yield* runMigrations(), []);
          const after = yield* Effect.forEach([recovery, latest], (query) => sql.unsafe(query));
          assert.deepEqual(after, before);
          assert.deepEqual(after, [[{ thread_id: "limit" }], [{ run_id: "active" }]]);
          for (const [query, index] of [
            [recovery, "orchestration_v2_projection_turn_items_usage_limit_idx"],
            [latest, "orchestration_v2_projection_runs_latest_executed_idx"],
          ]) {
            const plan = yield* sql.unsafe<{ readonly detail: string }>(
              `EXPLAIN QUERY PLAN ${query}`,
            );
            assert.ok(plan.some((row) => row.detail.includes(index!)));
            assert.ok(plan.every((row) => !row.detail.includes("TEMP B-TREE")));
          }
          yield* sql`DELETE FROM orchestration_v2_projection_runs WHERE run_id = 'active'`;
          assert.deepEqual(yield* sql.unsafe(latest), [{ run_id: "failed" }]);
          yield* sql`UPDATE orchestration_v2_projection_runs
        SET status = 'cancelled', payload_json = '{"startedAt":"2026-10-03"}'
        WHERE run_id = 'unstarted-cancel'`;
          assert.deepEqual(yield* sql.unsafe(latest), [{ run_id: "unstarted-cancel" }]);
        }),
    );
  },
);
