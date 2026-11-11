import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE scheduled_tasks
    ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0
  `;
});
