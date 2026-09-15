import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE codex_child_usage (
      thread_id TEXT NOT NULL,
      instance_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      usage_json TEXT NOT NULL DEFAULT '{"totalTokens":0}',
      tool_uses INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (thread_id, instance_id, task_id)
    )
  `;
  yield* sql`
    CREATE TABLE codex_child_tool_calls (
      thread_id TEXT NOT NULL,
      instance_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      PRIMARY KEY (thread_id, instance_id, task_id, turn_id, item_id),
      FOREIGN KEY (thread_id, instance_id, task_id)
        REFERENCES codex_child_usage (thread_id, instance_id, task_id) ON DELETE CASCADE
    )
  `;
});
