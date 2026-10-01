import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

layer("055_AuthSessionGrantMethod", (it) => {
  it.effect("adds a nullable grant method column to auth sessions", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 54 });
      yield* runMigrations({ toMigrationInclusive: 55 });

      const columns = yield* sql<{ readonly name: string; readonly notnull: number }>`
        PRAGMA table_info(auth_sessions)
      `;
      const grantMethod = columns.find((column) => column.name === "grant_method");

      assert.equal(grantMethod?.name, "grant_method");
      assert.equal(grantMethod?.notnull, 0);
      const threadColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      assert.isTrue(threadColumns.some((column) => column.name === "auto_settle_disabled_at"));
    }),
  );
});
