import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { createMessageSearchTriggers } from "../../orchestration-v2/messageSearchIndex.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const index = yield* sql`
    SELECT 1 FROM sqlite_master WHERE name = 'orchestration_v2_message_search'
  `;
  if (index.length === 0) return;

  // Legacy placeholders stay indexed until rebuild; FTS deletes can overflow last_insert_rowid at commit.
  yield* sql`DROP TRIGGER orchestration_v2_message_search_insert`;
  yield* sql`DROP TRIGGER orchestration_v2_message_search_update`;
  yield* sql`DROP TRIGGER orchestration_v2_message_search_delete`;
  yield* createMessageSearchTriggers(sql);
});
