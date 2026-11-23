import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const layer = it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));

layer("102_ThreadItemCounts", (it) => {
  it.effect("matches a recount of items without a run or with an existing run", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 101 });
      const upsertItem = (id: string, threadId: string, runId: string | null) => sql`
        INSERT INTO orchestration_v2_projection_turn_items (
          turn_item_id, thread_id, run_id, ordinal, type, status, updated_at, payload_json
        )
        VALUES (
          ${id}, ${threadId}, ${runId}, 1, 'assistant_message', 'completed',
          '2026-11-19T00:00:00.000Z', '{}'
        )
        ON CONFLICT(turn_item_id) DO UPDATE SET thread_id = excluded.thread_id, run_id = excluded.run_id
      `;
      const insertRun = (runId: string, threadId: string) => sql`
        INSERT INTO orchestration_v2_projection_runs (
          run_id, thread_id, ordinal, provider, status, requested_at, payload_json
        )
        VALUES (
          ${runId}, ${threadId},
          (SELECT COUNT(*) FROM orchestration_v2_projection_runs WHERE thread_id = ${threadId}),
          'codex', 'completed', '2026-11-19T00:00:00.000Z', '{}'
        )
      `;
      const totals = () => sql<{ readonly thread_id: string; readonly item_count: number }>`
        SELECT thread_id, item_count FROM orchestration_v2_projection_thread_item_counts
        ORDER BY thread_id
      `;
      const recount = () => sql<{ readonly thread_id: string; readonly item_count: number }>`
        SELECT item.thread_id, COUNT(*) AS item_count
        FROM orchestration_v2_projection_turn_items item
        WHERE item.run_id IS NULL
          OR EXISTS (SELECT 1 FROM orchestration_v2_projection_runs run WHERE run.run_id = item.run_id)
        GROUP BY item.thread_id
        ORDER BY item.thread_id
      `;
      const assertTotals = (expected: ReadonlyArray<readonly [string, number]>) =>
        Effect.gen(function* () {
          const actual = yield* totals();
          assert.deepEqual(actual, yield* recount());
          assert.deepEqual(
            actual.map((row) => [row.thread_id, row.item_count]),
            expected.map(([threadId, count]) => [threadId, count]),
          );
        });

      yield* insertRun("run-1", "thread-1");
      yield* upsertItem("runless", "thread-1", null);
      yield* upsertItem("run-1:a", "thread-1", "run-1");
      yield* upsertItem("late:a", "thread-1", "run-late");
      yield* runMigrations();
      yield* assertTotals([["thread-1", 2]]);

      yield* upsertItem("run-1:b", "thread-1", "run-1");
      yield* upsertItem("late:b", "thread-2", "run-late");
      yield* assertTotals([["thread-1", 3]]);

      yield* insertRun("run-late", "thread-1");
      yield* assertTotals([
        ["thread-1", 4],
        ["thread-2", 1],
      ]);

      yield* upsertItem("run-1:b", "thread-2", null);
      yield* upsertItem("late:a", "thread-1", "run-missing");
      yield* assertTotals([
        ["thread-1", 2],
        ["thread-2", 2],
      ]);

      yield* sql`DELETE FROM orchestration_v2_projection_runs WHERE run_id = 'run-late'`;
      yield* sql`DELETE FROM orchestration_v2_projection_turn_items WHERE turn_item_id = 'run-1:b'`;
      yield* assertTotals([["thread-1", 2]]);

      yield* sql`DELETE FROM orchestration_v2_projection_turn_items WHERE thread_id = 'thread-1'`;
      yield* assertTotals([]);
    }),
  );
});
