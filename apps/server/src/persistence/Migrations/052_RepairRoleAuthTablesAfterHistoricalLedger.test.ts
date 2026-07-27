import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("052_RepairRoleAuthTablesAfterHistoricalLedger", (it) => {
  it.effect("repairs scope-based auth tables after divergent migrations through 51", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 22 });
      yield* Effect.forEach(
        Array.from({ length: 29 }, (_, index) => index + 23),
        (migrationId) => sql`
          INSERT INTO effect_sql_migrations (migration_id, name)
          VALUES (${migrationId}, ${`HistoricalMigration${migrationId}`})
        `,
      );

      yield* sql`DROP TABLE auth_pairing_links`;
      yield* sql`DROP TABLE auth_sessions`;
      yield* sql`
        CREATE TABLE auth_pairing_links (
          id TEXT PRIMARY KEY,
          credential TEXT NOT NULL UNIQUE,
          method TEXT NOT NULL,
          scopes TEXT NOT NULL,
          subject TEXT NOT NULL,
          label TEXT,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          consumed_at TEXT,
          revoked_at TEXT
        )
      `;
      yield* sql`
        CREATE TABLE auth_sessions (
          session_id TEXT PRIMARY KEY,
          subject TEXT NOT NULL,
          scopes TEXT NOT NULL,
          method TEXT NOT NULL,
          client_label TEXT,
          client_ip_address TEXT,
          client_user_agent TEXT,
          client_device_type TEXT NOT NULL DEFAULT 'unknown',
          client_os TEXT,
          client_browser TEXT,
          issued_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          last_connected_at TEXT,
          revoked_at TEXT
        )
      `;

      yield* runMigrations();

      const pairingColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(auth_pairing_links)
      `;
      const sessionColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(auth_sessions)
      `;
      const migrationRows = yield* sql<{ readonly migrationId: number; readonly name: string }>`
        SELECT migration_id AS "migrationId", name
        FROM effect_sql_migrations
        WHERE migration_id = 52
      `;

      assert.isTrue(pairingColumns.some((column) => column.name === "role"));
      assert.isFalse(pairingColumns.some((column) => column.name === "scopes"));
      assert.isTrue(sessionColumns.some((column) => column.name === "role"));
      assert.isFalse(sessionColumns.some((column) => column.name === "scopes"));
      assert.deepStrictEqual(migrationRows, [
        {
          migrationId: 52,
          name: "RepairRoleAuthTablesAfterHistoricalLedger",
        },
      ]);
    }),
  );
});
