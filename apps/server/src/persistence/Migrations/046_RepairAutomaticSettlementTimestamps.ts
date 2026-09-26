import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Server auto-settlement used to stamp settledAt with the sweep time instead
// of the thread's last activity. Repair the projection only: the engine and
// projectors bootstrap from projection rows and cursors, never a full replay,
// so the historical event payloads can stay as they were recorded. The
// decider stamped settledAt and occurred_at from the same clock read, which
// is how an unrepaired automatic settlement is identified below.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    WITH activity_timestamps AS (
      SELECT thread_id, created_at AS activity_at
      FROM projection_thread_messages
      WHERE role = 'user'
      UNION ALL
      SELECT thread_id, requested_at
      FROM projection_turns
      UNION ALL
      SELECT thread_id, started_at
      FROM projection_turns
      WHERE started_at IS NOT NULL
      UNION ALL
      SELECT thread_id, completed_at
      FROM projection_turns
      WHERE completed_at IS NOT NULL
    ),
    automatic_settlements AS (
      SELECT
        stream_id AS thread_id,
        occurred_at,
        json_extract(payload_json, '$.settledAt') AS settled_at
      FROM orchestration_events
      WHERE aggregate_kind = 'thread'
        AND event_type = 'thread.settled'
        AND actor_kind = 'server'
        AND command_id LIKE 'server:auto-settle:%'
        AND json_type(payload_json, '$.settledAt') = 'text'
        AND json_extract(payload_json, '$.settledAt') = occurred_at
    )
    UPDATE projection_threads AS thread
    SET settled_at = (
      SELECT COALESCE(
        (
          SELECT activity.activity_at
          FROM activity_timestamps AS activity
          WHERE activity.thread_id = thread.thread_id
            AND julianday(activity.activity_at) IS NOT NULL
            AND julianday(activity.activity_at) <= julianday(automatic.occurred_at)
          ORDER BY julianday(activity.activity_at) DESC
          LIMIT 1
        ),
        thread.created_at
      )
      FROM automatic_settlements AS automatic
      WHERE automatic.thread_id = thread.thread_id
        AND automatic.settled_at = thread.settled_at
      LIMIT 1
    )
    WHERE thread.settled_override = 'settled'
      AND EXISTS (
        SELECT 1
        FROM automatic_settlements AS automatic
        WHERE automatic.thread_id = thread.thread_id
          AND automatic.settled_at = thread.settled_at
      )
  `;
});
