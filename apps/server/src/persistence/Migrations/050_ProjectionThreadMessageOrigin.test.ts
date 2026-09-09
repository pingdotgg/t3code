import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layerMemory())("050_ProjectionThreadMessageOrigin", (it) => {
  it.effect("adds a nullable origin column to projection_thread_messages", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 49 });
      const before = yield* sql<{
        readonly name: string;
      }>`PRAGMA table_info(projection_thread_messages)`;
      assert.isFalse(before.some((column) => column.name === "origin"));

      yield* runMigrations({ toMigrationInclusive: 50 });
      const after = yield* sql<{ readonly name: string; readonly notnull: number }>`
        PRAGMA table_info(projection_thread_messages)
      `;
      const origin = after.find((column) => column.name === "origin");
      assert.isDefined(origin);
      assert.equal(origin?.notnull, 0);
    }),
  );
});
