import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE orchestration_v2_projection_subagent_activations (
      activation_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      subagent_id TEXT NOT NULL,
      run_id TEXT,
      provider_turn_id TEXT,
      ordinal INTEGER NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      updated_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX orchestration_v2_projection_subagent_activations_thread_idx ON orchestration_v2_projection_subagent_activations(thread_id, subagent_id, ordinal)`;
  yield* sql`CREATE INDEX orchestration_v2_projection_subagent_activations_run_idx ON orchestration_v2_projection_subagent_activations(run_id, status)`;

  // No backfill of orchestration_v2_projection_subagents. Every observability
  // field this schema adds carries a decoding default equal to what a backfill
  // would write, so pre-upgrade rows already read back correctly; and the
  // projection schema version bump makes startup verification fail, which
  // deletes and replays those rows from the event log regardless.
});
