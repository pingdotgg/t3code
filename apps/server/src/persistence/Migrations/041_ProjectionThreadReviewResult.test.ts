import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("041_ProjectionThreadReviewResult", (it) => {
  it.effect("applies after migration IDs already recorded by another branch", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 36 });
      yield* Effect.forEach(
        [37, 38, 39, 40],
        (migrationId) => sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (${migrationId}, ${`DivergentMigration${migrationId}`})
      `,
      );

      yield* runMigrations({ toMigrationInclusive: 41 });

      const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_threads)`;
      const migrationRows = yield* sql<{ readonly migrationId: number; readonly name: string }>`
        SELECT migration_id AS "migrationId", name
        FROM effect_sql_migrations
        WHERE migration_id = 41
      `;

      assert.isTrue(columns.some((column) => column.name === "review_snapshot_json"));
      assert.isTrue(columns.some((column) => column.name === "review_result_json"));
      assert.deepStrictEqual(migrationRows, [
        {
          migrationId: 41,
          name: "ProjectionThreadReviewResult",
        },
      ]);
    }),
  );
});
