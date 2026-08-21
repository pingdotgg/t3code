import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("041_ProjectionThreadTurnQueue", (it) => {
  it.effect("adds durable queued turns and message delivery state", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 40 });
      yield* runMigrations({ toMigrationInclusive: 41 });

      const messageColumns = yield* sql<{ readonly name: string; readonly notnull: number }>`
        PRAGMA table_info(projection_thread_messages)
      `;
      const deliveryState = messageColumns.find((column) => column.name === "delivery_state");
      assert.equal(deliveryState?.name, "delivery_state");
      assert.equal(deliveryState?.notnull, 0);

      const queueColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_thread_turn_queue)
      `;
      assert.deepEqual(
        queueColumns.map((column) => column.name),
        [
          "message_id",
          "thread_id",
          "event_id",
          "command_id",
          "model_selection_json",
          "title_seed",
          "runtime_mode",
          "interaction_mode",
          "source_proposed_plan_thread_id",
          "source_proposed_plan_id",
          "queued_at",
          "event_sequence",
          "status",
        ],
      );
    }),
  );
});
