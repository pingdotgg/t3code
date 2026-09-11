import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";

const layer = it.layer(NodeSqliteClient.layerMemory());

layer("051_ProjectionThreadMessageActualModel", (it) => {
  it.effect("adds the nullable actual model to message projections", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 49 });
      yield* runMigrations({ toMigrationInclusive: 51 });

      const columns = yield* sql<{ readonly name: string; readonly notnull: number }>`
        PRAGMA table_info(projection_thread_messages)
      `;
      const actualModel = columns.find((column) => column.name === "actual_model");

      assert.equal(actualModel?.name, "actual_model");
      assert.equal(actualModel?.notnull, 0);
    }),
  );
});
