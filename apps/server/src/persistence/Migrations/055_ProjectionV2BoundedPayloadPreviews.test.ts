import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { THREAD_HISTORY_MAX_ROW_PAYLOAD_BYTES } from "../../orchestration-v2/threadHistoryPaging.ts";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

const insertTurnItem = (sql: SqlClient.SqlClient, turnItemId: string, payloadJson: string) =>
  sql`
    INSERT INTO orchestration_v2_projection_turn_items (
      turn_item_id,
      thread_id,
      run_id,
      node_id,
      provider_thread_id,
      provider_turn_id,
      parent_item_id,
      ordinal,
      type,
      status,
      updated_at,
      payload_json
    )
    VALUES (
      ${turnItemId},
      'thread-1',
      'run-1',
      NULL,
      NULL,
      NULL,
      NULL,
      1,
      'assistant_message',
      'completed',
      '2026-09-13T00:00:00.000Z',
      ${payloadJson}
    )
  `;

layer("055_ProjectionV2BoundedPayloadPreviews", (it) => {
  it.effect("backfills bounded previews only for over-cap payloads", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 54 });

      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const oversizedPayload = JSON.stringify({
        id: "item-big",
        type: "assistant_message",
        text: "x".repeat(THREAD_HISTORY_MAX_ROW_PAYLOAD_BYTES * 2),
      });
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const smallPayload = JSON.stringify({
        id: "item-small",
        type: "assistant_message",
        text: "hello",
      });
      yield* insertTurnItem(sql, "item-big", oversizedPayload);
      yield* insertTurnItem(sql, "item-small", smallPayload);
      // Built as text because nesting this deep overflows JSON.stringify —
      // runtimes that tolerate it can store it, and JSON1 cannot parse it.
      const deepPayload = `{"id":"item-stack-depth","type":"assistant_message","deep":${"[".repeat(7000)}1${"]".repeat(7000)}}`;
      yield* insertTurnItem(sql, "item-stack-depth", deepPayload);

      yield* runMigrations();

      const rows = yield* sql<{
        readonly turnItemId: string;
        readonly boundedJson: string | null;
        readonly payloadJson: string;
      }>`
        SELECT
          turn_item_id AS "turnItemId",
          bounded_json AS "boundedJson",
          payload_json AS "payloadJson"
        FROM orchestration_v2_projection_turn_items
        ORDER BY turn_item_id
      `;
      const big = rows.find((row) => row.turnItemId === "item-big");
      const small = rows.find((row) => row.turnItemId === "item-small");

      assert.ok(big !== undefined);
      assert.strictEqual(big.payloadJson, oversizedPayload);
      assert.ok(big.boundedJson !== null);
      assert.ok(Buffer.byteLength(big.boundedJson, "utf8") <= THREAD_HISTORY_MAX_ROW_PAYLOAD_BYTES);
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const preview = JSON.parse(big.boundedJson) as { id: string; type: string; text: string };
      assert.strictEqual(preview.id, "item-big");
      assert.strictEqual(preview.type, "assistant_message");
      assert.ok(preview.text.length < oversizedPayload.length);

      assert.ok(small !== undefined);
      assert.strictEqual(small.payloadJson, smallPayload);
      assert.strictEqual(small.boundedJson, null);

      const deep = rows.find((row) => row.turnItemId === "item-stack-depth");
      assert.ok(deep !== undefined);
      // The backfill depth-splices raw text before JSON.parse, so even a
      // payload past the JS serializer stack gets a JSON1-parseable preview.
      assert.ok(deep.boundedJson !== null);
      const deepValid = yield* sql<{ readonly valid: number }>`
        SELECT json_valid(bounded_json) AS valid
        FROM orchestration_v2_projection_turn_items
        WHERE turn_item_id = 'item-stack-depth'
      `;
      assert.deepStrictEqual(deepValid, [{ valid: 1 }]);

      const metadata = yield* sql<{ readonly schemaVersion: number }>`
        SELECT schema_version AS "schemaVersion"
        FROM orchestration_v2_projection_metadata
        WHERE projection_name = 'thread-projections'
      `;
      assert.deepStrictEqual(metadata, [{ schemaVersion: 3 }]);
    }),
  );
});
