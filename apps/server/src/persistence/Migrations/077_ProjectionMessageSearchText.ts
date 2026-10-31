import { assistantCitationsToPlainText } from "@t3tools/shared/assistantCitations";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { createMessageSearchTriggers } from "../../orchestration-v2/messageSearchIndex.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Readable text thread search matches; NULL when it equals the stored text.
  yield* sql`ALTER TABLE orchestration_v2_projection_messages ADD COLUMN search_text TEXT`;

  // The triggers from migration 74 index the stored text, where a quote's
  // words are percent-encoded. Recreated now that search_text exists, they
  // index it instead, and the backfill below re-indexes, through the update
  // trigger, every message that reads differently.
  const index = yield* sql`
    SELECT 1 FROM sqlite_master WHERE name = 'orchestration_v2_message_search'
  `;
  if (index.length > 0) {
    yield* sql`DROP TRIGGER orchestration_v2_message_search_insert`;
    yield* sql`DROP TRIGGER orchestration_v2_message_search_update`;
    yield* sql`DROP TRIGGER orchestration_v2_message_search_delete`;
    yield* createMessageSearchTriggers(sql);
  }

  // Only messages holding a citation link read differently from their stored text.
  const pageSize = 500;
  let afterMessageId = "";
  while (true) {
    const rows = yield* sql<{ readonly message_id: string; readonly text: string }>`
      SELECT message_id, json_extract(payload_json, '$.text') AS text
      FROM orchestration_v2_projection_messages
      WHERE message_id > ${afterMessageId}
        AND json_type(payload_json, '$.text') = 'text'
        AND json_extract(payload_json, '$.text') LIKE '%t3-citation://%'
      ORDER BY message_id
      LIMIT ${pageSize}
    `;
    for (const row of rows) {
      const searchText = assistantCitationsToPlainText(row.text);
      if (searchText === row.text) continue;
      yield* sql`
        UPDATE orchestration_v2_projection_messages
        SET search_text = ${searchText}
        WHERE message_id = ${row.message_id}
      `;
    }
    if (rows.length < pageSize) break;
    afterMessageId = rows.at(-1)!.message_id;
  }
});
