import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// `title_key` is the trimmed, lower-cased title: one topic per title on a lead's board.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS orchestration_v2_projection_board_topics (
      topic_id TEXT PRIMARY KEY,
      lead_thread_id TEXT NOT NULL,
      title_key TEXT NOT NULL,
      order_key TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS orchestration_v2_projection_board_topics_title_idx
    ON orchestration_v2_projection_board_topics(lead_thread_id, title_key)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_board_topics_lead_idx
    ON orchestration_v2_projection_board_topics(lead_thread_id)
  `;
});
