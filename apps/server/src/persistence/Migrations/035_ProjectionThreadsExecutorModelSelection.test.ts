import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("035_ProjectionThreadsExecutorModelSelection", (it) => {
  it.effect("adds nullable executor_model_selection column", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 34 });
      yield* runMigrations({ toMigrationInclusive: 35 });

      const columns = yield* sql<{
        readonly cid: number;
        readonly name: string;
        readonly type: string;
        readonly notnull: number;
        readonly dflt_value: string | null;
        readonly pk: number;
      }>`
        PRAGMA table_info(projection_threads)
      `;
      const executorColumn = columns.find((column) => column.name === "executor_model_selection");
      assert.ok(executorColumn, "expected executor_model_selection column");
      assert.strictEqual(executorColumn.notnull, 0);
    }),
  );
});
