import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ensureRoleAuthSessionsTable } from "./036_RepairRoleAuthTablesAfterScopeMigrations.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* ensureRoleAuthSessionsTable;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(auth_sessions)
  `;

  if (!columns.some((column) => column.name === "scopes")) {
    yield* sql`ALTER TABLE auth_sessions ADD COLUMN scopes TEXT`;
  }
});
