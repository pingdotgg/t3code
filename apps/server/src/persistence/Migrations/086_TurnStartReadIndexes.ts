import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import {
  userCommandMessageIndex,
  userCommandPrefix,
} from "../../orchestration-v2/userCommandMessageIndex.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Turn start looks up a thread's /compact and /goal messages without parsing every user message.
  yield* sql`
    CREATE INDEX IF NOT EXISTS ${sql.literal(userCommandMessageIndex)}
    ON orchestration_v2_projection_messages(thread_id, ${sql.literal(userCommandPrefix)})
    WHERE role = 'user'
  `;
  // Covers turn start's routable subagent lookup, so it reads no subagent payloads.
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_subagents_routing_idx
    ON orchestration_v2_projection_subagents(thread_id, status, subagent_id, child_thread_id, provider_thread_id)
  `;
});
