import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("035_ProjectionThreadForkLineage", (it) => {
  it.effect("adds nullable fork lineage columns and the parent lookup index", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 34 });
      const before = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_threads)`;
      assert.isFalse(before.some((column) => column.name === "forked_from_thread_id"));

      yield* runMigrations({ toMigrationInclusive: 35 });
      const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_threads)`;
      const indexes = yield* sql<{ readonly name: string }>`PRAGMA index_list(projection_threads)`;

      assert.isTrue(columns.some((column) => column.name === "forked_from_thread_id"));
      assert.isTrue(columns.some((column) => column.name === "forked_from_turn_id"));
      assert.isTrue(indexes.some((index) => index.name === "idx_projection_threads_forked_from"));
    }),
  );
});
