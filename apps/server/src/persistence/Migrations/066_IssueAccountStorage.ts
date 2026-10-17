import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE issue_tracker_bindings_next (
    project_id TEXT NOT NULL,
    tracker TEXT NOT NULL,
    native_tracker TEXT NOT NULL,
    scope TEXT NOT NULL,
    host TEXT,
    connection_id TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (project_id, native_tracker),
    FOREIGN KEY (native_tracker, connection_id) REFERENCES issue_tracker_accounts (tracker, connection_id) ON DELETE CASCADE
  ) WITHOUT ROWID`;
  yield* sql`INSERT INTO issue_tracker_bindings_next
    (project_id, tracker, native_tracker, scope, host, connection_id, updated_at)
    SELECT project_id,
      CASE WHEN connection_id IS NULL THEN tracker
        ELSE json_object('tracker', tracker, 'connectionId', connection_id) END,
      tracker, scope, host, connection_id, updated_at FROM issue_tracker_bindings`;
  yield* sql`DROP TABLE issue_tracker_bindings`;
  yield* sql`ALTER TABLE issue_tracker_bindings_next RENAME TO issue_tracker_bindings`;

  for (const [table, path] of [
    ["orchestration_v2_projection_threads", "$.issues"],
    ["orchestration_events", "$.issues"],
    ["orchestration_v2_events", "$.issues"],
  ] as const) {
    yield* sql`UPDATE ${sql(table)} SET payload_json = json_set(payload_json, ${path}, json((
      SELECT json_group_array(json(CASE
        WHEN json_type(link.value, '$.connectionId') = 'text'
          AND json_type(link.value, '$.projectId') = 'text'
        THEN json_remove(json_set(link.value, '$.projectId', json_object(
          'value', json_extract(link.value, '$.projectId'),
          'connectionId', json_extract(link.value, '$.connectionId')
        )), '$.connectionId')
        ELSE link.value END))
      FROM json_each(payload_json, ${path}) AS link
    ))) WHERE EXISTS (
      SELECT 1 FROM json_each(payload_json, ${path}) AS link
      WHERE json_type(link.value, '$.connectionId') = 'text'
        AND json_type(link.value, '$.projectId') = 'text'
    )`;
  }
});
