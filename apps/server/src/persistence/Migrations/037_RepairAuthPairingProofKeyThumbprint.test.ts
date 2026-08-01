import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("037_RepairAuthPairingProofKeyThumbprint", (it) => {
  it.effect("repairs databases where migration 36 removed the proof-key column", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 31 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES
          (32, 'AuthPairingProofKeyThumbprint'),
          (33, 'ProjectionThreadsSettled'),
          (34, 'ProjectionThreadsSnoozed'),
          (35, 'ProjectionThreadTitleRegeneration'),
          (36, 'RepairAuthAuthorizationScopes')
      `;

      yield* runMigrations({ toMigrationInclusive: 37 });

      const pairingColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(auth_pairing_links)
      `;

      assert.isTrue(pairingColumns.some((column) => column.name === "proof_key_thumbprint"));
    }),
  );
});
