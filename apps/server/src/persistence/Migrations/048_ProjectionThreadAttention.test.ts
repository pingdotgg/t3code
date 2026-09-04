import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()))("048_ProjectionThreadAttention", (it) => {
  it.effect("adds nullable attention JSON to thread projections", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 47 });
      yield* runMigrations({ toMigrationInclusive: 48 });

      const columns = yield* sql<{
        readonly name: string;
        readonly notnull: number;
      }>`
          PRAGMA table_info(projection_threads)
        `;
      const attention = columns.find((column) => column.name === "attention_json");
      assert.equal(attention?.name, "attention_json");
      assert.equal(attention?.notnull, 0);
    }),
  );
});
