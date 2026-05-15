import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("029_ProjectionThreadDetailOrderingIndexes", (it) => {
  it.effect("creates indexes matching thread detail ordering queries", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 28 });
      yield* runMigrations({ toMigrationInclusive: 29 });

      const activityIndexes = yield* sql<{
        readonly seq: number;
        readonly name: string;
        readonly unique: number;
        readonly origin: string;
        readonly partial: number;
      }>`
        PRAGMA index_list(projection_thread_activities)
      `;
      assert.ok(
        activityIndexes.some(
          (index) => index.name === "idx_projection_thread_activities_thread_sequence_created_id",
        ),
      );

      const activityIndexColumns = yield* sql<{
        readonly seqno: number;
        readonly cid: number;
        readonly name: string;
      }>`
        PRAGMA index_info('idx_projection_thread_activities_thread_sequence_created_id')
      `;
      assert.deepStrictEqual(
        activityIndexColumns.map((column) => column.name),
        ["thread_id", "sequence", "created_at", "activity_id"],
      );

      const messageIndexes = yield* sql<{
        readonly seq: number;
        readonly name: string;
        readonly unique: number;
        readonly origin: string;
        readonly partial: number;
      }>`
        PRAGMA index_list(projection_thread_messages)
      `;
      assert.ok(
        messageIndexes.some(
          (index) => index.name === "idx_projection_thread_messages_thread_created_id",
        ),
      );

      const messageIndexColumns = yield* sql<{
        readonly seqno: number;
        readonly cid: number;
        readonly name: string;
      }>`
        PRAGMA index_info('idx_projection_thread_messages_thread_created_id')
      `;
      assert.deepStrictEqual(
        messageIndexColumns.map((column) => column.name),
        ["thread_id", "created_at", "message_id"],
      );
    }),
  );
});
