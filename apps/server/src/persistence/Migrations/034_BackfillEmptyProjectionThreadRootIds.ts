import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    UPDATE projection_threads
    SET root_thread_id = thread_id
    WHERE TRIM(root_thread_id) = ''
  `;
});
