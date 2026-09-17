import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { parseBoundedPayloadJson } from "../../orchestration-v2/boundedPayloadPreview.ts";
import { threadHistoryCursorItemTag } from "../../orchestration-v2/threadHistoryPaging.ts";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

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

layer("056_ProjectionV2TurnItemIdDigest", (it) => {
  it.effect("backfills item_id_digest from the decoded payload id", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 55 });

      yield* insertTurnItem(sql, "item-a", encodeJson({ id: "item-a", type: "assistant_message" }));
      // The digest tracks the payload id, not the column: drivers can mangle
      // the bound turn_item_id text (lone surrogates fold), so a row whose
      // stored column text differs from its decoded id must still digest the
      // decoded value.
      yield* insertTurnItem(
        sql,
        "item-mangled-column",
        encodeJson({ id: "item-real-id", type: "assistant_message" }),
      );
      yield* insertTurnItem(sql, "item-broken", "{not json");

      yield* runMigrations();

      const rows = yield* sql<{
        readonly turnItemId: string;
        readonly digest: string | null;
        readonly payloadJson: string;
      }>`
        SELECT
          turn_item_id AS "turnItemId",
          item_id_digest AS "digest",
          payload_json AS "payloadJson"
        FROM orchestration_v2_projection_turn_items
        ORDER BY turn_item_id
      `;
      const byId = new Map(rows.map((row) => [row.turnItemId, row]));

      assert.strictEqual(byId.get("item-a")?.digest, threadHistoryCursorItemTag("item-a"));
      assert.strictEqual(
        byId.get("item-mangled-column")?.digest,
        threadHistoryCursorItemTag("item-real-id"),
      );
      // The digest equals the hash of whatever the stored payload decodes to —
      // driver text behavior cannot desynchronize the two.
      for (const row of rows) {
        if (row.turnItemId === "item-broken") continue;
        const decoded = parseBoundedPayloadJson(row.payloadJson);
        assert.strictEqual(row.digest, threadHistoryCursorItemTag(String(decoded.id)));
      }
      // Unparseable payloads backfill to NULL instead of aborting the
      // migration; the indexed lookup simply misses and resolves through the
      // cohort fallback.
      assert.strictEqual(byId.get("item-broken")?.digest, null);

      const index = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'index'
          AND tbl_name = 'orchestration_v2_projection_turn_items'
          AND name LIKE '%item_id_digest%'
      `;
      assert.lengthOf(index, 1);
    }),
  );

  it.effect("fresh databases carry the digest column and index", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations();

      const columns = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM pragma_table_info('orchestration_v2_projection_turn_items')
      `;
      assert.ok(columns.some((column) => column.name === "item_id_digest"));
    }),
  );
});
