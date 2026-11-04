import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * A projection read groups a thread's message items by `$.messageId` for each message's first
 * ordinal; without this index it parses every message item's payload. The expression and the
 * WHERE must stay identical to that query's, or SQLite will not use the index. `json_valid` keeps
 * a payload that is not JSON out of it: json_extract would fail its write.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_turn_items_message_ordinal_idx
    ON orchestration_v2_projection_turn_items(
      thread_id, json_extract(payload_json, '$.messageId'), ordinal
    )
    WHERE type IN ('user_message', 'assistant_message') AND json_valid(payload_json)
  `;
});
