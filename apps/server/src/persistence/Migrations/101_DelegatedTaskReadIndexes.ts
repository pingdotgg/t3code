import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { DELEGATED_TASK_MESSAGE_CONDITION } from "../../orchestration-v2/delegatedTaskMessage.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Finalizing a delegated task finds its tasks' runs and the child's wakes without reading the
  // child's history. ProjectionStore.getDelegatedChildControls and the delegatedTaskMessagesOnly read
  // must spell the same expressions.
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_runs_delegated_task_idx
    ON orchestration_v2_projection_runs(thread_id, json_extract(payload_json, '$.delegatedTaskId'))
    WHERE json_valid(payload_json) AND json_extract(payload_json, '$.delegatedTaskId') IS NOT NULL
  `;
  yield* sql.unsafe(`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_messages_delegated_task_idx
    ON orchestration_v2_projection_messages(thread_id, created_at, message_id)
    WHERE ${DELEGATED_TASK_MESSAGE_CONDITION}
  `);
});
