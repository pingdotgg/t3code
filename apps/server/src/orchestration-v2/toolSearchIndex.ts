import { OrchestrationV2TurnItem, OrchestrationV2TurnItemJson } from "@t3tools/contracts";
import {
  summaryToolText,
  summaryToolTypes,
} from "@t3tools/provider-core/server/conversationEvidence";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";

const BACKFILL_BATCH = 200;

const indexedTypeList = summaryToolTypes.map((type) => `'${type}'`).join(", ");
const decodeItem = Schema.decodeUnknownEffect(Schema.fromJsonString(OrchestrationV2TurnItemJson));

function collectLeaves(value: unknown, out: Array<string>): void {
  if (typeof value === "string") out.push(value);
  else if (typeof value === "number" || typeof value === "boolean") out.push(String(value));
  else if (Array.isArray(value)) for (const entry of value) collectLeaves(entry, out);
  else if (value !== null && typeof value === "object")
    for (const entry of Object.values(value)) collectLeaves(entry, out);
}

const QUERY_ECHOING_TOOL =
  /(?:^|[_.])t3_(?:thread_search|thread_read|conversation_summary_\w+|knowledge_\w+)$/;

// SQLite unicode61 treats JSON-escaped "\nFAILED" as the token "nfailed".
export function toolSearchText(item: OrchestrationV2TurnItem): string | null {
  if (item.type === "dynamic_tool" && QUERY_ECHOING_TOOL.test(item.toolName ?? "")) return null;
  const text = summaryToolText(item);
  if (text === null) return null;
  const leaves: Array<string> = [];
  collectLeaves(JSON.parse(text), leaves);
  return leaves.join("\n");
}

export const toolSearchIndexExists = (sql: SqlClient.SqlClient) =>
  sql<{ readonly found: number }>`
    SELECT 1 AS found FROM sqlite_master WHERE name = 'orchestration_v2_tool_search'
  `.pipe(Effect.map((rows) => rows.length > 0));

export const indexToolItem = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  item: OrchestrationV2TurnItem,
) {
  if (!(yield* toolSearchIndexExists(sql))) return;
  const rows = yield* sql<{ readonly rowid: number }>`
    SELECT rowid FROM orchestration_v2_projection_turn_items WHERE turn_item_id = ${item.id}
  `;
  const rowid = rows[0]?.rowid;
  if (rowid === undefined) return;
  const text = toolSearchText(item);
  if (text === null) {
    yield* sql`DELETE FROM orchestration_v2_tool_search WHERE rowid = ${rowid}`;
  } else {
    yield* sql`
      INSERT OR REPLACE INTO orchestration_v2_tool_search (rowid, text) VALUES (${rowid}, ${text})
    `;
  }
});

export const backfillToolSearchBatch = Effect.fnUntraced(function* (sql: SqlClient.SqlClient) {
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const state = yield* sql<{ readonly cursor: number; readonly end: number }>`
        SELECT cursor, backfill_end AS "end" FROM orchestration_v2_tool_search_state WHERE id = 1
      `;
      const position = state[0];
      if (position === undefined || position.cursor >= position.end) return true;
      const rows = yield* sql<{ readonly rowid: number; readonly payload: string }>`
        SELECT rowid, payload_json AS payload FROM orchestration_v2_projection_turn_items
        WHERE rowid > ${position.cursor} AND rowid <= ${position.end}
          AND type IN (${sql.literal(indexedTypeList)})
        ORDER BY rowid
        LIMIT ${BACKFILL_BATCH}
      `;
      for (const row of rows) {
        const item = yield* decodeItem(row.payload).pipe(Effect.option);
        const text = item._tag === "Some" ? toolSearchText(item.value) : null;
        if (text === null) continue;
        yield* sql`
          INSERT OR REPLACE INTO orchestration_v2_tool_search (rowid, text)
          VALUES (${row.rowid}, ${text})
        `;
      }
      const last = rows.at(-1);
      const next = rows.length < BACKFILL_BATCH || last === undefined ? position.end : last.rowid;
      yield* sql`UPDATE orchestration_v2_tool_search_state SET cursor = ${next} WHERE id = 1`;
      return next >= position.end;
    }),
  );
});

export const resetToolSearch = Effect.fn("ToolSearchIndex.reset")(function* (
  sql: SqlClient.SqlClient,
) {
  if (!(yield* toolSearchIndexExists(sql))) return;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`
        INSERT INTO orchestration_v2_tool_search (orchestration_v2_tool_search)
        VALUES ('delete-all')
      `;
      yield* sql`
        UPDATE orchestration_v2_tool_search_state
        SET cursor = 0,
          backfill_end = (SELECT coalesce(max(rowid), 0) FROM orchestration_v2_projection_turn_items)
        WHERE id = 1
      `;
    }),
  );
});
