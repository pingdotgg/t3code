import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("047_EnsureProjectionProjectsAutoPull", (it) => {
  it.effect("heals databases whose 045 was skipped by a slot collision", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      // Migrate to just before 045, then simulate a foreign line that claimed
      // ID 45 first: the journal row exists, the column does not. The
      // Migrator's max-ID logic then skips the real 045 forever (#8896).
      yield* runMigrations({ toMigrationInclusive: 44 });
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (45, 'SomethingElse')`;

      yield* runMigrations();

      const columns = yield* sql<{ readonly name: string; readonly notnull: number }>`
        PRAGMA table_info(projection_projects)
      `;
      const autoPull = columns.find((column) => column.name === "auto_pull");
      assert.equal(autoPull?.name, "auto_pull");
      assert.equal(autoPull?.notnull, 1);

      // Healing is recorded and repeat runs stay green.
      const journal = yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id = 47
      `;
      assert.deepStrictEqual(journal, [
        { migration_id: 47, name: "EnsureProjectionProjectsAutoPull" },
      ]);

      yield* runMigrations();
      const rerun = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_projects)
      `;
      assert.isTrue(rerun.some((column) => column.name === "auto_pull"));
    }),
  );

  it.effect("is a no-op when auto_pull already exists", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 46 });
      yield* runMigrations();

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_projects)
      `;
      assert.equal(columns.filter((column) => column.name === "auto_pull").length, 1);
    }),
  );
});
