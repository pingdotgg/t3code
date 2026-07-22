import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("044_ProjectionTurnsLatestByThreadIndex", (it) => {
  it.effect("creates the ordered partial index used by snapshot latest-turn lookups", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 43 });
      yield* runMigrations({ toMigrationInclusive: 44 });

      const indexes = yield* sql<{
        readonly name: string;
        readonly partial: number;
      }>`
        PRAGMA index_list(projection_turns)
      `;
      assert.equal(
        indexes.find((index) => index.name === "idx_projection_turns_latest_by_thread")?.partial,
        1,
      );

      const indexColumns = yield* sql<{
        readonly seqno: number;
        readonly name: string;
        readonly desc: number;
        readonly key: number;
      }>`
        PRAGMA index_xinfo('idx_projection_turns_latest_by_thread')
      `;
      assert.deepStrictEqual(
        indexColumns
          .filter((column) => column.key === 1)
          .map((column) => ({ name: column.name, desc: column.desc })),
        [
          { name: "thread_id", desc: 0 },
          { name: "requested_at", desc: 1 },
          { name: "turn_id", desc: 1 },
        ],
      );
    }),
  );
});
