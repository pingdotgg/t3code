import { ATTACHMENT_ONLY_BOOTSTRAP_PROMPT } from "@t3tools/shared/composerContextReferences";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import {
  createMessageSearchTriggers,
  nonPlaceholderMessageCondition,
} from "../../orchestration-v2/messageSearchIndex.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const index = yield* sql`
    SELECT 1 FROM sqlite_master WHERE name = 'orchestration_v2_message_search'
  `;
  if (index.length === 0) return;

  yield* sql`DROP TRIGGER orchestration_v2_message_search_insert`;
  yield* sql`DROP TRIGGER orchestration_v2_message_search_update`;
  yield* sql`DROP TRIGGER orchestration_v2_message_search_delete`;
  yield* createMessageSearchTriggers(sql);

  // FTS narrows cleanup to matching text; don't scan or rebuild the full message history.
  yield* sql`
    DELETE FROM orchestration_v2_message_search WHERE rowid IN (
      SELECT orchestration_v2_message_search.rowid FROM orchestration_v2_message_search
      INNER JOIN orchestration_v2_projection_messages AS messages
        ON messages.rowid = orchestration_v2_message_search.rowid
      WHERE orchestration_v2_message_search MATCH ${`"${ATTACHMENT_ONLY_BOOTSTRAP_PROMPT.replaceAll('"', '""')}"`}
        AND NOT (${nonPlaceholderMessageCondition(sql)})
    )
  `;
});
