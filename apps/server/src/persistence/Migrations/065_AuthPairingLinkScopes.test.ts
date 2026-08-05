import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()))("065_AuthPairingLinkScopes", (it) => {
  it.effect("adds nullable scopes without invalidating legacy pairing links", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 64 });
      yield* sql`
        INSERT INTO auth_pairing_links (
          id, credential, method, role, subject, created_at, expires_at
        ) VALUES (
          'legacy-link', 'LEGACYLINK12', 'one-time-token', 'client', 'mobile',
          '2026-08-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 65 });

      const rows = yield* sql<{ readonly id: string; readonly scopes: string | null }>`
        SELECT id, scopes FROM auth_pairing_links
      `;
      assert.deepStrictEqual(rows, [{ id: "legacy-link", scopes: null }]);
    }),
  );
});
