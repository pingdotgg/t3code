import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

/**
 * `ADD COLUMN` on a database that already has the column is the only failure
 * this migration expects; anything else (locked db, disk full, corruption)
 * must fail the migration instead of being silently swallowed.
 */
const ignoreDuplicateColumn = (error: SqlError) => {
  const cause = error.reason.cause;
  const message = cause instanceof Error ? cause.message : String(cause);
  return message.includes("duplicate column name") ? Effect.void : Effect.fail(error);
};

/**
 * Persistent Forma-only thread state. Queue rows deliberately remain outside
 * the upstream thread projection so v0.0.31 clients never decode fork fields.
 *
 * Legacy PR #1 databases already have `projection_thread_turn_queue`; retain
 * those rows, add the Ask bit, canonicalize their model options, and restore
 * every legacy queue paused until the user explicitly resumes it.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_thread_turn_queue (
      thread_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      text TEXT NOT NULL,
      attachment_ids_json TEXT NOT NULL,
      model_selection_json TEXT NOT NULL,
      runtime_mode TEXT NOT NULL,
      interaction_mode TEXT NOT NULL,
      title_seed TEXT,
      source_proposed_plan_thread_id TEXT,
      source_proposed_plan_id TEXT,
      queued_at TEXT NOT NULL,
      enqueue_sequence INTEGER NOT NULL,
      ask_override INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (thread_id, message_id)
    )
  `;
  yield* sql`
    ALTER TABLE projection_thread_turn_queue
    ADD COLUMN ask_override INTEGER NOT NULL DEFAULT 0
  `.pipe(Effect.catch(ignoreDuplicateColumn));

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_turn_queue_thread_sequence
    ON projection_thread_turn_queue(thread_id, enqueue_sequence)
  `;

  yield* sql`
    UPDATE projection_thread_turn_queue
    SET
      ask_override = CASE WHEN interaction_mode = 'ask' THEN 1 ELSE ask_override END,
      interaction_mode = CASE WHEN interaction_mode = 'ask' THEN 'default' ELSE interaction_mode END
  `;
  yield* sql`
    UPDATE projection_thread_turn_queue
    SET model_selection_json = json_set(
      model_selection_json,
      '$.options',
      (
        SELECT json_group_array(
          json_object(
            'id', key,
            'value',
            CASE type
              WHEN 'true' THEN json('true')
              WHEN 'false' THEN json('false')
              ELSE atom
            END
          )
        )
        FROM json_each(json_extract(model_selection_json, '$.options'))
        WHERE (type = 'text' AND trim(coalesce(atom, '')) != '')
           OR type IN ('true', 'false')
      )
    )
    WHERE json_type(model_selection_json, '$.options') = 'object'
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS thread_extension_state (
      thread_id TEXT PRIMARY KEY,
      ask_override TEXT,
      queue_status TEXT NOT NULL DEFAULT 'idle',
      queue_pause_reason TEXT,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    INSERT INTO thread_extension_state (
      thread_id,
      ask_override,
      queue_status,
      queue_pause_reason,
      updated_at
    )
    SELECT
      thread_id,
      NULL,
      'paused',
      'migration',
      MIN(queued_at)
    FROM projection_thread_turn_queue
    GROUP BY thread_id
    ON CONFLICT(thread_id) DO UPDATE SET
      queue_status = 'paused',
      queue_pause_reason = 'migration',
      updated_at = excluded.updated_at
  `;
});
