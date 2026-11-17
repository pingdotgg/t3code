import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Thread windows read this flag for every row; scanning payloads on each read
  // dominated thread open. Keep the predicate in step with ProjectionStore.
  yield* sql`
    ALTER TABLE orchestration_v2_projection_turn_items
    ADD COLUMN inline_work_output INTEGER NOT NULL DEFAULT 0
  `;

  // One row per UPDATE: a statement journals every row it rewrites, payload included,
  // and temp_store = MEMORY keeps that journal in RAM until the statement ends.
  const pageSize = 500;
  let afterRowid = 0;
  while (true) {
    const rows = yield* sql<{ readonly id: number }>`
      SELECT rowid AS id
      FROM orchestration_v2_projection_turn_items
      WHERE rowid > ${afterRowid} AND type = 'dynamic_tool' AND (
        payload_json LIKE '%htmlRender%' OR payload_json LIKE '%t3McpApp%'
        OR payload_json LIKE '%"viewedImagePath"%'
        OR payload_json LIKE '%"toolName":"%delegate_task"%'
        OR payload_json LIKE '%"toolName":"%send_to_user"%'
        OR payload_json LIKE '%sentMessage%')
      ORDER BY rowid
      LIMIT ${pageSize}
    `;
    for (const row of rows) {
      yield* sql`
        UPDATE orchestration_v2_projection_turn_items
        SET inline_work_output = 1
        WHERE rowid = ${row.id}
      `;
    }
    if (rows.length < pageSize) break;
    afterRowid = rows.at(-1)!.id;
  }
});
