import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE orchestration_v2_projection_shell_item_counts (
      thread_id TEXT NOT NULL,
      run_id TEXT,
      item_count INTEGER NOT NULL
    )
  `;
  yield* sql`
    CREATE UNIQUE INDEX orchestration_v2_shell_item_counts_run_idx
    ON orchestration_v2_projection_shell_item_counts(thread_id, run_id)
  `;
  // SQLite's ordinary unique indexes allow multiple NULLs.
  yield* sql`
    CREATE UNIQUE INDEX orchestration_v2_shell_item_counts_runless_idx
    ON orchestration_v2_projection_shell_item_counts(thread_id)
    WHERE run_id IS NULL
  `;
  yield* sql`
    INSERT INTO orchestration_v2_projection_shell_item_counts
    SELECT thread_id, run_id, COUNT(*)
    FROM orchestration_v2_projection_turn_items
    GROUP BY thread_id, run_id
  `;
  yield* sql`
    CREATE TRIGGER orchestration_v2_shell_item_counts_insert
    AFTER INSERT ON orchestration_v2_projection_turn_items
    BEGIN
      INSERT INTO orchestration_v2_projection_shell_item_counts
        (thread_id, run_id, item_count)
      VALUES (NEW.thread_id, NEW.run_id, 1)
      ON CONFLICT
      DO UPDATE SET item_count = item_count + 1;
    END
  `;
  yield* sql`
    CREATE TRIGGER orchestration_v2_shell_item_counts_delete
    AFTER DELETE ON orchestration_v2_projection_turn_items
    BEGIN
      UPDATE orchestration_v2_projection_shell_item_counts SET item_count = item_count - 1
      WHERE thread_id = OLD.thread_id AND run_id IS OLD.run_id;
      DELETE FROM orchestration_v2_projection_shell_item_counts
      WHERE thread_id = OLD.thread_id AND run_id IS OLD.run_id AND item_count = 0;
    END
  `;
  yield* sql`
    CREATE TRIGGER orchestration_v2_shell_item_counts_move
    AFTER UPDATE OF thread_id, run_id ON orchestration_v2_projection_turn_items
    WHEN OLD.thread_id IS NOT NEW.thread_id OR OLD.run_id IS NOT NEW.run_id
    BEGIN
      UPDATE orchestration_v2_projection_shell_item_counts SET item_count = item_count - 1
      WHERE thread_id = OLD.thread_id AND run_id IS OLD.run_id;
      DELETE FROM orchestration_v2_projection_shell_item_counts
      WHERE thread_id = OLD.thread_id AND run_id IS OLD.run_id AND item_count = 0;
      INSERT INTO orchestration_v2_projection_shell_item_counts
        (thread_id, run_id, item_count)
      VALUES (NEW.thread_id, NEW.run_id, 1)
      ON CONFLICT
      DO UPDATE SET item_count = item_count + 1;
    END
  `;
});
