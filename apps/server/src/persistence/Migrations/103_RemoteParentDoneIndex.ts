import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { REMOTE_TASK_OWED_PARENT_DONE_CONDITION } from "../../orchestration-v2/remoteParentDone.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Startup and each settled, archived or deleted thread look for remote tasks not yet told
  // their parent is done; this index holds only those rows. ProjectionStore's read must spell
  // the same predicate.
  yield* sql.unsafe(`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_subagents_remote_parent_done_idx
    ON orchestration_v2_projection_subagents(thread_id, subagent_id)
    WHERE ${REMOTE_TASK_OWED_PARENT_DONE_CONDITION}
  `);
});
