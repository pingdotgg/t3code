import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));
const skippedQueuedTurnsLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

const hasOriginColumn = Effect.fn("hasOriginColumn")(function* (table: string) {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(${sql.literal(table)})`;
  return columns.some((column) => column.name === "origin_json");
});

const tableExists = Effect.fn("tableExists")(function* (table: string) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly count: number }>`
    SELECT count(*) AS count
    FROM sqlite_master
    WHERE type = 'table'
      AND name = ${table}
  `;
  return (rows[0]?.count ?? 0) > 0;
});

layer("056_ProjectionWorkspaceHandoffOrigin", (it) => {
  it.effect("adds the origin column to projected messages and queued turns", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 48 });
      assert.isFalse(yield* hasOriginColumn("projection_thread_messages"));
      assert.isFalse(yield* hasOriginColumn("projection_queued_turns"));

      yield* runMigrations({ toMigrationInclusive: 56 });
      assert.isTrue(yield* hasOriginColumn("projection_thread_messages"));
      assert.isTrue(yield* hasOriginColumn("projection_queued_turns"));
    }),
  );

  it.effect("is safe to replay when the column already exists", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 56 });
      const migration = yield* Effect.promise(
        () => import("./056_ProjectionWorkspaceHandoffOrigin.ts"),
      );
      yield* migration.default;

      assert.isTrue(yield* hasOriginColumn("projection_thread_messages"));
      assert.isTrue(yield* hasOriginColumn("projection_queued_turns"));
    }),
  );
});

skippedQueuedTurnsLayer("056_ProjectionWorkspaceHandoffOrigin skipped queued turns table", (it) => {
  it.effect("creates projection_queued_turns when migration 33 was skipped by a newer ledger", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      // Base schema without the queued-turns table from migration 33.
      yield* runMigrations({ toMigrationInclusive: 32 });
      const now = new Date().toISOString();
      // Simulate a divergent branch whose high-water mark jumped past 33.
      for (const [migrationId, name] of [
        [34, "ProjectionThreadParentThreadId"],
        [36, "RepairRoleAuthTablesAfterScopeMigrations"],
        [41, "ProjectionThreadReviewResult"],
        [42, "ProjectionWorkflows"],
        [43, "ProjectionWorkflowWorkerConfig"],
        [44, "ProjectionTurnsLatestByThreadIndex"],
        [45, "SidebarPinnedThreads"],
        [46, "SidebarAppliedMutations"],
        [47, "CleanupUnrenderablePendingApprovals"],
        [48, "ProjectionThreadMessageSearch"],
        [54, "ProjectionThreadActivityLegacyCursorIndex"],
      ] as const) {
        yield* sql`
              INSERT OR IGNORE INTO effect_sql_migrations (migration_id, created_at, name)
              VALUES (${migrationId}, ${now}, ${name})
            `;
      }
      yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = 33`;
      yield* sql`DROP TABLE IF EXISTS projection_queued_turns`;

      assert.isFalse(yield* tableExists("projection_queued_turns"));

      yield* runMigrations({ toMigrationInclusive: 56 });

      assert.isTrue(yield* tableExists("projection_queued_turns"));
      assert.isTrue(yield* hasOriginColumn("projection_thread_messages"));
      assert.isTrue(yield* hasOriginColumn("projection_queued_turns"));
    }),
  );
});
