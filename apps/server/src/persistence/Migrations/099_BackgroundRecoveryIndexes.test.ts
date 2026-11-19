import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))(
  "099_BackgroundRecoveryIndexes",
  (it) => {
    it.effect("keeps malformed failure payloads writable", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations();
        yield* sql`INSERT INTO orchestration_v2_projection_turn_items
          (turn_item_id, thread_id, ordinal, type, status, updated_at, payload_json)
          VALUES ('broken', 'broken', 1, 'error', 'failed', '2026-10-01', '{broken')`;
        assert.deepEqual(
          yield* sql`SELECT turn_item_id FROM orchestration_v2_projection_turn_items INDEXED BY
            orchestration_v2_projection_turn_items_usage_limit_idx
            WHERE type = 'error' AND status = 'failed'
              AND CASE WHEN json_valid(payload_json) THEN
                json_extract(payload_json, '$.failure.class') = 'usage_limit'
                ELSE 0 END`,
          [],
        );
      }),
    );
  },
);
