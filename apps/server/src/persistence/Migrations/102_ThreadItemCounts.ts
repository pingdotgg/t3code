import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * One total per thread beside 085's per-run counts, so a shell read does not sum every run the
 * thread has had. It holds the items without a run or with an existing run, the rows the shell
 * read used to sum; the read still applies the run status rules. Triggers keep it exact.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE orchestration_v2_projection_thread_item_counts (
      thread_id TEXT PRIMARY KEY,
      item_count INTEGER NOT NULL
    ) WITHOUT ROWID
  `;
  yield* sql`
    INSERT INTO orchestration_v2_projection_thread_item_counts (thread_id, item_count)
    SELECT counts.thread_id, SUM(counts.item_count)
    FROM orchestration_v2_projection_turn_item_counts counts
    WHERE counts.run_key = ''
      OR EXISTS (SELECT 1 FROM orchestration_v2_projection_runs WHERE run_id = counts.run_key)
    GROUP BY counts.thread_id
  `;

  // The shell read subtracts only these runs. ProjectionStore.selectShellItemCounts must spell
  // the same predicate for SQLite to use this partial index.
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_runs_hidden_items_idx
    ON orchestration_v2_projection_runs(thread_id, status, run_id)
    WHERE status IN ('rolled_back', 'queued', 'cancelled')
  `;

  // 085's triggers upsert per-run counts, so an item write fires the insert or the update here.
  yield* sql`
    CREATE TRIGGER orchestration_v2_thread_item_counts_count_insert
    AFTER INSERT ON orchestration_v2_projection_turn_item_counts
    WHEN new.run_key = ''
      OR EXISTS (SELECT 1 FROM orchestration_v2_projection_runs WHERE run_id = new.run_key)
    BEGIN
      INSERT INTO orchestration_v2_projection_thread_item_counts (thread_id, item_count)
      VALUES (new.thread_id, new.item_count)
      ON CONFLICT (thread_id) DO UPDATE SET item_count = item_count + excluded.item_count;
    END
  `;
  yield* sql`
    CREATE TRIGGER orchestration_v2_thread_item_counts_count_update
    AFTER UPDATE ON orchestration_v2_projection_turn_item_counts
    BEGIN
      UPDATE orchestration_v2_projection_thread_item_counts
      SET item_count = item_count - old.item_count
      WHERE thread_id = old.thread_id
        AND (old.run_key = ''
          OR EXISTS (SELECT 1 FROM orchestration_v2_projection_runs WHERE run_id = old.run_key));
      INSERT INTO orchestration_v2_projection_thread_item_counts (thread_id, item_count)
      SELECT new.thread_id, new.item_count
      WHERE new.run_key = ''
        OR EXISTS (SELECT 1 FROM orchestration_v2_projection_runs WHERE run_id = new.run_key)
      ON CONFLICT (thread_id) DO UPDATE SET item_count = item_count + excluded.item_count;
      DELETE FROM orchestration_v2_projection_thread_item_counts
      WHERE thread_id = old.thread_id AND item_count <= 0;
    END
  `;
  yield* sql`
    CREATE TRIGGER orchestration_v2_thread_item_counts_count_delete
    AFTER DELETE ON orchestration_v2_projection_turn_item_counts
    WHEN old.run_key = ''
      OR EXISTS (SELECT 1 FROM orchestration_v2_projection_runs WHERE run_id = old.run_key)
    BEGIN
      UPDATE orchestration_v2_projection_thread_item_counts
      SET item_count = item_count - old.item_count
      WHERE thread_id = old.thread_id;
      DELETE FROM orchestration_v2_projection_thread_item_counts
      WHERE thread_id = old.thread_id AND item_count <= 0;
    END
  `;

  // Items can be written before their run; they count from when it exists.
  yield* sql`
    CREATE TRIGGER orchestration_v2_thread_item_counts_run_insert
    AFTER INSERT ON orchestration_v2_projection_runs
    BEGIN
      INSERT INTO orchestration_v2_projection_thread_item_counts (thread_id, item_count)
      SELECT thread_id, COUNT(*)
      FROM orchestration_v2_projection_turn_items
      WHERE run_id = new.run_id
      GROUP BY thread_id
      ON CONFLICT (thread_id) DO UPDATE SET item_count = item_count + excluded.item_count;
    END
  `;
  yield* sql`
    CREATE TRIGGER orchestration_v2_thread_item_counts_run_delete
    AFTER DELETE ON orchestration_v2_projection_runs
    BEGIN
      UPDATE orchestration_v2_projection_thread_item_counts
      SET item_count = item_count - (
        SELECT COUNT(*)
        FROM orchestration_v2_projection_turn_items item
        WHERE item.run_id = old.run_id
          AND item.thread_id = orchestration_v2_projection_thread_item_counts.thread_id
      )
      WHERE thread_id IN (
        SELECT thread_id FROM orchestration_v2_projection_turn_items WHERE run_id = old.run_id
      );
      DELETE FROM orchestration_v2_projection_thread_item_counts
      WHERE item_count <= 0 AND thread_id IN (
        SELECT thread_id FROM orchestration_v2_projection_turn_items WHERE run_id = old.run_id
      );
    END
  `;
});
