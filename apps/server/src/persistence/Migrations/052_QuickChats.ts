import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // SQLite cannot drop NOT NULL in place. Replace only the project column,
  // retaining thread rows and every unrelated column and index.
  yield* sql`DROP INDEX idx_projection_threads_project_id`;
  yield* sql`DROP INDEX idx_projection_threads_project_archived_at`;
  yield* sql`DROP INDEX idx_projection_threads_project_deleted_created`;
  yield* sql`DROP INDEX idx_projection_threads_shell_active`;
  yield* sql`DROP INDEX idx_projection_threads_shell_archived`;
  yield* sql`ALTER TABLE projection_threads ADD COLUMN nullable_project_id TEXT`;
  yield* sql`UPDATE projection_threads SET nullable_project_id = project_id`;
  yield* sql`ALTER TABLE projection_threads DROP COLUMN project_id`;
  yield* sql`ALTER TABLE projection_threads RENAME COLUMN nullable_project_id TO project_id`;
  yield* sql`CREATE INDEX idx_projection_threads_project_id ON projection_threads(project_id)`;
  yield* sql`CREATE INDEX idx_projection_threads_project_archived_at ON projection_threads(project_id, archived_at)`;
  yield* sql`CREATE INDEX idx_projection_threads_project_deleted_created ON projection_threads(project_id, deleted_at, created_at)`;
  yield* sql`CREATE INDEX idx_projection_threads_shell_active ON projection_threads(deleted_at, archived_at, project_id, created_at, thread_id)`;
  yield* sql`CREATE INDEX idx_projection_threads_shell_archived ON projection_threads(deleted_at, archived_at, project_id, thread_id)`;
});
