import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Reading the runs a new message needs from a compacted thread must not touch the older ones.
  // Every column a lookup could match is wrapped in `|| ''`, so only a lookup that writes the same
  // expression can use these indexes; plain ones were chosen for unrelated statements instead.
  // IF NOT EXISTS: earlier builds created some of these under migrations that were renumbered.
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_turn_items_thread_type_idx
    ON orchestration_v2_projection_turn_items((thread_id || ''), (type || ''), ordinal, turn_item_id)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_runs_id_status_idx
    ON orchestration_v2_projection_runs((run_id || ''), status)
  `;
  // Fresh-context starts are rare, so their partial index stays tiny.
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_runs_fresh_context_idx
    ON orchestration_v2_projection_runs(thread_id, ordinal)
    WHERE CASE WHEN json_valid(payload_json)
      THEN json_extract(payload_json, '$.freshContext') = 1
      ELSE 0 END
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_provider_turns_attempt_idx
    ON orchestration_v2_projection_provider_turns(run_attempt_id)
  `;
});
