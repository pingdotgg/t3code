import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// fork: generated thread subtitles — persisted on the shell row so every
// client receives them without subscribing to full thread history.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  if (!columns.some((column) => column.name === "subtitle")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN subtitle TEXT
    `;
  }
});
