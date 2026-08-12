import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("041_ProjectionThreadsOperator", (it) => {
  it.effect("adds durable Operator ownership and workspace columns", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 40 });
      yield* runMigrations({ toMigrationInclusive: 41 });

      const columns = yield* sql<{
        readonly name: string;
        readonly notnull: number;
        readonly dflt_value: string | null;
      }>`
        PRAGMA table_info(projection_threads)
      `;
      const byName = new Map(columns.map((column) => [column.name, column]));

      for (const name of [
        "operator_parent_thread_id",
        "operator_batch_id",
        "operator_workspace_path",
        "operator_workspace_branch",
      ]) {
        assert.equal(byName.get(name)?.notnull, 0);
      }

      const indexes = yield* sql<{ readonly name: string }>`
        PRAGMA index_list(projection_threads)
      `;
      assert.equal(
        indexes.some((index) => index.name === "idx_projection_threads_operator_parent"),
        true,
      );
    }),
  );
});
