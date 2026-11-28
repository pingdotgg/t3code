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
      ended_at TEXT,
      -- What a run was started with, for the cleanup of a cancelled run whose body is gone.
      input_json TEXT,
      -- The run that invoked this one and the wait it sits in, so it hears how this one ended.
      parent_run_id TEXT,
      parent_wait TEXT,
      -- A run its agent gave up on waits for a person: resuming starts the agent's whole job again.
      held INTEGER NOT NULL DEFAULT 0,
      -- When an ended run's engine journal was deleted; the run's own rows stay.
      engine_pruned_at TEXT
    )
  `;
  yield* sql`CREATE INDEX workflow_runs_status ON workflow_runs (status, updated_at)`;
  yield* sql`CREATE INDEX workflow_runs_parent ON workflow_runs (parent_run_id)`;
  // A key names one run of a workflow whatever its version: the row that takes it is that run.
  yield* sql`CREATE UNIQUE INDEX workflow_runs_key ON workflow_runs (workflow, idempotency_key)`;
  yield* sql`
    CREATE INDEX workflow_runs_unpruned ON workflow_runs (ended_at)
    WHERE ended_at IS NOT NULL AND engine_pruned_at IS NULL
  `;
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
      -- The linked environment an agent step's thread is in; null for this one.
      environment_id TEXT,
      -- What a step produced, for a person reading the run. The engine keeps its own copy to replay.
      result_json TEXT,
      -- An agent that returns data also says something at the end; a person reads that first.
      said TEXT,
      -- The agent step's own turn, so cancelling its run stops that turn and not the whole thread.
      turn_id TEXT,
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
      -- What the engine itself looks at to end this wait, such as a pull request's checks.
      watch_json TEXT,
      -- What a wait was woken with, kept until the run is past it, so a wake lost to a crash is redone.
      woke_json TEXT,
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
  // Ids of signals that woke a wait, so a sender's retry of one is not a second signal. Kept at
  // least as long as any kept copy of the signal, which would otherwise wake a second wait.
  yield* sql`
    CREATE TABLE workflow_signals (
      signal_id TEXT PRIMARY KEY,
      kept_until TEXT NOT NULL
    )
  `;
  // When each schedule trigger is next due.
  yield* sql`
    CREATE TABLE workflow_triggers (
      trigger_id TEXT PRIMARY KEY,
      next_at TEXT NOT NULL
    )
  `;
  // The secret half of each workflow hook's URL.
  yield* sql`
    CREATE TABLE workflow_hooks (
      hook_id TEXT PRIMARY KEY,
      token TEXT NOT NULL
    )
  `;
  // What workflows keep between runs: a cursor, a switch, a queue.
  yield* sql`
    CREATE TABLE workflow_store (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  // What a run touched, once per thing: a later touch updates the row and adds its step.
  yield* sql`
    CREATE TABLE workflow_run_references (
      run_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      key TEXT NOT NULL,
      address_json TEXT NOT NULL,
      title TEXT NOT NULL,
      url TEXT,
      state TEXT,
      steps_json TEXT NOT NULL,
      origin TEXT NOT NULL,
      noted_at TEXT NOT NULL,
      PRIMARY KEY (run_id, kind, key)
    )
  `;
});
