import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE projection_thread_messages ADD COLUMN created_sequence INTEGER`;
  yield* sql`ALTER TABLE projection_thread_proposed_plans ADD COLUMN created_sequence INTEGER`;
  yield* sql`ALTER TABLE projection_thread_activities ADD COLUMN created_sequence INTEGER`;
  yield* sql`ALTER TABLE projection_turns ADD COLUMN created_sequence INTEGER`;

  // Bound matches to the current thread incarnation: draft retries can reuse ids.
  // Materialize once so backfilling a large history does not rescan its event log per row.
  yield* sql`
    CREATE TEMP TABLE projection_created_sequence_backfill AS
    WITH lifetimes AS (
      SELECT stream_id, MAX(sequence) AS sequence
      FROM orchestration_events
      WHERE event_type = 'thread.created'
      GROUP BY stream_id
    ), current_events AS MATERIALIZED (
      SELECT events.stream_id, events.sequence, events.event_type,
        CASE events.event_type
          WHEN 'thread.message-sent' THEN json_extract(payload_json, '$.messageId')
          WHEN 'thread.proposed-plan-upserted' THEN json_extract(payload_json, '$.proposedPlan.id')
          WHEN 'thread.activity-appended' THEN json_extract(payload_json, '$.activity.id')
          WHEN 'thread.turn-start-requested' THEN json_extract(payload_json, '$.messageId')
        END AS item_id,
        CASE
          WHEN event_type = 'thread.session-set' AND json_extract(payload_json, '$.session.status') = 'running'
            THEN json_extract(payload_json, '$.session.activeTurnId')
          WHEN event_type = 'thread.message-sent' AND json_extract(payload_json, '$.role') = 'assistant'
            THEN json_extract(payload_json, '$.turnId')
          WHEN event_type IN ('thread.turn-interrupt-requested', 'thread.turn-diff-completed')
            THEN json_extract(payload_json, '$.turnId')
        END AS turn_id
      FROM orchestration_events AS events
      LEFT JOIN lifetimes ON lifetimes.stream_id = events.stream_id
      WHERE events.aggregate_kind = 'thread'
        AND events.sequence >= COALESCE(lifetimes.sequence, 0)
        AND events.event_type IN ('thread.message-sent', 'thread.proposed-plan-upserted',
          'thread.activity-appended', 'thread.turn-start-requested', 'thread.session-set',
          'thread.turn-interrupt-requested', 'thread.turn-diff-completed')
    ), identities AS (
      SELECT stream_id AS thread_id, sequence,
        CASE event_type
          WHEN 'thread.message-sent' THEN 'message'
          WHEN 'thread.proposed-plan-upserted' THEN 'plan'
          WHEN 'thread.activity-appended' THEN 'activity'
          WHEN 'thread.turn-start-requested' THEN 'pending'
        END AS kind,
        item_id
      FROM current_events
      WHERE event_type IN ('thread.message-sent', 'thread.proposed-plan-upserted',
        'thread.activity-appended', 'thread.turn-start-requested')
      UNION ALL
      SELECT stream_id, sequence, 'turn', turn_id
      FROM current_events
      WHERE turn_id IS NOT NULL
    )
    SELECT thread_id, kind, item_id, MIN(sequence) AS sequence
    FROM identities
    WHERE item_id IS NOT NULL
    GROUP BY thread_id, kind, item_id
  `;
  yield* sql`
    CREATE UNIQUE INDEX projection_created_sequence_backfill_key
    ON projection_created_sequence_backfill(thread_id, kind, item_id)
  `;
  yield* sql`
    UPDATE projection_thread_messages AS messages SET created_sequence = (
      SELECT sequence FROM projection_created_sequence_backfill
      WHERE thread_id = messages.thread_id AND kind = 'message' AND item_id = messages.message_id
    )
  `;
  yield* sql`
    UPDATE projection_thread_proposed_plans AS plans SET created_sequence = (
      SELECT sequence FROM projection_created_sequence_backfill
      WHERE thread_id = plans.thread_id AND kind = 'plan' AND item_id = plans.plan_id
    )
  `;
  yield* sql`
    UPDATE projection_thread_activities AS activities SET created_sequence = (
      SELECT sequence FROM projection_created_sequence_backfill
      WHERE thread_id = activities.thread_id AND kind = 'activity' AND item_id = activities.activity_id
    )
  `;
  yield* sql`
    UPDATE projection_turns AS turns SET created_sequence = COALESCE(
      (SELECT created_sequence FROM projection_thread_messages
       WHERE thread_id = turns.thread_id AND message_id = turns.pending_message_id),
      (SELECT sequence FROM projection_created_sequence_backfill
       WHERE thread_id = turns.thread_id AND kind = 'pending' AND item_id = turns.pending_message_id),
      (SELECT sequence FROM projection_created_sequence_backfill
       WHERE thread_id = turns.thread_id AND kind = 'turn' AND item_id = turns.turn_id)
    )
  `;
  yield* sql`DROP TABLE projection_created_sequence_backfill`;

  yield* sql`CREATE INDEX idx_projection_thread_messages_created_sequence
    ON projection_thread_messages(thread_id, COALESCE(created_sequence, 0), created_at, message_id)`;
  yield* sql`CREATE INDEX idx_projection_thread_proposed_plans_created_sequence
    ON projection_thread_proposed_plans(thread_id, COALESCE(created_sequence, 0), created_at, plan_id)`;
  yield* sql`CREATE INDEX idx_projection_thread_activities_created_sequence
    ON projection_thread_activities(thread_id, COALESCE(created_sequence, 0), created_at, activity_id)`;
  yield* sql`CREATE INDEX idx_projection_turns_created_sequence
    ON projection_turns(thread_id, COALESCE(created_sequence, 0), requested_at, turn_id)`;

  yield* sql`
    UPDATE projection_threads SET latest_user_message_at = (
      SELECT created_at FROM projection_thread_messages
      WHERE thread_id = projection_threads.thread_id
        AND role = 'user' AND message_id NOT GLOB 'import:*'
      ORDER BY COALESCE(created_sequence, 0) DESC, created_at DESC, message_id DESC
      LIMIT 1
    )
  `;
  yield* sql`
    WITH lifecycle AS (
      SELECT thread_id, kind, ROW_NUMBER() OVER (
        PARTITION BY thread_id, json_extract(payload_json, '$.requestId')
        ORDER BY COALESCE(created_sequence, 0) DESC, created_at DESC, activity_id DESC
      ) AS position
      FROM projection_thread_activities
      WHERE json_type(payload_json, '$.requestId') = 'text'
        AND (kind IN ('user-input.requested', 'user-input.resolved') OR (
          kind = 'provider.user-input.respond.failed' AND (
            lower(COALESCE(json_extract(payload_json, '$.detail'), '')) LIKE '%stale pending user-input request%'
            OR lower(COALESCE(json_extract(payload_json, '$.detail'), '')) LIKE '%unknown pending user-input request%'
            OR lower(COALESCE(json_extract(payload_json, '$.detail'), '')) LIKE '%unknown pending user input request%'
            OR lower(COALESCE(json_extract(payload_json, '$.detail'), '')) LIKE '%unknown pending codex user input request%'
          )
        ))
    )
    UPDATE projection_threads SET pending_user_input_count = (
      SELECT COUNT(*) FROM lifecycle
      WHERE thread_id = projection_threads.thread_id AND position = 1 AND kind = 'user-input.requested'
    )
  `;
  yield* sql`
    UPDATE projection_threads SET has_actionable_proposed_plan = COALESCE((
      SELECT implemented_at IS NULL FROM projection_thread_proposed_plans
      WHERE thread_id = projection_threads.thread_id
      ORDER BY CASE WHEN turn_id = projection_threads.latest_turn_id THEN 0 ELSE 1 END,
        COALESCE(created_sequence, 0) DESC, updated_at DESC, plan_id DESC
      LIMIT 1
    ), 0)
  `;
});
