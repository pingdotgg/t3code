import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const layer = it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));
const updatedAt = "2026-09-01T00:00:00.000Z";
const deliveredPayload = JSON.stringify({ completionDelivery: { state: "delivered" } });

layer("075_SubagentDeliveryState", (it) => {
  it.effect("backfills delivery state without failing on an unreadable payload", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 74 });
      const payloads = [
        ["delivered", deliveredPayload],
        ["unreadable", ""],
      ];
      for (const [id, payload] of payloads) {
        yield* sql`
          INSERT INTO orchestration_v2_projection_subagents (
            subagent_id, thread_id, parent_node_id, provider, origin, status, updated_at,
            payload_json
          ) VALUES (
            ${id}, 'thread-1', 'node-1', 'codex', 'delegated', 'cancelled', ${updatedAt},
            ${payload}
          )
        `;
      }

      yield* runMigrations({ toMigrationInclusive: 75 });
      const rows = yield* sql`
        SELECT subagent_id, completion_delivery_state, payload_json
        FROM orchestration_v2_projection_subagents ORDER BY subagent_id
      `;
      assert.deepStrictEqual(rows, [
        {
          subagent_id: "delivered",
          completion_delivery_state: "delivered",
          payload_json: deliveredPayload,
        },
        { subagent_id: "unreadable", completion_delivery_state: null, payload_json: "" },
      ]);
    }),
  );
});
