import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

const hasOriginColumn = Effect.fn("hasOriginColumn")(function* (table: string) {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(${sql.literal(table)})`;
  return columns.some((column) => column.name === "origin_json");
});

layer("054_ProjectionWorkspaceHandoffOrigin", (it) => {
  it.effect("adds the origin column to projected messages and queued turns", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 48 });
      assert.isFalse(yield* hasOriginColumn("projection_thread_messages"));
      assert.isFalse(yield* hasOriginColumn("projection_queued_turns"));

      yield* runMigrations({ toMigrationInclusive: 54 });
      assert.isTrue(yield* hasOriginColumn("projection_thread_messages"));
      assert.isTrue(yield* hasOriginColumn("projection_queued_turns"));
    }),
  );

  it.effect("is safe to replay when the column already exists", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 54 });
      const migration = yield* Effect.promise(
        () => import("./054_ProjectionWorkspaceHandoffOrigin.ts"),
      );
      yield* migration.default;

      assert.isTrue(yield* hasOriginColumn("projection_thread_messages"));
      assert.isTrue(yield* hasOriginColumn("projection_queued_turns"));
    }),
  );
});
