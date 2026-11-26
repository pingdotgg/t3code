import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // An MCP client's access level, which the user can change. Null for every other session, for
  // peer links (the linking side keeps its own copy) and for clients issued before this existed.
  yield* sql`ALTER TABLE auth_sessions ADD COLUMN mcp_access TEXT`;
});
