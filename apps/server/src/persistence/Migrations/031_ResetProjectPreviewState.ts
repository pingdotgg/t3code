import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    UPDATE projection_projects
    SET preview_config_json = NULL
    WHERE preview_config_json IS NOT NULL
  `;

  yield* sql`
    UPDATE projection_projects
    SET preview_workspace_records_json = '[]'
    WHERE preview_workspace_records_json IS NULL
       OR preview_workspace_records_json != '[]'
  `;

  yield* sql`
    UPDATE orchestration_events
    SET payload_json = json_set(
      json_remove(payload_json, '$.previewConfig'),
      '$.previewWorkspaceRecords',
      json('[]')
    )
    WHERE event_type IN ('project.created', 'project.meta-updated')
  `;
});
