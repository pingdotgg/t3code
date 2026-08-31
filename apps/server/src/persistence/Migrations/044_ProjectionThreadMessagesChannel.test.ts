import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import Migration0044 from "./044_ProjectionThreadMessagesChannel.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

const channelColumns = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string; readonly notnull: number }>`
    PRAGMA table_info(projection_thread_messages)
  `;
  return columns.filter((column) => column.name === "channel");
});

layer("044_ProjectionThreadMessagesChannel", (it) => {
  it.effect("adds the nullable channel column to message projections", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 43 });
      yield* runMigrations({ toMigrationInclusive: 44 });

      const columns = yield* channelColumns;

      assert.equal(columns.length, 1);
      assert.equal(columns[0]?.notnull, 0);
    }),
  );

  it.effect("is a no-op when the column already exists", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 44 });
      yield* Migration0044;

      const columns = yield* channelColumns;

      assert.equal(columns.length, 1);
    }),
  );
});
