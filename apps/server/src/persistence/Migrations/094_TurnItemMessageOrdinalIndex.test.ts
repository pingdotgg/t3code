import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const ordinalsOf = (threadId: string) => `
  SELECT json_extract(payload_json, '$.messageId') AS message_id, MIN(ordinal) AS ordinal
  FROM orchestration_v2_projection_turn_items
  WHERE thread_id = '${threadId}' AND type IN ('user_message', 'assistant_message')
    AND json_valid(payload_json)
  GROUP BY json_extract(payload_json, '$.messageId')
  ORDER BY message_id
`;

const insertTurnItem = (
  id: string,
  threadId: string,
  ordinal: number,
  type: string,
  payloadJson: string,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO orchestration_v2_projection_turn_items (
        turn_item_id, thread_id, run_id, ordinal, type, status, updated_at, payload_json
      )
      VALUES (
        ${id}, ${threadId}, NULL, ${ordinal}, ${type}, 'completed',
        '2026-11-01T00:00:00.000Z', ${payloadJson}
      )
    `;
  });

// Without the index a payload that is not JSON fails no write; with it, it must fail none either.
it.effect("migrates over a message whose payload is not JSON, and takes one after it", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 93 });
    yield* insertTurnItem("bad-1", "thread-a", 1, "assistant_message", "{not json");
    yield* insertTurnItem("ok-1", "thread-a", 2, "user_message", '{"messageId":"m1"}');

    assert.deepEqual(
      (yield* runMigrations()).map(([id]) => id),
      [94],
    );
    yield* insertTurnItem("bad-2", "thread-a", 3, "user_message", "{not json");
    yield* insertTurnItem("ok-2", "thread-a", 4, "assistant_message", '{"messageId":"m1"}');
    yield* sql`
      UPDATE orchestration_v2_projection_turn_items SET payload_json = '{still not json'
      WHERE turn_item_id = 'ok-2'
    `;

    assert.deepEqual(yield* sql.unsafe(ordinalsOf("thread-a")), [{ message_id: "m1", ordinal: 2 }]);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
