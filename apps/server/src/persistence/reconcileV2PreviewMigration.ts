import * as Effect from "effect/Effect";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import PullRequestFilesViewed from "./Migrations/053_PullRequestFilesViewed.ts";

// Published V2 previews used 53 before main assigned it to PullRequestFilesViewed.
// Preserve their completed V2 migration without replaying its schema or imports.
// Keep this bridge for upgrades that skip releases; new migrations must be additive.
export const reconcileV2PreviewMigration = Effect.fn("reconcileV2PreviewMigration")(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const tables = yield* sql`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
      `;
      if (tables.length === 0) return [];
      const history = yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id >= 53
      `;
      if (!history.some((row) => row.migration_id === 53 && row.name === "OrchestrationV2")) {
        return [];
      }
      if (history.length !== 1) {
        return yield* new Migrator.MigrationError({
          kind: "BadState",
          message: "Cannot upgrade V2 preview migration 53 with unexpected later migrations.",
        });
      }

      yield* PullRequestFilesViewed;
      yield* sql`
        UPDATE effect_sql_migrations SET migration_id = 54
        WHERE migration_id = 53 AND name = 'OrchestrationV2'
      `;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name) VALUES (53, 'PullRequestFilesViewed')
      `;
      return [[53, "PullRequestFilesViewed"]] as const;
    }),
  );
});
