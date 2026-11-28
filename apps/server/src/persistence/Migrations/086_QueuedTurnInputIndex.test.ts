import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const layer = it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));

layer("086_QueuedTurnInputIndex", (it) => {
  it.effect("keeps a user message with a malformed payload migratable and writable", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 85 });
      const insertUserMessage = (id: string) => sql`
        INSERT INTO orchestration_v2_projection_turn_items (
          turn_item_id, thread_id, run_id, ordinal, type, status, updated_at, payload_json
        )
        VALUES (
          ${id}, 'thread-1', 'run-1', 1, 'user_message', 'completed',
          '2026-11-14T00:00:00.000Z', '{not json'
        )
      `;
      yield* insertUserMessage("before-86");

      yield* runMigrations();
      yield* insertUserMessage("after-86");

      const rows = yield* sql<{ readonly turn_item_id: string }>`
        SELECT turn_item_id FROM orchestration_v2_projection_turn_items ORDER BY turn_item_id
      `;
      assert.deepEqual(
        rows.map((row) => row.turn_item_id),
        ["after-86", "before-86"],
      );
    }),
  );

  it.effect("re-guards the index on a database that ran the unguarded migration 86", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 91 });
      yield* sql`DROP INDEX orchestration_v2_projection_turn_items_queued_input_idx`;
      yield* sql`
        CREATE INDEX orchestration_v2_projection_turn_items_queued_input_idx
        ON orchestration_v2_projection_turn_items(run_id)
        WHERE type = 'user_message' AND json_extract(payload_json, '$.inputIntent') = 'queued_turn'
      `;

      yield* runMigrations();
      yield* sql`
        INSERT INTO orchestration_v2_projection_turn_items (
          turn_item_id, thread_id, run_id, ordinal, type, status, updated_at, payload_json
        )
        VALUES (
          'malformed', 'thread-1', 'run-1', 1, 'user_message', 'completed',
          '2026-11-14T00:00:00.000Z', '{not json'
        )
      `;
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
