import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE program_attempts (
      attempt_id TEXT PRIMARY KEY,
      launch_request_id TEXT NOT NULL,
      launch_input_json TEXT NOT NULL,
      launch_input_hash TEXT NOT NULL,
      project_id TEXT NOT NULL,
      thread_id TEXT,
      run_id TEXT,
      cancel_request_id TEXT,
      acknowledge_request_id TEXT,
      terminal_result_json TEXT,
      terminal_acknowledged_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE UNIQUE INDEX program_attempts_launch_request_idx
    ON program_attempts(launch_request_id)
  `;
});
