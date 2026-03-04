import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
      ALTER TABLE provider_session_runtime
      ADD COLUMN runtime_mode TEXT NOT NULL DEFAULT 'full-access'
    `;

  yield* sql`
    UPDATE provider_session_runtime
    SET runtime_mode = 'full-access'
    WHERE runtime_mode IS NULL
  `;
});
