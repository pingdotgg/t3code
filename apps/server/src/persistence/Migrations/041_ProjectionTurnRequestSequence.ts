import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Persists the authoritative event-store sequence for pending turn starts.
 * The provider reactor uses it to recover the exact original intent after a
 * restart instead of reconstructing or blindly repeating a provider request.
 * Existing pending rows remain NULL and are treated as legacy/ambiguous.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE projection_turns
    ADD COLUMN request_sequence INTEGER
  `;
});
