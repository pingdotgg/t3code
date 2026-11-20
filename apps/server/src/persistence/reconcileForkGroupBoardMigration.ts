import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

type MigrationRow = { readonly id: number; readonly name: string };

// Fork builds through 0.1.11-fork.1 recorded GroupBoard as 97, an id upstream 0.1.11 took. Dropping
// that row lets upstream's 97-102 run; GroupBoard is idempotent and reruns as 103.
const isForkGroupBoardRow = (row: MigrationRow) => row.id === 97 && row.name === "GroupBoard";

export function reconciledForkGroupBoardHistory(
  history: ReadonlyArray<MigrationRow>,
): ReadonlyArray<MigrationRow> {
  return history.filter((row) => !isForkGroupBoardRow(row));
}

export const reconcileForkGroupBoardMigration = Effect.fn("reconcileForkGroupBoardMigration")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    const tables = yield* sql`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
    `;
    if (tables.length === 0) return;
    yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = 97 AND name = 'GroupBoard'`;
  },
);
