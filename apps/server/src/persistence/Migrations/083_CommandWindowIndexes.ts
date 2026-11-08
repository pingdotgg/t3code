import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Reading the runs a new message needs from a compacted thread must not touch the older ones.
  // Fresh-context starts are rare, so their partial index stays tiny.
  yield* sql`
    CREATE INDEX orchestration_v2_projection_runs_fresh_context_idx
    ON orchestration_v2_projection_runs(thread_id, ordinal)
    WHERE CASE WHEN json_valid(payload_json)
      THEN json_extract(payload_json, '$.freshContext') = 1
      ELSE 0 END
  `;
  yield* sql`
    CREATE INDEX orchestration_v2_projection_provider_turns_attempt_idx
    ON orchestration_v2_projection_provider_turns(run_attempt_id)
  `;
});
