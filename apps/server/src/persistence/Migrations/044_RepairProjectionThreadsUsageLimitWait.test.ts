import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import Migration0042 from "./042_ProjectionThreadsOperator.ts";
import Migration0043 from "./043_ProjectionThreadsOperatorWait.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("044_RepairProjectionThreadsUsageLimitWait", (it) => {
  it.effect("repairs databases upgraded from the operator branch", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 40 });
      yield* Migration0042;
      yield* Migration0043;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES
          (41, 'ProjectionThreadsOperator'),
          (42, 'ProjectionThreadsOperatorWait')
      `;

      yield* runMigrations({ toMigrationInclusive: 44 });

      const columns = yield* sql<{ readonly name: string; readonly notnull: number }>`
        PRAGMA table_info(projection_threads)
      `;
      const usageLimitWait = columns.find((column) => column.name === "usage_limit_wait_json");
      const migrations = yield* sql<{ readonly migrationId: number; readonly name: string }>`
        SELECT migration_id AS "migrationId", name
        FROM effect_sql_migrations
        WHERE migration_id = 44
      `;

      assert.equal(usageLimitWait?.name, "usage_limit_wait_json");
      assert.equal(usageLimitWait?.notnull, 0);
      assert.deepStrictEqual(migrations, [
        { migrationId: 44, name: "RepairProjectionThreadsUsageLimitWait" },
      ]);
    }),
  );
});
