import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Run lifecycle guarantees: liveness leases for non-terminal runs, and
 * storage-level backstop triggers that make "resurrection" (a terminal run
 * status flowing back to a non-terminal one) unrepresentable even for writes
 * that bypass the EventSink transition gate.
 *
 * Leases are deliberately not part of the event-sourced state: a lease is an
 * ephemeral claim that a live fiber currently owns the run, renewed while
 * that fiber is alive and meaningless after it dies. Projection rebuilds must
 * therefore never touch this table.
 *
 * The guard-mode row exists for projection rebuilds only: historical event
 * logs written before the transition gate can contain illegal sequences, and
 * a rebuild must replay what actually happened rather than fail on it.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE orchestration_v2_run_leases (
      run_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      owner TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX orchestration_v2_run_leases_thread_idx
    ON orchestration_v2_run_leases(thread_id, expires_at)
  `;

  yield* sql`
    CREATE TABLE orchestration_v2_projection_guard (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      mode TEXT NOT NULL CHECK (mode IN ('enforcing', 'replay'))
    )
  `;
  yield* sql`INSERT INTO orchestration_v2_projection_guard (id, mode) VALUES (1, 'enforcing')`;

  // Subagent rows carry no trigger: providers deliberately reopen settled
  // subagents (task resume / collab turn restart), so terminal is not
  // absorbing for them. Nodes exempt the same provider-owned kinds.
  const guards = [
    {
      trigger: "orchestration_v2_projection_runs_terminal_guard",
      table: "orchestration_v2_projection_runs",
      terminal: ["completed", "interrupted", "failed", "cancelled", "rolled_back"],
      entity: "run",
      extraCondition: "",
    },
    {
      trigger: "orchestration_v2_projection_run_attempts_terminal_guard",
      table: "orchestration_v2_projection_run_attempts",
      terminal: ["completed", "interrupted", "failed", "cancelled", "superseded"],
      entity: "run attempt",
      extraCondition: "",
    },
    {
      trigger: "orchestration_v2_projection_nodes_terminal_guard",
      table: "orchestration_v2_projection_nodes",
      terminal: ["completed", "interrupted", "failed", "cancelled", "rolled_back"],
      entity: "node",
      extraCondition: "AND OLD.kind NOT IN ('subagent', 'root_turn')",
    },
  ] as const;

  for (const guard of guards) {
    const terminalList = guard.terminal.map((status) => `'${status}'`).join(", ");
    yield* sql.unsafe(`
      CREATE TRIGGER ${guard.trigger}
      BEFORE UPDATE OF status ON ${guard.table}
      FOR EACH ROW
      WHEN OLD.status IN (${terminalList})
        AND NEW.status NOT IN (${terminalList})
        ${guard.extraCondition}
        AND (SELECT mode FROM orchestration_v2_projection_guard WHERE id = 1) = 'enforcing'
      BEGIN
        SELECT RAISE(ABORT, 'orchestration_v2: a terminal ${guard.entity} status cannot return to a non-terminal status');
      END
    `);
  }
});
