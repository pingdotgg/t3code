import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import Migration0941 from "./941_ReconcileLegacyForkUpstreamOverlap.ts";

const freshLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));
const legacyLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

const settledColumns = (sql: SqlClient.SqlClient) =>
  sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `.pipe(
    Effect.map((columns) =>
      ["settled_override", "settled_at", "snoozed_until", "snoozed_at"].filter((name) =>
        columns.some((column) => column.name === name),
      ),
    ),
  );

freshLayer("941_ReconcileLegacyForkUpstreamOverlap fresh database", (it) => {
  it.effect("is a no-op on a fresh database", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations();

      const migration = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM effect_sql_migrations
        WHERE migration_id = 941
      `;
      assert.deepStrictEqual(migration, [{ name: "ReconcileLegacyForkUpstreamOverlap" }]);
      assert.deepStrictEqual(yield* settledColumns(sql), [
        "settled_override",
        "settled_at",
        "snoozed_until",
        "snoozed_at",
      ]);
    }),
  );
});

legacyLayer("941_ReconcileLegacyForkUpstreamOverlap legacy overlap database", (it) => {
  it.effect("restores upstream 032-034 effects skipped by legacy fork ids 32-34", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      // Simulate a legacy Forma dev database: upstream chain applied through 31,
      // then legacy fork migrations recorded at ids 32-34 so the migrator never
      // ran upstream 032-034.
      yield* runMigrations({ toMigrationInclusive: 31 });
      // Drop the columns upstream 033/034 would have added if they exist at 31.
      const columnsBefore = yield* settledColumns(sql);
      assert.deepStrictEqual(columnsBefore, []);

      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name, created_at)
        VALUES
          (32, 'ProjectionProjectPreviewWorkspaceRecords', '2026-05-10T00:00:00.000Z'),
          (33, 'ResetProjectPreviewState', '2026-05-10T00:00:00.000Z'),
          (34, 'EnsureProviderInstanceIdColumns', '2026-05-10T00:00:00.000Z')
      `;

      // Running the rest of the chain skips upstream 032-034 (ids recorded)
      // but 941 replays their idempotent effects.
      yield* runMigrations();

      assert.deepStrictEqual(yield* settledColumns(sql), [
        "settled_override",
        "settled_at",
        "snoozed_until",
        "snoozed_at",
      ]);
      const pairingColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(auth_pairing_links)
      `;
      assert.isTrue(pairingColumns.some((column) => column.name === "proof_key_thumbprint"));

      // Replaying the migration directly stays idempotent.
      yield* Migration0941;
      assert.deepStrictEqual(yield* settledColumns(sql), [
        "settled_override",
        "settled_at",
        "snoozed_until",
        "snoozed_at",
      ]);
    }),
  );
});
