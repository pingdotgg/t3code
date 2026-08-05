import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import Migration036 from "./036_RepairRoleAuthTablesAfterScopeMigrations.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("036_RepairRoleAuthTablesAfterScopeMigrations", (it) => {
  it.effect("repairs scope-based auth tables left by a newer migration ledger", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 22 });
      yield* Effect.forEach(
        [23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35],
        (migrationId) => sql`
          INSERT INTO effect_sql_migrations (migration_id, name)
          VALUES (${migrationId}, ${`DivergentMigration${migrationId}`})
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
          proof_key_thumbprint TEXT,
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
      yield* sql`
        INSERT INTO auth_sessions (
          session_id,
          subject,
          scopes,
          method,
          issued_at,
          expires_at
        ) VALUES (
          'incompatible-session',
          'desktop',
          '["orchestration:read"]',
          'bearer-access-token',
          '2026-07-04T00:00:00.000Z',
          '2026-07-05T00:00:00.000Z'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 36 });

      const pairingColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(auth_pairing_links)
      `;
      const sessionColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(auth_sessions)
      `;
      const sessionRows = yield* sql<{ readonly sessionId: string }>`
        SELECT session_id AS "sessionId" FROM auth_sessions
      `;
      const migrationRows = yield* sql<{ readonly migrationId: number; readonly name: string }>`
        SELECT migration_id AS "migrationId", name
        FROM effect_sql_migrations
        WHERE migration_id = 36
      `;

      assert.isTrue(pairingColumns.some((column) => column.name === "role"));
      assert.isFalse(pairingColumns.some((column) => column.name === "scopes"));
      assert.isTrue(sessionColumns.some((column) => column.name === "role"));
      assert.isFalse(sessionColumns.some((column) => column.name === "scopes"));
      assert.deepStrictEqual(sessionRows, []);
      assert.deepStrictEqual(migrationRows, [
        {
          migrationId: 36,
          name: "RepairRoleAuthTablesAfterScopeMigrations",
        },
      ]);
    }),
  );

  it.effect("preserves existing role-based auth records", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 34 });
      yield* sql`
        INSERT INTO auth_sessions (
          session_id,
          subject,
          role,
          method,
          issued_at,
          expires_at
        ) VALUES (
          'existing-session',
          'desktop',
          'owner',
          'browser-session-cookie',
          '2026-07-04T00:00:00.000Z',
          '2026-07-05T00:00:00.000Z'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 36 });

      const sessionRows = yield* sql<{ readonly sessionId: string; readonly role: string }>`
        SELECT session_id AS "sessionId", role FROM auth_sessions
      `;
      assert.deepStrictEqual(sessionRows, [
        {
          sessionId: "existing-session",
          role: "owner",
        },
      ]);
    }),
  );

  it.effect("preserves modern role and scopes auth records when reapplied", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 36 });
      yield* sql`ALTER TABLE auth_pairing_links ADD COLUMN scopes TEXT`;
      yield* sql`ALTER TABLE auth_sessions ADD COLUMN scopes TEXT`;
      yield* sql`
        INSERT INTO auth_pairing_links (
          id, credential, method, role, scopes, subject, created_at, expires_at
        ) VALUES (
          'pairing-modern', 'PAIRINGMODERN', 'one-time-token', 'client',
          '["orchestration:read"]', 'mobile', '2026-08-01T00:00:00.000Z',
          '2026-09-01T00:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO auth_sessions (
          session_id, subject, role, scopes, method, client_device_type, issued_at, expires_at
        ) VALUES (
          'session-modern', 'mobile', 'client', '["orchestration:read"]',
          'bearer-access-token', 'mobile', '2026-08-01T00:00:00.000Z',
          '2026-09-01T00:00:00.000Z'
        )
      `;

      yield* Migration036;

      const pairingRows = yield* sql<{ readonly id: string }>`
        SELECT id FROM auth_pairing_links WHERE id = 'pairing-modern'
      `;
      const sessionRows = yield* sql<{ readonly sessionId: string }>`
        SELECT session_id AS "sessionId" FROM auth_sessions WHERE session_id = 'session-modern'
      `;
      assert.deepStrictEqual(pairingRows, [{ id: "pairing-modern" }]);
      assert.deepStrictEqual(sessionRows, [{ sessionId: "session-modern" }]);
    }),
  );
});
