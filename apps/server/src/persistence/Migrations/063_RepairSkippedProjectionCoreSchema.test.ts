import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const skippedCoreSchemaLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));
const healthyLedgerLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

const hasColumn = Effect.fn("hasColumn")(function* (table: string, column: string) {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(${sql.literal(table)})`;
  return columns.some((entry) => entry.name === column);
});

/**
 * Current tree migrations 005/027/028 already add turn-file and provider
 * instance columns. Strip them after the divergent ledger is seeded so 063's
 * 028/032 repair paths are the only way those columns return.
 */
const stripLegacyCoreColumns = Effect.fn("stripLegacyCoreColumns")(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DROP INDEX IF EXISTS idx_provider_session_runtime_instance`;
  yield* sql`DROP INDEX IF EXISTS idx_projection_thread_sessions_instance`;
  yield* sql`
    ALTER TABLE projection_turns
    DROP COLUMN checkpoint_agent_touched_paths_json
  `;
  yield* sql`
    ALTER TABLE projection_turns
    DROP COLUMN checkpoint_turn_files_json
  `;
  yield* sql`
    ALTER TABLE projection_thread_sessions
    DROP COLUMN provider_instance_id
  `;
  yield* sql`
    ALTER TABLE provider_session_runtime
    DROP COLUMN provider_instance_id
  `;
});

const seedDivergentLedgerPastCoreSchema = Effect.fn("seedDivergentLedgerPastCoreSchema")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    // Canonical schema through session instance id, before resume cursor /
    // pending runtime mode / parent thread id.
    yield* runMigrations({ toMigrationInclusive: 28 });
    const now = new Date().toISOString();
    // Official/desktop ledgers from a divergent branch reused 29-35 for
    // unrelated schema, so the canonical 29-34 projection steps never ran.
    for (const [migrationId, name] of [
      [29, "ProjectionThreadDetailOrderingIndexes"],
      [30, "ProjectionThreadShellArchiveIndexes"],
      [31, "AuthAuthorizationScopes"],
      [32, "AuthPairingProofKeyThumbprint"],
      [33, "ProjectionThreadsSettled"],
      [34, "ProjectionThreadsSnoozed"],
      [35, "ProjectionThreadTitleRegeneration"],
    ] as const) {
      yield* sql`
        INSERT OR IGNORE INTO effect_sql_migrations (migration_id, created_at, name)
        VALUES (${migrationId}, ${now}, ${name})
      `;
    }
    yield* stripLegacyCoreColumns();
  },
);

skippedCoreSchemaLayer("063_RepairSkippedProjectionCoreSchema skipped core schema", (it) => {
  it.effect("repairs resume cursor, pending runtime mode, turn files, and parent thread id", () =>
    Effect.gen(function* () {
      yield* seedDivergentLedgerPastCoreSchema();

      assert.isFalse(yield* hasColumn("projection_thread_sessions", "resume_cursor_json"));
      assert.isFalse(yield* hasColumn("projection_threads", "pending_runtime_mode"));
      assert.isFalse(yield* hasColumn("projection_threads", "parent_thread_id"));
      assert.isFalse(yield* hasColumn("projection_turns", "checkpoint_agent_touched_paths_json"));
      assert.isFalse(yield* hasColumn("projection_turns", "checkpoint_turn_files_json"));
      assert.isFalse(yield* hasColumn("projection_thread_sessions", "provider_instance_id"));
      assert.isFalse(yield* hasColumn("provider_session_runtime", "provider_instance_id"));

      yield* runMigrations({ toMigrationInclusive: 63 });

      assert.isTrue(yield* hasColumn("projection_thread_sessions", "resume_cursor_json"));
      assert.isTrue(yield* hasColumn("projection_threads", "pending_runtime_mode"));
      assert.isTrue(yield* hasColumn("projection_threads", "parent_thread_id"));
      assert.isTrue(yield* hasColumn("projection_turns", "checkpoint_agent_touched_paths_json"));
      assert.isTrue(yield* hasColumn("projection_turns", "checkpoint_turn_files_json"));
      assert.isTrue(yield* hasColumn("projection_thread_sessions", "provider_instance_id"));
      assert.isTrue(yield* hasColumn("provider_session_runtime", "provider_instance_id"));

      const repairMigration = yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* sql<{ readonly name: string }>`
            SELECT name FROM effect_sql_migrations WHERE migration_id = 63
          `;
      });
      assert.deepStrictEqual(repairMigration, [{ name: "RepairSkippedProjectionCoreSchema" }]);
    }),
  );

  it.effect("is safe to replay when the core columns already exist", () =>
    Effect.gen(function* () {
      yield* seedDivergentLedgerPastCoreSchema();
      yield* runMigrations({ toMigrationInclusive: 63 });

      const migration = yield* Effect.promise(
        () => import("./063_RepairSkippedProjectionCoreSchema.ts"),
      );
      yield* migration.default;

      assert.isTrue(yield* hasColumn("projection_thread_sessions", "resume_cursor_json"));
      assert.isTrue(yield* hasColumn("projection_threads", "pending_runtime_mode"));
      assert.isTrue(yield* hasColumn("projection_threads", "parent_thread_id"));
      assert.isTrue(yield* hasColumn("projection_turns", "checkpoint_turn_files_json"));
      assert.isTrue(yield* hasColumn("projection_thread_sessions", "provider_instance_id"));
      assert.isTrue(yield* hasColumn("provider_session_runtime", "provider_instance_id"));
    }),
  );
});

healthyLedgerLayer("063_RepairSkippedProjectionCoreSchema healthy ledger", (it) => {
  it.effect("is a no-op when canonical 29-34 migrations already ran", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 34 });
      assert.isTrue(yield* hasColumn("projection_thread_sessions", "resume_cursor_json"));
      assert.isTrue(yield* hasColumn("projection_threads", "pending_runtime_mode"));
      assert.isTrue(yield* hasColumn("projection_threads", "parent_thread_id"));
      assert.isTrue(yield* hasColumn("projection_turns", "checkpoint_turn_files_json"));
      assert.isTrue(yield* hasColumn("projection_thread_sessions", "provider_instance_id"));

      yield* runMigrations({ toMigrationInclusive: 63 });

      assert.isTrue(yield* hasColumn("projection_thread_sessions", "resume_cursor_json"));
      assert.isTrue(yield* hasColumn("projection_threads", "pending_runtime_mode"));
      assert.isTrue(yield* hasColumn("projection_threads", "parent_thread_id"));
      assert.isTrue(yield* hasColumn("projection_turns", "checkpoint_turn_files_json"));
      assert.isTrue(yield* hasColumn("projection_thread_sessions", "provider_instance_id"));
      assert.isTrue(yield* hasColumn("provider_session_runtime", "provider_instance_id"));
    }),
  );
});
