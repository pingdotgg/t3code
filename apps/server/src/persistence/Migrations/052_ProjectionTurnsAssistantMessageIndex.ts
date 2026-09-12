import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_turns_assistant_message_id
    ON projection_turns(assistant_message_id)
    WHERE assistant_message_id IS NOT NULL
  `;
});
