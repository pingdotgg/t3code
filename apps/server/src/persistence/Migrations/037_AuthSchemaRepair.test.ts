import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("037_AuthSchemaRepair", (it) => {
  it.effect(
    "repairs databases where old Neuropharm migration ids skipped scoped auth migrations",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        yield* runMigrations({ toMigrationInclusive: 30 });
        yield* sql`
        INSERT INTO auth_pairing_links (
          id,
          credential,
          method,
          role,
          subject,
          created_at,
          expires_at
        )
        VALUES (
          'link-owner',
          'bootstrap-owner',
          'desktop-bootstrap',
          'owner',
          'desktop',
          '2026-05-29T00:00:00.000Z',
          '2026-05-29T01:00:00.000Z'
        )
      `;
        yield* sql`
        INSERT INTO auth_sessions (
          session_id,
          subject,
          role,
          method,
          issued_at,
          expires_at
        )
        VALUES (
          'session-owner',
          'desktop',
          'owner',
          'browser-session-cookie',
          '2026-05-29T00:00:00.000Z',
          '2026-05-29T01:00:00.000Z'
        )
      `;
        yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES
          (31, 'NeuropharmEvidenceLibrary'),
          (32, 'NeuropharmAnalysisRuns')
      `;

        yield* runMigrations({ toMigrationInclusive: 37 });

        const pairingColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(auth_pairing_links)
      `;
        const sessionColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(auth_sessions)
      `;
        const pairingRows = yield* sql<{ readonly id: string }>`
        SELECT id FROM auth_pairing_links
      `;
        const sessionRows = yield* sql<{ readonly sessionId: string }>`
        SELECT session_id AS "sessionId" FROM auth_sessions
      `;

        assert.isTrue(pairingColumns.some((column) => column.name === "scopes"));
        assert.isTrue(pairingColumns.some((column) => column.name === "proof_key_thumbprint"));
        assert.isFalse(pairingColumns.some((column) => column.name === "role"));
        assert.isTrue(sessionColumns.some((column) => column.name === "scopes"));
        assert.isFalse(sessionColumns.some((column) => column.name === "role"));
        assert.deepStrictEqual(pairingRows, []);
        assert.deepStrictEqual(sessionRows, []);
      }),
  );

  it.effect("leaves already-scoped auth rows intact", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 36 });
      yield* sql`
        INSERT INTO auth_pairing_links (
          id,
          credential,
          method,
          scopes,
          subject,
          label,
          proof_key_thumbprint,
          created_at,
          expires_at,
          consumed_at,
          revoked_at
        )
        VALUES (
          'link-scoped',
          'credential-scoped',
          'one-time-token',
          '["orchestration:read"]',
          'one-time-token',
          NULL,
          NULL,
          '2026-05-29T00:00:00.000Z',
          '2026-05-29T01:00:00.000Z',
          NULL,
          NULL
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 37 });

      const pairingRows = yield* sql<{ readonly id: string }>`
        SELECT id FROM auth_pairing_links
      `;

      assert.deepStrictEqual(pairingRows, [{ id: "link-scoped" }]);
    }),
  );
});
