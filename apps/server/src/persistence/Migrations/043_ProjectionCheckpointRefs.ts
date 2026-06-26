import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Per-root checkpoint refs for multi-repo projects (D2). A checkpoint is the
  // set of its per-root rows: one (repo_root, checkpoint_ref) pair per repo
  // captured at that turn. Single-root threads simply have one row. Keyed by
  // the same (thread_id, checkpoint_turn_count) identity used by checkpoints.
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_checkpoint_refs (
      thread_id TEXT NOT NULL,
      checkpoint_turn_count INTEGER NOT NULL,
      repo_root TEXT NOT NULL,
      checkpoint_ref TEXT NOT NULL,
      PRIMARY KEY (thread_id, checkpoint_turn_count, repo_root)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_checkpoint_refs_thread_turn
    ON projection_checkpoint_refs(thread_id, checkpoint_turn_count)
  `;
});
