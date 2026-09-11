import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("051_ProjectionThreadMessageContext", (it) => {
  it.effect("accepts context added by an earlier development migration", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 50 });
      yield* sql`
        ALTER TABLE projection_thread_messages
        ADD COLUMN context_json TEXT
      `;

      yield* runMigrations({ toMigrationInclusive: 51 });

      const columns = yield* sql<{ readonly name: string; readonly notnull: number }>`
        PRAGMA table_info(projection_thread_messages)
      `;
      const context = columns.find((column) => column.name === "context_json");
      const migrations = yield* sql<{ readonly migration_id: number }>`
        SELECT migration_id
        FROM effect_sql_migrations
        WHERE migration_id = 51
      `;

      assert.equal(context?.name, "context_json");
      assert.equal(context?.notnull, 0);
      assert.equal(migrations.length, 1);
    }),
  );
});
