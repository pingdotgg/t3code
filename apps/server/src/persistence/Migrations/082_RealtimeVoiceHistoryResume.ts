import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Additive only. The primary key serves both the resume lookup and per-thread deletion.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS orchestration_v2_realtime_voice_history_resume (
      thread_id TEXT NOT NULL,
      provider_instance_id TEXT NOT NULL,
      native_thread_id TEXT NOT NULL,
      cursor TEXT,
      first_identity TEXT,
      first_position INTEGER,
      anchor_ordinal INTEGER,
      PRIMARY KEY (thread_id, provider_instance_id, native_thread_id)
    )
  `;
});
