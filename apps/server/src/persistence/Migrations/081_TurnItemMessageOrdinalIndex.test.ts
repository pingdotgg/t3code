import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import TurnItemMessageOrdinalIndex from "./081_TurnItemMessageOrdinalIndex.ts";

// The statement without the index's json_valid term, which the indexed one (below) must answer
// the same over JSON payloads.
const unindexedOrdinalsOf = (threadId: string) => `
  SELECT json_extract(payload_json, '$.messageId') AS message_id, MIN(ordinal) AS ordinal
  FROM orchestration_v2_projection_turn_items NOT INDEXED
  WHERE thread_id = '${threadId}' AND type IN ('user_message', 'assistant_message')
  GROUP BY json_extract(payload_json, '$.messageId')
  ORDER BY message_id
`;

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

it.effect(
  "adds the message-ordinal index once, re-runs cleanly and keeps the grouped ordinals",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 80 });
      for (const [id, threadId, ordinal, type, messageId] of [
        ["a1", "thread-a", 1, "user_message", "m1"],
        ["a2", "thread-a", 3, "assistant_message", "m2"],
        ["a3", "thread-a", 2, "assistant_message", "m2"],
        ["a4", "thread-a", 4, "dynamic_tool", "m3"],
        ["a5", "thread-a", 5, "user_message", "m3"],
        ["b1", "thread-b", 1, "assistant_message", "m1"],
      ] as const) {
        yield* sql`
        INSERT INTO orchestration_v2_projection_turn_items (
          turn_item_id, thread_id, run_id, ordinal, type, status, updated_at, payload_json
        )
        VALUES (
          ${id}, ${threadId}, NULL, ${ordinal}, ${type}, 'completed',
          '2026-11-01T00:00:00.000Z', ${JSON.stringify({ messageId })}
        )
      `;
      }
      const expected = [
        { message_id: "m1", ordinal: 1 },
        { message_id: "m2", ordinal: 2 },
        { message_id: "m3", ordinal: 5 },
      ];
      assert.deepEqual(yield* sql.unsafe(unindexedOrdinalsOf("thread-a")), expected);

      assert.deepEqual(
        (yield* runMigrations()).map(([id]) => id),
        [81],
      );
      const index = () => sql<{ readonly sql: string }>`
      SELECT sql FROM sqlite_master
      WHERE type = 'index' AND name = 'orchestration_v2_projection_turn_items_message_ordinal_idx'
    `;
      const created = yield* index();
      assert.lengthOf(created, 1);
      yield* TurnItemMessageOrdinalIndex;
      assert.deepEqual(yield* index(), created);
      assert.deepEqual(yield* runMigrations(), []);

      assert.deepEqual(yield* sql.unsafe(ordinalsOf("thread-a")), expected);
      assert.deepEqual(
        yield* sql.unsafe(ordinalsOf("thread-b")),
        yield* sql.unsafe(unindexedOrdinalsOf("thread-b")),
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

// Without the index a payload that is not JSON fails no write; with it, it must fail none either.
it.effect("migrates over a message whose payload is not JSON, and takes one after it", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 80 });
    yield* insertTurnItem("bad-1", "thread-a", 1, "assistant_message", "{not json");
    yield* insertTurnItem("ok-1", "thread-a", 2, "user_message", '{"messageId":"m1"}');

    assert.deepEqual(
      (yield* runMigrations()).map(([id]) => id),
      [81],
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
