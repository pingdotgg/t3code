import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN latest_user_message_at TEXT
  `.pipe(Effect.catch(() => Effect.void));

  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN pending_approval_count INTEGER NOT NULL DEFAULT 0
  `.pipe(Effect.catch(() => Effect.void));

  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN pending_user_input_count INTEGER NOT NULL DEFAULT 0
  `.pipe(Effect.catch(() => Effect.void));

  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN has_actionable_proposed_plan INTEGER NOT NULL DEFAULT 0
  `.pipe(Effect.catch(() => Effect.void));
});
