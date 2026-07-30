import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Fork: reset component preview state.
 *
 * Fork databases carry preview state written under the old field names
 * (`previewConfig` / `previewWorkspaceRecords`) and old prompt contracts.
 * Clear projected columns and strip the legacy payload fields so the
 * re-ported component preview system starts from a clean slate under the
 * `componentPreviewWorkspaceRecords` field.
 */
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
      json_remove(payload_json, '$.previewConfig', '$.previewWorkspaceRecords'),
      '$.componentPreviewWorkspaceRecords',
      json('[]')
    )
    WHERE event_type IN ('project.created', 'project.meta-updated')
  `;
});
