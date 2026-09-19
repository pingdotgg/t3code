import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const insertTurnItem = (
  sql: SqlClient.SqlClient,
  turnItemId: string,
  payloadJson: string,
  boundedJson: string | null,
) =>
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
      payload_json,
      bounded_json
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
      ${payloadJson},
      ${boundedJson}
    )
  `;

layer("057_ProjectionV2TurnItemPayloadTruncated", (it) => {
  it.effect("flags stored previews and leaves unbounded rows alone", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 56 });

      const fullPayload = encodeJson({
        id: "item-truncated",
        type: "assistant_message",
        text: "a".repeat(200_000),
      });
      const preview = encodeJson({
        id: "item-truncated",
        type: "assistant_message",
        text: "a",
      });
      yield* insertTurnItem(sql, "item-truncated", fullPayload, preview);
      yield* insertTurnItem(
        sql,
        "item-flagged-already",
        fullPayload,
        encodeJson({
          id: "item-flagged-already",
          type: "assistant_message",
          payloadTruncated: true,
        }),
      );
      yield* insertTurnItem(
        sql,
        "item-small",
        encodeJson({ id: "item-small", type: "assistant_message", text: "ok" }),
        null,
      );

      yield* runMigrations();

      const rows = yield* sql<{
        readonly turnItemId: string;
        readonly truncated: unknown;
        readonly boundedJson: string | null;
      }>`
        SELECT
          turn_item_id AS "turnItemId",
          json_extract(bounded_json, '$.payloadTruncated') AS truncated,
          bounded_json AS "boundedJson"
        FROM orchestration_v2_projection_turn_items
        ORDER BY turn_item_id
      `;
      const byId = new Map(rows.map((row) => [row.turnItemId, row]));

      // A stored preview exists only when content was dropped, so every
      // preview row is flagged — including one written before this migration.
      assert.strictEqual(byId.get("item-truncated")?.truncated, 1);
      assert.strictEqual(byId.get("item-flagged-already")?.truncated, 1);
      // Raw-only rows keep no preview and no flag.
      assert.strictEqual(byId.get("item-small")?.boundedJson, null);
      assert.strictEqual(byId.get("item-small")?.truncated, null);
    }),
  );
});
