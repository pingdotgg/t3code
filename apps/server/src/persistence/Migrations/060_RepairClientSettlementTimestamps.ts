import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Follow-up to 046 for the pre-reactor client-attributed auto-settle sweeps
// reported in #10937. Those events carry actor_kind = 'client' with a plain
// command_id, not the server:auto-settle: shape 046 matches, so 046 silently
// skipped them. A one-off manual settle has the same event shape, so this
// only treats an event as automatic when it is also part of a dense burst:
// >= 10 distinct threads settled by one of the known buggy desktop builds
// (0.0.35-0.0.38, before the server-side reactor shipped in #8600) within a
// two-minute span. Membership is gap-based (consecutive qualifying events no
// more than 30 seconds apart stay in the same cluster) rather than
// "anything within two minutes of a qualifying event," so a later unrelated
// manual settle just outside the sweep cannot get chained into it through an
// overlapping window.
//
// Two repair sites, because the V1 -> V2 import can land in between:
// - projection_threads.settled_at is V1's own projection. It is still the
//   only copy of the truth for a thread that has not been imported into V2
//   yet, and importedThread() in LegacyV1ThreadImporter reads this column
//   verbatim, so fixing it here also fixes every thread imported from this
//   point forward.
// - orchestration_v2_projection_threads.payload_json is V2's projection. For
//   a thread already imported before this migration ran, the import already
//   copied the bad settled_at into this JSON blob, and nothing re-reads
//   projection_threads afterwards. The second statement below patches that
//   copy directly, using the same detection and the same last-activity
//   computation, sourced from the legacy tables import reads from (never
//   deleted, so they stay authoritative regardless of transcript-import
//   status).
//
// Both statements update a projection only, matching 046: the engine and
// projectors bootstrap from projection rows and a resume cursor, never a
// full replay, so the historical event payloads can stay as recorded.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Shared burst-detection logic, duplicated across the two statements below
  // because a WITH clause does not carry over between statements.
  const detectBurst = sql`
    legacy_settlements AS (
      SELECT
        stream_id AS thread_id,
        occurred_at,
        unixepoch(occurred_at, 'subsec') AS occurred_seconds
      FROM orchestration_events
      WHERE aggregate_kind = 'thread'
        AND event_type = 'thread.settled'
        AND actor_kind = 'client'
        AND application_event_version = 1
        AND json_type(payload_json, '$.settledAt') = 'text'
        AND json_extract(payload_json, '$.settledAt') = occurred_at
        AND json_extract(metadata_json, '$.origin.appVersion') IN ('0.0.35', '0.0.36', '0.0.37', '0.0.38')
        AND julianday(occurred_at) < julianday('2026-09-05T00:00:00.000Z')
    ),
    -- Gap in seconds to the chronologically previous qualifying event, across
    -- all threads. The sweep fired roughly once a second; a real person
    -- resettling a thread shortly after a sweep lands well outside the gap
    -- below, so it starts a cluster of its own instead of joining the sweep.
    ordered AS (
      SELECT
        thread_id,
        occurred_at,
        occurred_seconds,
        occurred_seconds - LAG(occurred_seconds) OVER (ORDER BY occurred_seconds, thread_id)
          AS gap_seconds
      FROM legacy_settlements
    ),
    -- A new cluster starts whenever the gap exceeds the threshold (or at the
    -- very first row); the running SUM then labels every row with the
    -- cluster it belongs to.
    clustered AS (
      SELECT
        thread_id,
        occurred_at,
        occurred_seconds,
        SUM(CASE WHEN gap_seconds IS NULL OR gap_seconds > 30 THEN 1 ELSE 0 END)
          OVER (ORDER BY occurred_seconds, thread_id) AS cluster_id
      FROM ordered
    ),
    burst_clusters AS (
      SELECT
        cluster_id,
        COUNT(DISTINCT thread_id) AS distinct_thread_count,
        MAX(occurred_seconds) - MIN(occurred_seconds) AS span_seconds
      FROM clustered
      GROUP BY cluster_id
    ),
    automatic_settlements AS (
      SELECT clustered.thread_id, clustered.occurred_at
      FROM clustered
      JOIN burst_clusters ON burst_clusters.cluster_id = clustered.cluster_id
      WHERE burst_clusters.distinct_thread_count >= 10
        AND burst_clusters.span_seconds <= 120
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
  `;

  yield* sql`
    WITH ${detectBurst}
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

  yield* sql`
    WITH ${detectBurst}
    UPDATE orchestration_v2_projection_threads AS thread
    SET payload_json = json_set(
      thread.payload_json,
      '$.settledAt',
      (
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
          json_extract(thread.payload_json, '$.createdAt')
        )
        FROM automatic_settlements AS automatic
        WHERE automatic.thread_id = thread.thread_id
          AND automatic.occurred_at = json_extract(thread.payload_json, '$.settledAt')
        LIMIT 1
      )
    )
    WHERE json_extract(thread.payload_json, '$.settledOverride') = 'settled'
      AND EXISTS (
        SELECT 1
        FROM automatic_settlements AS automatic
        WHERE automatic.thread_id = thread.thread_id
          AND automatic.occurred_at = json_extract(thread.payload_json, '$.settledAt')
      )
  `;
});
