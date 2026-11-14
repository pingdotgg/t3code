import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Shell reads count items per (thread, run) here instead of walking every turn item. Triggers
 * keep it exact for every writer, including projection rebuilds and dev-database pruning.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // run_key is '' for items without a run; NULLs never conflict in a primary key.
  yield* sql`
    CREATE TABLE orchestration_v2_projection_turn_item_counts (
      thread_id TEXT NOT NULL,
      run_key TEXT NOT NULL,
      item_count INTEGER NOT NULL,
      PRIMARY KEY (thread_id, run_key)
    ) WITHOUT ROWID
  `;
  yield* sql`
    INSERT INTO orchestration_v2_projection_turn_item_counts (thread_id, run_key, item_count)
    SELECT thread_id, COALESCE(run_id, ''), COUNT(*)
    FROM orchestration_v2_projection_turn_items
    GROUP BY thread_id, run_id
  `;
  // An upsert that hits an existing item fires only the update trigger.
  yield* sql`
    CREATE TRIGGER orchestration_v2_turn_item_counts_insert
    AFTER INSERT ON orchestration_v2_projection_turn_items
    BEGIN
      INSERT INTO orchestration_v2_projection_turn_item_counts (thread_id, run_key, item_count)
      VALUES (new.thread_id, COALESCE(new.run_id, ''), 1)
      ON CONFLICT (thread_id, run_key) DO UPDATE SET item_count = item_count + 1;
    END
  `;
  yield* sql`
    CREATE TRIGGER orchestration_v2_turn_item_counts_update
    AFTER UPDATE OF thread_id, run_id ON orchestration_v2_projection_turn_items
    WHEN old.thread_id IS NOT new.thread_id OR old.run_id IS NOT new.run_id
    BEGIN
      UPDATE orchestration_v2_projection_turn_item_counts SET item_count = item_count - 1
      WHERE thread_id = old.thread_id AND run_key = COALESCE(old.run_id, '');
      DELETE FROM orchestration_v2_projection_turn_item_counts
      WHERE thread_id = old.thread_id AND run_key = COALESCE(old.run_id, '') AND item_count <= 0;
      INSERT INTO orchestration_v2_projection_turn_item_counts (thread_id, run_key, item_count)
      VALUES (new.thread_id, COALESCE(new.run_id, ''), 1)
      ON CONFLICT (thread_id, run_key) DO UPDATE SET item_count = item_count + 1;
    END
  `;
  yield* sql`
    CREATE TRIGGER orchestration_v2_turn_item_counts_delete
    AFTER DELETE ON orchestration_v2_projection_turn_items
    BEGIN
      UPDATE orchestration_v2_projection_turn_item_counts SET item_count = item_count - 1
      WHERE thread_id = old.thread_id AND run_key = COALESCE(old.run_id, '');
      DELETE FROM orchestration_v2_projection_turn_item_counts
      WHERE thread_id = old.thread_id AND run_key = COALESCE(old.run_id, '') AND item_count <= 0;
    END
  `;
});
