import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_turns)
  `;

  if (!columns.some((column) => column.name === "source_proposed_plan_kind")) {
    yield* sql`
      ALTER TABLE projection_turns
      ADD COLUMN source_proposed_plan_kind TEXT
    `;
  }

  // Source-plan references created before review threads were introduced
  // always meant implementation, so retain their existing lifecycle meaning.
  yield* sql`
    UPDATE projection_turns
    SET source_proposed_plan_kind = 'implementation'
    WHERE source_proposed_plan_thread_id IS NOT NULL
      AND source_proposed_plan_id IS NOT NULL
      AND source_proposed_plan_kind IS NULL
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_turns_source_proposed_plan_kind
    ON projection_turns(
      source_proposed_plan_thread_id,
      source_proposed_plan_id,
      source_proposed_plan_kind,
      requested_at DESC
    )
  `;
});
