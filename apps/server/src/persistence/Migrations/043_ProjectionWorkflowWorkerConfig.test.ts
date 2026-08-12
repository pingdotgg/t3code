import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

const workerConfigColumns = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{
    readonly name: string;
    readonly type: string;
    readonly notnull: number;
    readonly dflt_value: string | null;
  }>`PRAGMA table_info(projection_workflow_runs)`;
  return columns
    .filter((column) => column.name === "worker_config_json")
    .map((column) => ({
      name: column.name,
      type: column.type,
      notnull: column.notnull,
      dflt_value: column.dflt_value,
    }));
});

layer("043_ProjectionWorkflowWorkerConfig", (it) => {
  it.effect("adds worker_config_json on a fresh ledger", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 42 });
      assert.strictEqual((yield* workerConfigColumns).length, 0);

      yield* runMigrations({ toMigrationInclusive: 43 });

      const columns = yield* workerConfigColumns;
      assert.strictEqual(columns.length, 1);
      assert.deepStrictEqual(columns[0], {
        name: "worker_config_json",
        type: "TEXT",
        notnull: 1,
        dflt_value: "'{}'",
      });
    }),
  );

  it.effect(
    "replays when worker_config_json already exists but migrations after 40 are unrecorded",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        // Apply the schema effect, then drop the ledger past 40 to reproduce
        // the startup failure: column present, migrations 41+ missing.
        yield* runMigrations({ toMigrationInclusive: 43 });
        yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id > 40`;

        assert.strictEqual((yield* workerConfigColumns).length, 1);

        yield* runMigrations({ toMigrationInclusive: 43 });

        const columns = yield* workerConfigColumns;
        assert.strictEqual(columns.length, 1);
        assert.deepStrictEqual(columns[0], {
          name: "worker_config_json",
          type: "TEXT",
          notnull: 1,
          dflt_value: "'{}'",
        });

        const migrationRows = yield* sql<{
          readonly migrationId: number;
          readonly name: string;
        }>`
          SELECT migration_id AS "migrationId", name
          FROM effect_sql_migrations
          WHERE migration_id = 43
        `;
        assert.deepStrictEqual(migrationRows, [
          {
            migrationId: 43,
            name: "ProjectionWorkflowWorkerConfig",
          },
        ]);
      }),
  );

  it.effect("is safe to replay when the column already exists", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 43 });
      const migration = yield* Effect.promise(
        () => import("./043_ProjectionWorkflowWorkerConfig.ts"),
      );
      yield* migration.default;

      assert.strictEqual((yield* workerConfigColumns).length, 1);
    }),
  );
});
