import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("036_ProjectionThreadsParentThreadId", (it) => {
  it.effect("adds nullable parent_thread_id column and index", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 35 });
      yield* runMigrations({ toMigrationInclusive: 36 });

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
      const parentColumn = columns.find((column) => column.name === "parent_thread_id");
      assert.ok(parentColumn, "expected parent_thread_id column");
      assert.strictEqual(parentColumn.notnull, 0);

      const indexes = yield* sql<{ readonly name: string }>`
        PRAGMA index_list(projection_threads)
      `;
      assert.ok(
        indexes.some((index) => index.name === "idx_projection_threads_parent_thread_id"),
        "expected parent_thread_id index",
      );
    }),
  );
});
