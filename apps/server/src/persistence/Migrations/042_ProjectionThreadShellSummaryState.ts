import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE projection_thread_activities
    ADD COLUMN user_input_request_id TEXT
  `;

  yield* sql`
    ALTER TABLE projection_thread_activities
    ADD COLUMN user_input_state TEXT
    CHECK (user_input_state IN ('pending', 'cleared'))
  `;

  yield* sql`
    UPDATE projection_thread_activities
    SET
      user_input_request_id = CASE
        WHEN json_valid(payload_json) THEN CASE
          WHEN json_type(payload_json, '$.requestId') = 'text'
            THEN json_extract(payload_json, '$.requestId')
          ELSE NULL
        END
        ELSE NULL
      END,
      user_input_state = CASE
        WHEN kind = 'user-input.requested' THEN 'pending'
        WHEN kind = 'user-input.resolved' THEN 'cleared'
        WHEN kind = 'provider.user-input.respond.failed'
          AND json_valid(payload_json)
          AND json_type(payload_json, '$.detail') = 'text'
          THEN CASE
            WHEN lower(json_extract(payload_json, '$.detail'))
              LIKE '%stale pending user-input request%'
              OR lower(json_extract(payload_json, '$.detail'))
                LIKE '%unknown pending user-input request%'
              OR lower(json_extract(payload_json, '$.detail'))
                LIKE '%unknown pending user input request%'
              OR lower(json_extract(payload_json, '$.detail'))
                LIKE '%unknown pending codex user input request%'
              THEN 'cleared'
            ELSE NULL
          END
        ELSE NULL
      END
    WHERE kind IN (
      'user-input.requested',
      'user-input.resolved',
      'provider.user-input.respond.failed'
    )
  `;

  yield* sql`
    UPDATE projection_thread_activities
    SET user_input_state = NULL
    WHERE user_input_request_id IS NULL
  `;

  yield* sql`
    UPDATE projection_thread_activities
    SET user_input_request_id = NULL
    WHERE user_input_state IS NULL
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_activities_user_input_state
    ON projection_thread_activities(
      thread_id,
      user_input_request_id,
      created_at DESC,
      activity_id DESC
    )
    WHERE user_input_state IS NOT NULL
  `;

  yield* sql`
    DROP INDEX IF EXISTS idx_projection_thread_activities_thread_user_input_lifecycle
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_thread_user_input_summaries (
      thread_id TEXT PRIMARY KEY,
      pending_count INTEGER NOT NULL CHECK (pending_count >= 0)
    )
  `;

  yield* sql`
    WITH ranked AS (
      SELECT
        thread_id,
        user_input_request_id,
        user_input_state,
        ROW_NUMBER() OVER (
          PARTITION BY thread_id, user_input_request_id
          ORDER BY created_at DESC, activity_id DESC
        ) AS row_number
      FROM projection_thread_activities
      WHERE user_input_state IS NOT NULL
        AND user_input_request_id IS NOT NULL
    )
    INSERT INTO projection_thread_user_input_summaries (
      thread_id,
      pending_count
    )
    SELECT
      thread_id,
      SUM(CASE WHEN user_input_state = 'pending' THEN 1 ELSE 0 END)
    FROM ranked
    WHERE row_number = 1
    GROUP BY thread_id
  `;

  yield* sql`
    INSERT OR IGNORE INTO projection_thread_user_input_summaries (
      thread_id,
      pending_count
    )
    SELECT thread_id, 0
    FROM projection_threads
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_messages_latest_user
    ON projection_thread_messages(thread_id, created_at DESC, message_id DESC)
    WHERE role = 'user'
  `;

  yield* sql`
    UPDATE projection_threads
    SET
      pending_user_input_count = COALESCE((
        SELECT summary.pending_count
        FROM projection_thread_user_input_summaries AS summary
        WHERE summary.thread_id = projection_threads.thread_id
      ), 0),
      latest_user_message_at = (
        SELECT message.created_at
        FROM projection_thread_messages AS message
        WHERE message.thread_id = projection_threads.thread_id
          AND message.role = 'user'
        ORDER BY message.created_at DESC, message.message_id DESC
        LIMIT 1
      )
  `;
});
