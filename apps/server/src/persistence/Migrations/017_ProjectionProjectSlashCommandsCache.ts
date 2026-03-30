import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
      ALTER TABLE projection_projects
      ADD COLUMN cached_provider_slash_commands_json TEXT DEFAULT NULL
    `;
});
