import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("043_ProjectionThreadMessagePhase", (it) => {
  it.effect("adds a nullable constrained message phase column", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 42 });
      yield* runMigrations({ toMigrationInclusive: 43 });

      const columns = yield* sql<{ readonly name: string; readonly notnull: number }>`
        PRAGMA table_info(projection_thread_messages)
      `;
      const messagePhase = columns.find((column) => column.name === "message_phase");

      assert.equal(messagePhase?.name, "message_phase");
      assert.equal(messagePhase?.notnull, 0);
    }),
  );
});
