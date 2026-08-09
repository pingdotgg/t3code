import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Persists the event-store sequence that proves an exact pending request
 * crossed the durable pre-provider delivery boundary. Existing rows remain
 * NULL so recovery never assumes an older request reached the provider.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE projection_turns
    ADD COLUMN delivery_sequence INTEGER
  `;
});
