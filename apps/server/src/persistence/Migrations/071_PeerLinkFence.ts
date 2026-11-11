import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Whether the link's session was issued as a link, which the peer fences.
  // Links stored before it are not, and must be made again.
  yield* sql`
    ALTER TABLE peer_environment_links ADD COLUMN fenced INTEGER NOT NULL DEFAULT 0
  `;
});
