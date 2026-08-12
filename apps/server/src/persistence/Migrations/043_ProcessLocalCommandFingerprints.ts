import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Persist the payload identity before process-local work begins. A replacement
  // server may replay an accepted durable command only when this exact identity
  // survived from the process that crossed the side-effect boundary.
  yield* sql`
    CREATE TABLE process_local_command_fingerprints (
      command_id TEXT PRIMARY KEY,
      fingerprint TEXT NOT NULL
    )
  `;
});
