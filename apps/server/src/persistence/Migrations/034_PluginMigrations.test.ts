import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("034_PluginMigrations", (it) => {
  it.effect("creates plugin migration tracking table", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 34 });

      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 'plugin_migrations'
      `;
      assert.equal(tables.length, 1);

      yield* sql`
        INSERT INTO plugin_migrations (plugin_id, version, name, applied_at)
        VALUES ('test-plugin', 1, 'Init', '2026-07-03T00:00:00.000Z')
      `;

      const rows = yield* sql<{ readonly version: number; readonly name: string }>`
        SELECT version, name
        FROM plugin_migrations
        WHERE plugin_id = 'test-plugin'
      `;
      assert.deepEqual(rows, [{ version: 1, name: "Init" }]);
    }),
  );
});
