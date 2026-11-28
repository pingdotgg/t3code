import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { DEFERRED_COMMAND_MESSAGE_CONDITION } from "../../orchestration-v2/deferredCommandMessage.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // A turn start finds these few rows of a long thread without reading the rest of its history.
  // The reads in ProjectionStore.getTurnStartContext must spell the same predicates.
  yield* sql.unsafe(`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_messages_deferred_command_idx
    ON orchestration_v2_projection_messages(thread_id, created_at, message_id)
    WHERE ${DEFERRED_COMMAND_MESSAGE_CONDITION}
  `);
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_subagents_routable_idx
    ON orchestration_v2_projection_subagents(thread_id, subagent_id)
    WHERE origin = 'provider_native' AND status = 'completed'
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_context_transfers_fork_idx
    ON orchestration_v2_projection_context_transfers(target_thread_id)
    WHERE type = 'fork'
  `;
});
