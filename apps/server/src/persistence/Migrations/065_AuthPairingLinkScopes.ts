import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ensureRoleAuthPairingLinksTable } from "./036_RepairRoleAuthTablesAfterScopeMigrations.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* ensureRoleAuthPairingLinksTable;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(auth_pairing_links)
  `;

  if (!columns.some((column) => column.name === "scopes")) {
    yield* sql`ALTER TABLE auth_pairing_links ADD COLUMN scopes TEXT`;
  }
});
