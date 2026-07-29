import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import ProjectionThreadMessageSearch from "./048_ProjectionThreadMessageSearch.ts";
import ExcludeHandoffContinuationsFromSearch from "./057_ExcludeHandoffContinuationsFromSearch.ts";

/**
 * Ledgers from a divergent branch recorded IDs above 48, so migration 048 was
 * skipped and those installs have no transcript index at all. Rebuild it here,
 * then re-apply migration 057 because 048's backfill indexes the workspace-handoff
 * continuations that 057 deliberately excludes.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const existingTable = yield* sql<{ readonly count: number }>`
    SELECT count(*) AS count
    FROM sqlite_master
    WHERE type = 'table'
      AND name = 'projection_thread_message_fts'
  `;

  if ((existingTable[0]?.count ?? 0) > 0) {
    return;
  }

  yield* ProjectionThreadMessageSearch;
  yield* ExcludeHandoffContinuationsFromSearch;
});
