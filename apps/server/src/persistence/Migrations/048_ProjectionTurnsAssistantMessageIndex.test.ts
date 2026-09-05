import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("048_ProjectionTurnsAssistantMessageIndex", (it) => {
  it.effect("indexes correlated canonical assistant lookups", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 47 });
      yield* runMigrations({ toMigrationInclusive: 48 });

      const indexes = yield* sql<{
        readonly seq: number;
        readonly name: string;
        readonly unique: number;
        readonly origin: string;
        readonly partial: number;
      }>`
        PRAGMA index_list(projection_turns)
      `;
      const assistantMessageIndex = indexes.find(
        (index) => index.name === "idx_projection_turns_assistant_message_id",
      );
      assert.equal(assistantMessageIndex?.partial, 1);

      const indexColumns = yield* sql<{
        readonly seqno: number;
        readonly cid: number;
        readonly name: string;
      }>`
        PRAGMA index_info('idx_projection_turns_assistant_message_id')
      `;
      assert.deepStrictEqual(
        indexColumns.map((column) => column.name),
        ["assistant_message_id"],
      );

      const plan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT messages.message_id
        FROM projection_thread_messages AS messages
        WHERE messages.role = 'assistant'
          AND EXISTS (
            SELECT 1
            FROM projection_turns AS turns
            WHERE turns.assistant_message_id = messages.message_id
          )
      `;
      assert.ok(
        plan.some((step) => step.detail.includes("idx_projection_turns_assistant_message_id")),
      );
      assert.ok(plan.every((step) => !step.detail.includes("SCAN turns")));
      assert.ok(plan.every((step) => !step.detail.includes("LIST SUBQUERY")));
    }),
  );
});
