import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import Migration0087 from "./087_ProjectionThreadActivityJsonIndexes.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* Migration0087;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  if (!columns.some((column) => column.name === "pending_pull_request_association_json")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN pending_pull_request_association_json TEXT NOT NULL DEFAULT 'null'
    `;
  }
});
