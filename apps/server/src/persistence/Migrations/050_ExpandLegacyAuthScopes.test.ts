import { AuthEnvironmentScopes } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

const ScopesJson = Schema.fromJsonString(AuthEnvironmentScopes);
const encodeScopes = Schema.encodeSync(ScopesJson);
const decodeScopes = Schema.decodeSync(ScopesJson);

const LEGACY_STANDARD_SCOPES = [
  "orchestration:read",
  "orchestration:operate",
  "terminal:operate",
  "review:write",
  "relay:read",
] as const;
const LEGACY_STANDARD = encodeScopes(LEGACY_STANDARD_SCOPES);

layer("050_ExpandLegacyAuthScopes", (it) => {
  it.effect("expands live legacy credentials and leaves the rest alone", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 49 });

      yield* sql`
        INSERT INTO auth_pairing_links (
          id, credential, method, scopes, subject, label, created_at, expires_at, consumed_at, revoked_at
        )
        VALUES
          ('open', 'cred-open', 'one-time-token', ${LEGACY_STANDARD}, 'one-time-token', NULL,
            '2026-09-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z', NULL, NULL),
          ('narrow', 'cred-narrow', 'one-time-token', ${encodeScopes(["orchestration:read"])}, 'one-time-token', NULL,
            '2026-09-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z', NULL, NULL),
          ('consumed', 'cred-consumed', 'one-time-token', ${LEGACY_STANDARD}, 'one-time-token', NULL,
            '2026-09-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z', '2026-09-02T00:00:00.000Z', NULL),
          ('revoked', 'cred-revoked', 'one-time-token', ${LEGACY_STANDARD}, 'one-time-token', NULL,
            '2026-09-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z', NULL, '2026-09-02T00:00:00.000Z')
      `;

      yield* sql`
        INSERT INTO auth_sessions (session_id, subject, scopes, method, issued_at, expires_at, revoked_at)
        VALUES
          ('live', 'cloud-connect', ${LEGACY_STANDARD}, 'dpop-access-token',
            '2026-09-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z', NULL),
          ('gone', 'cloud-connect', ${LEGACY_STANDARD}, 'dpop-access-token',
            '2026-09-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z', '2026-09-02T00:00:00.000Z')
      `;

      yield* runMigrations({ toMigrationInclusive: 50 });

      const rows = yield* sql<{ readonly id: string; readonly scopes: string }>`
        SELECT id, scopes FROM auth_pairing_links ORDER BY id
      `;
      const byId = new Map(rows.map((row) => [row.id, decodeScopes(row.scopes)]));

      assert.deepStrictEqual(byId.get("open"), [
        "orchestration:read",
        "orchestration:operate",
        "terminal:operate",
        "review:write",
        "relay:read",
        "filesystem:read",
        "diagnostics:read",
        "settings:write",
        "providers:manage",
        "environment:maintain",
        "preview:operate",
        "source-control:write",
        "filesystem:write",
        "terminal:read",
      ]);
      assert.deepStrictEqual(byId.get("narrow"), [
        "orchestration:read",
        "filesystem:read",
        "diagnostics:read",
      ]);
      assert.deepStrictEqual(byId.get("consumed"), LEGACY_STANDARD_SCOPES);
      assert.deepStrictEqual(byId.get("revoked"), LEGACY_STANDARD_SCOPES);

      const sessions = yield* sql<{ readonly id: string; readonly scopes: string }>`
        SELECT session_id AS id, scopes FROM auth_sessions ORDER BY session_id
      `;
      const sessionScopes = new Map(sessions.map((row) => [row.id, decodeScopes(row.scopes)]));
      assert.deepStrictEqual(sessionScopes.get("live"), byId.get("open"));
      assert.deepStrictEqual(sessionScopes.get("gone"), LEGACY_STANDARD_SCOPES);
    }),
  );
});
