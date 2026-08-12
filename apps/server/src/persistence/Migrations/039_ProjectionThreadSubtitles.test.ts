import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("039_ProjectionThreadSubtitles", (it) => {
  it.effect("adds subtitles when migration 41 reconciles the occupied upstream id", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 39 });

      const columnsBeforeReconciliation = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      assert.notOk(columnsBeforeReconciliation.some((column) => column.name === "subtitle"));
      assert.ok(columnsBeforeReconciliation.some((column) => column.name === "pin_order_key"));

      yield* runMigrations({ toMigrationInclusive: 41 });

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      assert.ok(columns.some((column) => column.name === "subtitle"));

      const indexes = yield* sql<{ readonly name: string }>`
        PRAGMA index_list(projection_turns)
      `;
      assert.ok(indexes.some((index) => index.name === "idx_projection_turns_thread_keyset"));
    }),
  );
});
