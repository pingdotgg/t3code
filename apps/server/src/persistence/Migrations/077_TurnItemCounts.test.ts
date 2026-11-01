import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const layer = it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));

layer("077_TurnItemCounts", (it) => {
  it.effect("backfills item counts, then follows upserts, moves, and deletes", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 75 });
      const upsert = (id: string, threadId: string, runId: string | null) => sql`
        INSERT INTO orchestration_v2_projection_turn_items (
          turn_item_id, thread_id, run_id, ordinal, type, status, updated_at, payload_json
        )
        VALUES (
          ${id}, ${threadId}, ${runId}, 1, 'assistant_message', 'completed',
          '2026-10-29T00:00:00.000Z', '{}'
        )
        ON CONFLICT(turn_item_id) DO UPDATE SET
          thread_id = excluded.thread_id,
          run_id = excluded.run_id,
          status = excluded.status
      `;
      yield* upsert("runless-1", "thread-1", null);
      yield* upsert("runless-2", "thread-1", null);
      yield* upsert("run-1", "thread-1", "run-1");

      yield* runMigrations();

      const counts = () =>
        sql<{ readonly thread_id: string; readonly run_key: string; readonly item_count: number }>`
          SELECT thread_id, run_key, item_count
          FROM orchestration_v2_projection_turn_item_counts
          ORDER BY thread_id, run_key
        `;
      assert.deepEqual(yield* counts(), [
        { thread_id: "thread-1", run_key: "", item_count: 2 },
        { thread_id: "thread-1", run_key: "run-1", item_count: 1 },
      ]);

      yield* upsert("run-1", "thread-1", "run-1");
      yield* upsert("run-2", "thread-2", "run-2");
      yield* upsert("runless-2", "thread-1", "run-1");
      assert.deepEqual(yield* counts(), [
        { thread_id: "thread-1", run_key: "", item_count: 1 },
        { thread_id: "thread-1", run_key: "run-1", item_count: 2 },
        { thread_id: "thread-2", run_key: "run-2", item_count: 1 },
      ]);

      yield* sql`DELETE FROM orchestration_v2_projection_turn_items WHERE thread_id = 'thread-1'`;
      assert.deepEqual(yield* counts(), [
        { thread_id: "thread-2", run_key: "run-2", item_count: 1 },
      ]);
    }),
  );
});
