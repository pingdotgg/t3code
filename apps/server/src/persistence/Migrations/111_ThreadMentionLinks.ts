import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import {
  createThreadMentionTriggers,
  insertThreadMentions,
} from "../../orchestration-v2/threadMentionLinks.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE orchestration_v2_thread_mentions (
      message_id TEXT NOT NULL,
      source_thread_id TEXT NOT NULL,
      target_environment_id TEXT NOT NULL,
      target_thread_id TEXT NOT NULL,
      PRIMARY KEY (message_id, target_environment_id, target_thread_id)
    ) WITHOUT ROWID
  `;
  yield* sql`CREATE INDEX orchestration_v2_thread_mentions_source_idx ON orchestration_v2_thread_mentions(source_thread_id)`;
  yield* sql`CREATE INDEX orchestration_v2_thread_mentions_target_idx ON orchestration_v2_thread_mentions(target_thread_id)`;
  yield* createThreadMentionTriggers(sql);
  yield* sql`${insertThreadMentions(sql, "messages")}`;
});
