import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Migration 026 run on SQLite 3.54+ stored canonical options arrays as JSON
 * strings, which no ModelSelection decoder accepts. Options are never a string
 * otherwise, so parsing one that holds an array is unambiguous and idempotent.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // json_type throws on malformed JSON, and SQLite may evaluate AND in either order.
  const holdsArray = (column: string, path: string) =>
    sql.unsafe(`
    json_type(${column}, '${path}') = 'text'
    AND CASE WHEN json_valid(json_extract(${column}, '${path}'))
      THEN json_type(json_extract(${column}, '${path}')) END = 'array'
  `);
  const reparse = (column: string, path: string) =>
    sql.unsafe(`json_set(${column}, '${path}', json(json_extract(${column}, '${path}')))`);

  yield* sql`
    UPDATE projection_threads
    SET model_selection_json = ${reparse("model_selection_json", "$.options")}
    WHERE ${holdsArray("model_selection_json", "$.options")}
  `;
  yield* sql`
    UPDATE projection_projects
    SET default_model_selection_json = ${reparse("default_model_selection_json", "$.options")}
    WHERE ${holdsArray("default_model_selection_json", "$.options")}
  `;
  // One pass: event_type has no index, so each UPDATE scans the whole event log
  // (two scans took 35 s on a cold multi-GB database).
  yield* sql`
    UPDATE orchestration_events
    SET payload_json = CASE
      WHEN event_type IN ('project.created', 'project.meta-updated')
        THEN ${reparse("payload_json", "$.defaultModelSelection.options")}
      ELSE ${reparse("payload_json", "$.modelSelection.options")}
    END
    WHERE (
      event_type IN ('thread.created', 'thread.meta-updated', 'thread.turn-start-requested')
      AND ${holdsArray("payload_json", "$.modelSelection.options")}
    ) OR (
      event_type IN ('project.created', 'project.meta-updated')
      AND ${holdsArray("payload_json", "$.defaultModelSelection.options")}
    )
  `;
});
