import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { recreateMessageSearchTriggers } from "../../orchestration-v2/messageSearchIndex.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Legacy placeholders stay indexed until rebuild; FTS deletes can overflow last_insert_rowid at commit.
  yield* recreateMessageSearchTriggers(sql);
});
