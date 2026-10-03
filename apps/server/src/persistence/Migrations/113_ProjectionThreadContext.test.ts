import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

const hasContextColumn = Effect.fn("hasContextColumn")(function* (table: string) {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(${sql.literal(table)})`;
  return columns.some((column) => column.name === "context_json");
});

layer("113_ProjectionThreadContext", (it) => {
  it.effect("adds the context column to projected messages and queued turns", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 112 });
      assert.isFalse(yield* hasContextColumn("projection_thread_messages"));
      assert.isFalse(yield* hasContextColumn("projection_queued_turns"));

      yield* runMigrations({ toMigrationInclusive: 114 });
      assert.isTrue(yield* hasContextColumn("projection_thread_messages"));
      assert.isTrue(yield* hasContextColumn("projection_queued_turns"));
    }),
  );

  it.effect("is safe to replay when the column already exists", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 114 });
      const migration = yield* Effect.promise(() => import("./113_ProjectionThreadContext.ts"));
      yield* migration.default;

      assert.isTrue(yield* hasContextColumn("projection_thread_messages"));
      assert.isTrue(yield* hasContextColumn("projection_queued_turns"));
    }),
  );
});
