import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// What people and clients look at of a workflow run, and how something outside reaches a sleeping
// one. The engine journals each run in tables of its own, which it creates when it first starts.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE workflow_runs (
      run_id TEXT PRIMARY KEY,
      workflow TEXT NOT NULL,
      version INTEGER NOT NULL,
      engine_tag TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      detail TEXT,
      result_json TEXT,
      pauses INTEGER NOT NULL DEFAULT 0,
      started_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      ended_at TEXT
    )
  `;
  yield* sql`CREATE INDEX workflow_runs_status ON workflow_runs (status, updated_at)`;
  yield* sql`
    CREATE TABLE workflow_steps (
      run_id TEXT NOT NULL,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      detail TEXT,
      thread_id TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      PRIMARY KEY (run_id, name)
    )
  `;
  yield* sql`
    CREATE TABLE workflow_waits (
      run_id TEXT NOT NULL,
      name TEXT NOT NULL,
      workflow TEXT NOT NULL,
      token TEXT NOT NULL,
      key TEXT,
      schema_json TEXT NOT NULL,
      request_json TEXT,
      deadline TEXT,
      opened_at TEXT NOT NULL,
      signalled_at TEXT,
      PRIMARY KEY (run_id, name)
    )
  `;
  yield* sql`CREATE INDEX workflow_waits_key ON workflow_waits (workflow, key)`;
  // A signal that arrived before its wait. `address` is `run:<id>:<wait>` or `key:<workflow>:<key>`.
  yield* sql`
    CREATE TABLE workflow_mail (
      signal_id TEXT PRIMARY KEY,
      address TEXT NOT NULL,
      value_json TEXT NOT NULL,
      expires_at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX workflow_mail_address ON workflow_mail (address)`;
  // How often a run reached a point it must not pass twice without a person or a rest.
  yield* sql`
    CREATE TABLE workflow_marks (
      run_id TEXT NOT NULL,
      name TEXT NOT NULL,
      count INTEGER NOT NULL,
      PRIMARY KEY (run_id, name)
    )
  `;
  // Ids of signals that woke a wait, so a sender's retry of one is not a second signal.
  yield* sql`
    CREATE TABLE workflow_signals (
      signal_id TEXT PRIMARY KEY,
      delivered_at TEXT NOT NULL
    )
  `;
});
