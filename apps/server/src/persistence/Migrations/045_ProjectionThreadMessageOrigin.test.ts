import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("045_ProjectionThreadMessageOrigin", (it) => {
  it.effect("adds a nullable origin column to projection_thread_messages", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 44 });
      const before = yield* sql<{
        readonly name: string;
      }>`PRAGMA table_info(projection_thread_messages)`;
      assert.isFalse(before.some((column) => column.name === "origin"));

      yield* runMigrations({ toMigrationInclusive: 45 });
      const after = yield* sql<{ readonly name: string; readonly notnull: number }>`
        PRAGMA table_info(projection_thread_messages)
      `;
      const origin = after.find((column) => column.name === "origin");
      assert.isDefined(origin);
      assert.equal(origin?.notnull, 0);
    }),
  );
});
