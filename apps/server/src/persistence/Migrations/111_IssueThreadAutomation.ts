import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { THREAD_ORGANIZATION_EVENT_CONDITION } from "../../orchestration-v2/threadOrganizationEvent.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS issue_thread_automation (
      thread_id TEXT PRIMARY KEY NOT NULL,
      payload_json TEXT NOT NULL
    )
  `;
  // ProjectionStore.getIssueAutomationRevision reads a thread's newest such event from here.
  yield* sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_orchestration_events_thread_organization
    ON orchestration_events(stream_id, sequence)
    WHERE ${THREAD_ORGANIZATION_EVENT_CONDITION}
  `);
  // ProjectionStore.listActiveShellIndex now also reads `$.snoozedAt`, so 098's index gains it.
  yield* sql`DROP INDEX IF EXISTS orchestration_v2_projection_threads_active_shell_idx`;
  yield* sql`
    CREATE INDEX orchestration_v2_projection_threads_active_shell_idx
    ON orchestration_v2_projection_threads(
      updated_at,
      thread_id,
      project_id,
      CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.lineage.relationshipToParent') END,
      CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.lineage.parentThreadId') END,
      CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.lineage.rootThreadId') END,
      CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.lineage.sideChat') END,
      CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.settledOverride') END,
      CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.settledAt') END,
      CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.pinnedAt') END,
      CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.pinOrderKey') END,
      CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.snoozedUntil') END,
      CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.snoozedAt') END,
      CASE WHEN json_valid(payload_json) THEN json_type(payload_json, '$.pullRequests[0]') END
    )
    WHERE deleted_at IS NULL AND archived_at IS NULL
  `;
});
