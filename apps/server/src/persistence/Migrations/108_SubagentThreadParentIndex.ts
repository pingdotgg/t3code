import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import {
  LINEAGE_PARENT_THREAD_ID,
  LIVE_SUBAGENT_THREAD_CONDITION,
} from "../../orchestration-v2/subagentThreadIndex.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // A thread delete finds its subagent threads by their lineage, including ones whose parent has
  // no subagent record for them yet. ProjectionStore.listLiveSubagentThreadIds must spell the same
  // expression and predicate. json_valid keeps a malformed payload writable.
  yield* sql.unsafe(`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_threads_live_subagent_parent_idx
    ON orchestration_v2_projection_threads(${LINEAGE_PARENT_THREAD_ID})
    WHERE ${LIVE_SUBAGENT_THREAD_CONDITION}
  `);
});
