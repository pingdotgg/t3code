import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX idx_orch_events_goal_awareness
    ON orchestration_events(stream_id, event_type, json_type(payload_json, '$.goal'), sequence)
    WHERE aggregate_kind = 'thread'
      AND (event_type = 'thread.turn-start-requested'
        OR (event_type = 'thread.meta-updated' AND json_type(payload_json, '$.goal') IS NOT NULL))
  `;
});
