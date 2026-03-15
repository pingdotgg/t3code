import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    DROP INDEX IF EXISTS idx_projection_thread_messages_thread_created
  `;

  yield* sql`
    ALTER TABLE projection_thread_messages
    RENAME TO projection_thread_messages_legacy
  `;

  yield* sql`
    CREATE TABLE projection_thread_messages (
      thread_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      turn_id TEXT,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      is_streaming INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      attachments_json TEXT,
      PRIMARY KEY (thread_id, message_id)
    )
  `;

  yield* sql`
    INSERT INTO projection_thread_messages (
      thread_id,
      message_id,
      turn_id,
      role,
      text,
      is_streaming,
      created_at,
      updated_at,
      attachments_json
    )
    SELECT
      thread_id,
      message_id,
      turn_id,
      role,
      text,
      is_streaming,
      created_at,
      updated_at,
      attachments_json
    FROM projection_thread_messages_legacy
  `;

  yield* sql`
    DROP TABLE projection_thread_messages_legacy
  `;

  yield* sql`
    CREATE INDEX idx_projection_thread_messages_thread_created
    ON projection_thread_messages(thread_id, created_at)
  `;
});
