import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Tracks thread handoffs: one row per hop, on both the environment that sends
 * a thread and the one that receives it, keyed by the handoff id both sides
 * share.
 *
 * `applied_head_sha`, `stash_ref` and `pre_tag` record what the receiving
 * repository looked like before the bundle was applied, so rolling a partial
 * apply back is a lookup rather than a reconstruction. `previous_handoff_id`
 * chains hops together, which is what makes a return trip an ordinary hop
 * toward an environment already in the lineage.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE orchestration_v2_thread_handoffs (
      handoff_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      peer_environment_id TEXT NOT NULL,
      peer_thread_id TEXT,
      previous_handoff_id TEXT,
      hop_count INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL,
      manifest_json TEXT NOT NULL,
      applied_head_sha TEXT,
      stash_ref TEXT,
      pre_tag TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX orchestration_v2_thread_handoffs_thread_idx
    ON orchestration_v2_thread_handoffs(thread_id, created_at)
  `;

  /**
   * Startup recovery scans for hops left mid-apply, and the destination side
   * of an unfinished hop is the only place a repository can have been touched.
   */
  yield* sql`
    CREATE INDEX orchestration_v2_thread_handoffs_state_idx
    ON orchestration_v2_thread_handoffs(state, updated_at)
  `;
});
