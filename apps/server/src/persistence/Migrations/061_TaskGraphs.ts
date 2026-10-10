import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // A graph is written whole on every change; its nodes live in graph_json.
  // Graphs are small (at most 48 nodes) and always read as a unit.
  yield* sql`
    CREATE TABLE IF NOT EXISTS task_graphs (
      graph_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      status TEXT NOT NULL,
      graph_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_task_graphs_thread
    ON task_graphs(thread_id, created_at)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_task_graphs_running
    ON task_graphs(status)
    WHERE status = 'running'
  `;

  // Peer machines this server may place nodes on. The session token for each
  // lives in the secret store, never in this table.
  yield* sql`
    CREATE TABLE IF NOT EXISTS task_graph_peers (
      environment_id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      http_base_url TEXT NOT NULL,
      weight INTEGER NOT NULL,
      added_at TEXT NOT NULL
    )
  `;
});
