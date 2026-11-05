import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Tasks a native subagent delegated and its nested native subagents are listed in that
  // subagent's thread but executed by its session's root run, so delivery, Stop and progress
  // find them by run instead of by thread.
  yield* sql`
    CREATE INDEX orchestration_v2_projection_subagents_run_idx
    ON orchestration_v2_projection_subagents(run_id)
  `;
});
