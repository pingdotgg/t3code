import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    DELETE FROM projection_pending_approvals
    WHERE status = 'pending'
      AND NOT EXISTS (
      SELECT 1
      FROM projection_thread_activities AS activity
      WHERE activity.kind = 'approval.requested'
        AND json_extract(activity.payload_json, '$.requestId')
          = projection_pending_approvals.request_id
        AND (
          json_extract(activity.payload_json, '$.requestKind') IN (
            'command',
            'file-read',
            'file-change'
          )
          OR json_extract(activity.payload_json, '$.requestType') IN (
            'command_execution_approval',
            'exec_command_approval',
            'dynamic_tool_call',
            'file_read_approval',
            'file_change_approval',
            'apply_patch_approval'
          )
        )
    )
  `;

  yield* sql`
    UPDATE projection_threads
    SET pending_approval_count = COALESCE((
      SELECT COUNT(*)
      FROM projection_pending_approvals
      WHERE projection_pending_approvals.thread_id = projection_threads.thread_id
        AND projection_pending_approvals.status = 'pending'
    ), 0)
  `;
});
