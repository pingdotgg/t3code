import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()))("064_AuthSessionScopes", (it) => {
  it.effect("adds nullable scopes without invalidating legacy sessions", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 63 });
      yield* sql`
        INSERT INTO auth_sessions (
          session_id,
          subject,
          role,
          method,
          client_device_type,
          issued_at,
          expires_at
        ) VALUES (
          'legacy-session',
          'desktop',
          'owner',
          'browser-session-cookie',
          'desktop',
          '2026-08-01T00:00:00.000Z',
          '2026-09-01T00:00:00.000Z'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 64 });

      const rows = yield* sql<{ readonly sessionId: string; readonly scopes: string | null }>`
        SELECT session_id AS "sessionId", scopes
        FROM auth_sessions
      `;
      assert.deepStrictEqual(rows, [{ sessionId: "legacy-session", scopes: null }]);
    }),
  );

  it.effect("recreates auth sessions when an earlier create was skipped", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 63 });
      yield* sql`DROP TABLE auth_sessions`;
      yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = 64`;
      yield* runMigrations({ toMigrationInclusive: 64 });

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(auth_sessions)
      `;
      assert.isTrue(columns.some((column) => column.name === "role"));
      assert.isTrue(columns.some((column) => column.name === "client_device_type"));
      assert.isTrue(columns.some((column) => column.name === "scopes"));
    }),
  );
});
