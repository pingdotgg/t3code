import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const at = "2026-10-01T00:00:00.000Z";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))("083_RunItemCounts", (it) => {
  it.effect(
    "counts the existing items per run, marking rolled-back and missing runs uncounted",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 82 });
        const insertItem = (id: string, threadId: string, runId: string | null) => sql`
        INSERT INTO orchestration_v2_projection_turn_items (
          turn_item_id, thread_id, run_id, ordinal, type, status, updated_at, payload_json
        ) VALUES (${id}, ${threadId}, ${runId}, 1, 'user_message', 'completed', ${at}, '{}')
      `;
        const insertRun = (runId: string, ordinal: number, status: string) => sql`
        INSERT INTO orchestration_v2_projection_runs (
          run_id, thread_id, ordinal, provider, status, requested_at, payload_json
        ) VALUES (${runId}, 'thread:a', ${ordinal}, 'codex', ${status}, ${at}, '{}')
      `;
        yield* insertRun("run:1", 1, "completed");
        yield* insertRun("run:2", 2, "rolled_back");
        yield* insertItem("a1", "thread:a", "run:1");
        yield* insertItem("a2", "thread:a", "run:1");
        yield* insertItem("a3", "thread:a", "run:2");
        yield* insertItem("a4", "thread:a", null);
        yield* insertItem("b1", "thread:b", "run:3");

        assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 83 }), [
          [83, "RunItemCounts"],
        ]);
        assert.deepEqual(
          yield* sql`
          SELECT thread_id, run_id, item_count, counted
          FROM orchestration_v2_projection_run_item_counts
          ORDER BY thread_id, run_id
        `,
          [
            { thread_id: "thread:a", run_id: "", item_count: 1, counted: 1 },
            { thread_id: "thread:a", run_id: "run:1", item_count: 2, counted: 1 },
            { thread_id: "thread:a", run_id: "run:2", item_count: 1, counted: 0 },
            { thread_id: "thread:b", run_id: "run:3", item_count: 1, counted: 0 },
          ],
        );
      }),
  );
});
