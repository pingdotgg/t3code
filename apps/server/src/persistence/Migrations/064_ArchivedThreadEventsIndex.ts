import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_events_v2_archived_threads_idx
    ON orchestration_events(stream_id, sequence)
    WHERE event_type = 'thread.archived'
      AND aggregate_kind = 'thread'
      AND application_event_version = 2
  `;
});
