/**
 * Schema for `cz.sqlite`, the database of fork-only features (decisions, the
 * reset queue, host load history). It is its own file so these migrations never share numbers
 * with upstream's `statev2.sqlite` migrations (this fork merges upstream
 * weekly).
 *
 * @module ForkMigrations
 */
import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

const decisionItems = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // The item and answer are schema-encoded JSON documents; the other columns
  // exist for filtering and ordering.
  yield* sql`
    CREATE TABLE IF NOT EXISTS decision_items (
      id TEXT PRIMARY KEY,
      project TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      answered_at INTEGER,
      expires_at INTEGER,
      item_json TEXT NOT NULL,
      answer_json TEXT
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_decision_items_status ON decision_items(status, created_at)`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_decision_items_project ON decision_items(project, created_at)`;
});

/**
 * Runs queued for a provider's next quota reset (ported from nightshift). A
 * decision's follow-up (resume or approved pitch) is one run at most.
 */
const queuedRuns = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS queued_runs (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      due_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      decision_id TEXT,
      run_json TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_queued_runs_due ON queued_runs(status, due_at)`;
  yield* sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_queued_runs_decision ON queued_runs(decision_id) WHERE decision_id IS NOT NULL`;
});

/** The owner's own one-line description per decision project. */
const projectBlurbs = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS project_blurbs (
      project TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `;
});

/** One CPU/RAM/GPU reading per minute (HostLoadHistory), pruned past its retention. */
const hostLoadSamples = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS host_load_samples (
      sampled_at INTEGER PRIMARY KEY,
      cpu REAL NOT NULL,
      memory_used INTEGER NOT NULL,
      gpu REAL
    )
  `;
});

/** When the owner last looked at the brief, and the brief last written (MorningBriefService). */
const briefState = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS brief_state (
      name TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `;
});

const loader = Migrator.fromRecord({
  "1_DecisionItems": decisionItems,
  "2_QueuedRuns": queuedRuns,
  "3_ProjectBlurbs": projectBlurbs,
  "4_HostLoadSamples": hostLoadSamples,
  "5_BriefState": briefState,
});

/** Brings `cz.sqlite` up to date. Needs the fork SqlClient. */
export const runForkMigrations = Migrator.make({})({ loader });
