import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE VIRTUAL TABLE project_knowledge_fts_vocab USING fts5vocab(project_knowledge_fts, 'row')
  `;
});
