import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE projection_projects
    ADD COLUMN has_custom_title INTEGER NOT NULL DEFAULT 0
  `;
  yield* sql`
    UPDATE projection_projects
    SET has_custom_title = 1
    WHERE project_id IN (
      SELECT stream_id FROM orchestration_events
      WHERE aggregate_kind = 'project'
        AND event_type = 'project.meta-updated'
        AND json_type(payload_json, '$.title') = 'text'
    )
  `;
});
