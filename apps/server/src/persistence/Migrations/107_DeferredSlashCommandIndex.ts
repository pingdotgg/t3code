import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { DEFERRED_COMMAND_MESSAGE_CONDITION } from "../../orchestration-v2/deferredCommandMessage.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // The turn-start read now matches every slash command; a partial index is only used when its
  // predicate spells the read's condition, so rebuild the one migration 100 made.
  yield* sql`DROP INDEX IF EXISTS orchestration_v2_projection_messages_deferred_command_idx`;
  yield* sql.unsafe(`
    CREATE INDEX orchestration_v2_projection_messages_deferred_command_idx
    ON orchestration_v2_projection_messages(thread_id, created_at, message_id)
    WHERE ${DEFERRED_COMMAND_MESSAGE_CONDITION}
  `);
});
