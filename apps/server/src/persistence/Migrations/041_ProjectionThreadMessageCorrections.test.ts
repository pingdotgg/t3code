import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import Migration041 from "./041_ProjectionThreadMessageCorrections.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("041_ProjectionThreadMessageCorrections", (it) => {
  it.effect("adds nullable correction columns to message projections", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 40 });
      yield* runMigrations({ toMigrationInclusive: 41 });

      const columns = yield* sql<{ readonly name: string; readonly notnull: number }>`
        PRAGMA table_info(projection_thread_messages)
      `;
      for (const name of [
        "original_text",
        "correction_target_message_id",
        "correction_replacement_text",
      ]) {
        const column = columns.find((candidate) => candidate.name === name);
        assert.equal(column?.name, name);
        assert.equal(column?.notnull, 0);
      }
    }),
  );

  it.effect("applies on a fresh database and remains idempotent", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 41 });
      yield* Migration041;
      yield* Migration041;

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_thread_messages)
      `;
      const correctionColumns = columns
        .map((column) => column.name)
        .filter((name) =>
          ["original_text", "correction_target_message_id", "correction_replacement_text"].includes(
            name,
          ),
        );
      assert.deepEqual(correctionColumns, [
        "original_text",
        "correction_target_message_id",
        "correction_replacement_text",
      ]);
    }),
  );
});
