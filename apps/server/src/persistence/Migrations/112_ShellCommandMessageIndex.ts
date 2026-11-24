import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { SHELL_COMMAND_MESSAGE_CONDITION } from "../../orchestration-v2/deferredCommandMessage.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // ProjectionStore.getTurnStartContext must spell the same predicate for this index to apply.
  yield* sql.unsafe(`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_messages_shell_command_idx
    ON orchestration_v2_projection_messages(thread_id, created_at, message_id)
    WHERE ${SHELL_COMMAND_MESSAGE_CONDITION}
  `);
});
