import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // A task a native subagent delegated is listed in that subagent's thread but executed by its
  // session's root run, so delivery and Stop find it by run instead of by thread.
  yield* sql`
    CREATE INDEX orchestration_v2_projection_subagents_app_owned_run_idx
    ON orchestration_v2_projection_subagents(run_id)
    WHERE origin = 'app_owned'
  `;
});
