import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE model_evaluations (
      run_id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      evaluated_at TEXT NOT NULL,
      source_sequence INTEGER NOT NULL,
      source_message_ids TEXT NOT NULL,
      payload_json TEXT NOT NULL
    ) WITHOUT ROWID
  `;
  yield* sql`CREATE INDEX model_evaluations_project_recent
    ON model_evaluations(project_id, evaluated_at DESC, run_id)`;
  yield* sql`
    CREATE TABLE model_evaluation_resets (
      project_id TEXT PRIMARY KEY NOT NULL,
      generation INTEGER NOT NULL,
      reset_at TEXT NOT NULL
    ) WITHOUT ROWID
  `;
  yield* sql`CREATE INDEX model_evaluation_source_revision
    ON orchestration_events(stream_id, json_extract(payload_json, '$.runId'), sequence)
    WHERE application_event_version = 2
      AND aggregate_kind = 'thread'
      AND event_type IN ('message.updated', 'turn-item.updated')`;
  yield* sql`CREATE INDEX model_evaluation_message_revision
    ON orchestration_events(stream_id, json_extract(payload_json, '$.id'), sequence)
    WHERE application_event_version = 2
      AND aggregate_kind = 'thread' AND event_type = 'message.updated'`;
});
