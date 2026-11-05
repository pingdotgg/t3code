import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Worktree workspace strategies are gone; stored ones move to the project checkout.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    UPDATE scheduled_tasks
    SET workspace_strategy_json = '{"type":"root"}'
    WHERE json_valid(workspace_strategy_json)
      AND json_extract(workspace_strategy_json, '$.type') IN ('worktree', 'existing_worktree')
  `;
  yield* sql`
    UPDATE orchestration_v2_projection_runs
    SET payload_json = json_set(payload_json, '$.workspacePreparation', json('{"type":"root"}'))
    WHERE json_valid(payload_json)
      AND json_extract(payload_json, '$.workspacePreparation.type') IN ('worktree', 'existing_worktree')
  `;
});
