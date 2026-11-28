import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Keep this expression identical to ProjectionStore's loose worktree filter.
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_threads_worktree_path_key_idx
    ON orchestration_v2_projection_threads(
      CASE WHEN json_valid(payload_json)
        THEN lower(rtrim(replace(trim(json_extract(payload_json, '$.worktreePath')), '\\', '/'), '/'))
      END
    )
  `;
});
