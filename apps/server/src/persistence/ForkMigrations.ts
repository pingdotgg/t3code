import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import SubagentModelSelection from "./ForkMigrations/001_SubagentModelSelection.ts";
import ThreadViewed from "./ForkMigrations/002_ThreadViewed.ts";
import AgentMailbox from "./ForkMigrations/003_AgentMailbox.ts";
import MailboxWake from "./ForkMigrations/004_MailboxWake.ts";
import ClearAutomaticProjectModelDefaults from "./Migrations/044_ClearAutomaticProjectModelDefaults.ts";

const legacyNames = [
  "ProjectionThreadSubagentModelSelection",
  "ProjectionThreadsLastViewedAt",
  "AgentMailbox",
  "MailboxWake",
  "ProjectionThreadBranchPullRequest",
  "ProjectionThreadsActiveOrderKey",
  "ProjectionThreadPullRequests",
  "ProjectionThreadMessageContext",
  "ProjectionThreadTitleState",
  "PullRequestFilesViewed",
  "ProjectionThreadsAutoSettleDisabledAt",
] as const;

const migrationLedgerExists = Effect.fn("migrationLedgerExists")(function* (table: string) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${table}
  `;
  return rows.length > 0;
});

/** Move the released fork ledger to upstream numbering before upstream runs V2. */
export const reconcileForkMigrationHistory = Effect.fn("reconcileForkMigrationHistory")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    if (!(yield* migrationLedgerExists("effect_sql_migrations"))) return;
    const legacy = yield* sql`
      SELECT migration_id FROM effect_sql_migrations
      WHERE migration_id IN (44, 48) AND name = ${legacyNames[0]}
    `;
    if (legacy.length === 0) return;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const earlyFork = yield* sql`
          SELECT migration_id FROM effect_sql_migrations
          WHERE migration_id = 44 AND name = 'ProjectionThreadSubagentModelSelection'
        `;
        if (earlyFork.length > 0) {
          // The first fork release used 44 before moving its column to 48.
          // Moving the later ledger alone leaves upstream's data repair skipped.
          yield* ClearAutomaticProjectModelDefaults;
          yield* sql`UPDATE effect_sql_migrations
            SET name = 'ClearAutomaticProjectModelDefaults' WHERE migration_id = 44`;
        }
        const history = yield* sql<{
          readonly migration_id: number;
          readonly name: string;
          readonly created_at: string;
        }>`SELECT migration_id, name, created_at FROM effect_sql_migrations WHERE migration_id >= 48 ORDER BY migration_id`;
        if (history[0]?.name !== legacyNames[0]) return;
        if (
          history.some(
            (row, index) => row.migration_id !== 48 + index || row.name !== legacyNames[index],
          )
        ) {
          return yield* new Migrator.MigrationError({
            kind: "BadState",
            message: "Cannot upgrade PseudoCode with an unexpected fork migration history.",
          });
        }
        yield* sql`CREATE TABLE IF NOT EXISTS pseudocode_migrations (
          migration_id INTEGER PRIMARY KEY NOT NULL,
          created_at DATETIME NOT NULL DEFAULT current_timestamp,
          name VARCHAR(255) NOT NULL
        )`;
        // Validate the complete known history before changing any IDs. The transaction
        // moves applied records only: no schema migration is rerun or silently skipped.
        yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id >= 48`;
        for (const row of history) {
          if (row.migration_id <= 51) {
            yield* sql`INSERT INTO pseudocode_migrations (migration_id, name, created_at)
              VALUES (${row.migration_id - 47}, ${row.name}, ${row.created_at})`;
          } else {
            yield* sql`INSERT INTO effect_sql_migrations (migration_id, name, created_at)
              VALUES (${row.migration_id - 4}, ${row.name}, ${row.created_at})`;
          }
        }
      }),
    );
  },
);

const run = Migrator.make({});
const forkMigrations = [
  [1, "ProjectionThreadSubagentModelSelection", SubagentModelSelection],
  [2, "ProjectionThreadsLastViewedAt", ThreadViewed],
  [3, "AgentMailbox", AgentMailbox],
  [4, "MailboxWake", MailboxWake],
] as const;
const latestForkMigrationId = forkMigrations.at(-1)?.[0] ?? 0;
const forkLedger = "pseudocode_migrations";

/** Fork additions have their own ledger so future upstream IDs cannot mask them. */
export const runForkMigrations = Effect.fn("runForkMigrations")(function* () {
  const sql = yield* SqlClient.SqlClient;
  if (yield* migrationLedgerExists(forkLedger)) {
    const [latest] = yield* sql<{ readonly id: number | null }>`
      SELECT MAX(migration_id) AS id FROM ${sql(forkLedger)}
    `;
    if ((latest?.id ?? 0) >= latestForkMigrationId) return [];
  }
  return yield* run({
    table: forkLedger,
    loader: Migrator.fromRecord(
      Object.fromEntries(
        forkMigrations.map(([id, name, migration]) => [`${id}_${name}`, migration]),
      ),
    ),
  });
});
