import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import Migration0040 from "./040_ProjectionThreadsForkLineage.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("040_ProjectionThreadsForkLineage", (it) => {
  it.effect("is idempotent and keeps lineage optional", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 39 });
      yield* Migration0040;
      yield* Migration0040;

      const columns = yield* sql<{
        readonly name: string;
        readonly notnull: number;
      }>`PRAGMA table_info(projection_threads)`;
      const indexes = yield* sql<{ readonly name: string }>`PRAGMA index_list(projection_threads)`;

      const forkedFrom = columns.find((column) => column.name === "forked_from_thread_id");
      const forkedAt = columns.find((column) => column.name === "forked_at");
      assert.strictEqual(forkedFrom?.notnull, 0);
      assert.strictEqual(forkedAt?.notnull, 0);
      assert.isTrue(
        indexes.some((index) => index.name === "idx_projection_threads_forked_from_thread_id"),
      );
    }),
  );
});
