import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Repair migration for databases whose 045 was silently skipped.
//
// effect's Migrator only runs migrations with an ID above the highest recorded
// one and never compares names, so any line that occupied ID 45 first (a fork,
// a nightly, a renumbered branch) marks 045_ProjectionProjectsAutoPull as done
// without running it. Every project query then fails with
// "no such column: auto_pull" and the backend crash-loops at startup (#8896).
//
// Idempotent: adds the column only when absent, so it is a no-op on healthy
// databases. Safe to keep forever.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_projects)
  `;

  if (!columns.some((column) => column.name === "auto_pull")) {
    yield* sql`
      ALTER TABLE projection_projects
      ADD COLUMN auto_pull INTEGER NOT NULL DEFAULT 0
    `;
  }
});
