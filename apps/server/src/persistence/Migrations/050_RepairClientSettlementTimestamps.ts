import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Follow up 046 for the client-attributed sweeps reported in #10937. Manual
// settles have the same event shape, so require the affected client versions,
// a pre-September-5 stamp, and at least 10 distinct threads within two minutes.
// ponytail: burst detection is heuristic and quadratic in this bounded cohort;
// exact classification would need provenance those old clients did not record.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    WITH legacy_settlements AS MATERIALIZED (
      SELECT
        stream_id AS thread_id,
        occurred_at,
        unixepoch(occurred_at, 'subsec') AS occurred_seconds
      FROM orchestration_events
      WHERE aggregate_kind = 'thread'
        AND event_type = 'thread.settled'
        AND actor_kind = 'client'
        AND json_type(payload_json, '$.settledAt') = 'text'
        AND json_extract(payload_json, '$.settledAt') = occurred_at
        AND json_extract(metadata_json, '$.origin.appVersion') IN ('0.0.35', '0.0.36', '0.0.37', '0.0.38')
        AND julianday(occurred_at) < julianday('2026-09-05T00:00:00.000Z')
    ),
    sweeps AS MATERIALIZED (
      SELECT occurred_seconds AS started_seconds
      FROM legacy_settlements AS first
      WHERE (
        SELECT COUNT(DISTINCT other.thread_id)
        FROM legacy_settlements AS other
        WHERE other.occurred_seconds BETWEEN first.occurred_seconds AND first.occurred_seconds + 120
      ) >= 10
    ),
    automatic_settlements AS (
      SELECT * FROM legacy_settlements AS legacy
      WHERE EXISTS (
        SELECT 1 FROM sweeps
        WHERE legacy.occurred_seconds BETWEEN sweeps.started_seconds AND sweeps.started_seconds + 120
      )
    ),
    activity_timestamps AS (
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
        AND automatic.occurred_at = thread.settled_at
      LIMIT 1
    )
    WHERE thread.settled_override = 'settled'
      AND EXISTS (
        SELECT 1
        FROM automatic_settlements AS automatic
        WHERE automatic.thread_id = thread.thread_id
          AND automatic.occurred_at = thread.settled_at
      )
  `;
});
