import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("047_HermesSessionImports", (it) => {
  it.effect("repairs databases whose recorded migration 044 lacks the import ledger", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 46 });
      yield* sql`DROP TABLE hermes_session_imports`;

      yield* runMigrations({ toMigrationInclusive: 47 });

      const migrations = yield* sql<{
        readonly migration_id: number;
        readonly name: string;
      }>`
        SELECT migration_id, name
        FROM effect_sql_migrations
        WHERE migration_id = 47
      `;
      assert.deepStrictEqual(migrations, [
        {
          migration_id: 47,
          name: "HermesSessionImports",
        },
      ]);

      const importColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(hermes_session_imports)
      `;
      assert.deepStrictEqual(
        importColumns.map(({ name }) => name),
        [
          "import_id",
          "provider_instance_id",
          "profile_key",
          "project_id",
          "import_kind",
          "stored_session_key",
          "thread_id",
          "state",
          "created_at",
          "updated_at",
        ],
      );

      const indexes = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'index'
          AND name IN (
            'hermes_session_imports_stored_identity_idx',
            'hermes_session_imports_one_main_idx'
          )
        ORDER BY name
      `;
      assert.deepStrictEqual(
        indexes.map(({ name }) => name),
        ["hermes_session_imports_one_main_idx", "hermes_session_imports_stored_identity_idx"],
      );
    }),
  );
});
