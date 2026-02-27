import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

const DEFAULT_APPROVAL_POLICY = "never";
const DEFAULT_SANDBOX_MODE = "workspace-write";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
      ALTER TABLE projection_thread_sessions
      ADD COLUMN approval_policy TEXT NOT NULL DEFAULT 'never'
    `;

  yield* sql`
      ALTER TABLE projection_thread_sessions
      ADD COLUMN sandbox_mode TEXT NOT NULL DEFAULT 'workspace-write'
    `;

  yield* sql`
    UPDATE projection_thread_sessions
    SET approval_policy = ${DEFAULT_APPROVAL_POLICY}
    WHERE approval_policy IS NULL
  `;
  yield* sql`
    UPDATE projection_thread_sessions
    SET sandbox_mode = ${DEFAULT_SANDBOX_MODE}
    WHERE sandbox_mode IS NULL
  `;
});
