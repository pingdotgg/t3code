import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("043_ProjectionThreadsOperatorWait", (it) => {
  it.effect("adds the nullable Operator wait timestamp", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 42 });
      yield* runMigrations({ toMigrationInclusive: 43 });

      const columns = yield* sql<{ readonly name: string; readonly notnull: number }>`
        PRAGMA table_info(projection_threads)
      `;
      const waitStartedAt = columns.find((column) => column.name === "operator_wait_started_at");

      assert.equal(waitStartedAt?.name, "operator_wait_started_at");
      assert.equal(waitStartedAt?.notnull, 0);
    }),
  );
});
