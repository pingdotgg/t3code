import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE skill_variant_rules (
      rule_id TEXT PRIMARY KEY,
      skill_name TEXT NOT NULL,
      driver TEXT,
      model TEXT,
      mode TEXT NOT NULL,
      body TEXT,
      enabled INTEGER NOT NULL,
      forked_from_rule_id TEXT,
      revision INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    )
  `;
  yield* sql`
    CREATE UNIQUE INDEX skill_variant_rules_target_idx
    ON skill_variant_rules(skill_name, IFNULL(driver, ''), IFNULL(model, ''))
    WHERE deleted_at IS NULL
  `;

  yield* sql`
    CREATE TABLE skill_variant_revisions (
      rule_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      action TEXT NOT NULL,
      mode TEXT NOT NULL,
      body TEXT,
      enabled INTEGER NOT NULL,
      deleted INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (rule_id, revision)
    )
  `;

  yield* sql`
    CREATE TABLE skill_turns (
      run_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      instance_id TEXT NOT NULL,
      driver TEXT NOT NULL,
      model TEXT NOT NULL,
      delivery TEXT NOT NULL,
      resolution_json TEXT NOT NULL,
      available_json TEXT NOT NULL,
      eval_trial_id TEXT,
      created_at TEXT NOT NULL,
      outcome_json TEXT,
      finalized_at TEXT
    )
  `;
  yield* sql`
    CREATE INDEX skill_turns_thread_idx ON skill_turns(thread_id, created_at)
  `;
  yield* sql`
    CREATE INDEX skill_turns_model_idx ON skill_turns(driver, model, created_at)
  `;

  yield* sql`
    CREATE TABLE skill_turn_evidence (
      run_id TEXT NOT NULL,
      skill_name TEXT NOT NULL,
      kind TEXT NOT NULL,
      source TEXT NOT NULL,
      turn_item_id TEXT,
      observed_at TEXT NOT NULL,
      PRIMARY KEY (run_id, skill_name, kind, source)
    )
  `;

  yield* sql`
    CREATE TABLE skill_activated_provider_threads (
      provider_thread_id TEXT PRIMARY KEY,
      first_activated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE skill_eval_tasks (
      task_id TEXT PRIMARY KEY,
      skill_name TEXT NOT NULL,
      project_id TEXT NOT NULL,
      prompt_type TEXT NOT NULL,
      prompt TEXT NOT NULL,
      rubric TEXT NOT NULL,
      expectation TEXT NOT NULL DEFAULT 'either',
      base_ref TEXT,
      source_run_id TEXT,
      created_at TEXT NOT NULL,
      archived_at TEXT
    )
  `;
  yield* sql`
    CREATE INDEX skill_eval_tasks_skill_idx ON skill_eval_tasks(skill_name, archived_at)
  `;

  yield* sql`
    CREATE TABLE skill_eval_runs (
      eval_run_id TEXT PRIMARY KEY,
      skill_name TEXT NOT NULL,
      config_json TEXT NOT NULL,
      status TEXT NOT NULL,
      error TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT
    )
  `;
  yield* sql`
    CREATE INDEX skill_eval_runs_skill_idx ON skill_eval_runs(skill_name, created_at)
  `;

  yield* sql`
    CREATE TABLE skill_eval_trials (
      trial_id TEXT PRIMARY KEY,
      eval_run_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      arm_id TEXT NOT NULL,
      repeat_index INTEGER NOT NULL,
      thread_id TEXT,
      run_id TEXT,
      status TEXT NOT NULL,
      error TEXT,
      created_at TEXT NOT NULL,
      completed_at TEXT
    )
  `;
  yield* sql`
    CREATE UNIQUE INDEX skill_eval_trials_cell_idx
    ON skill_eval_trials(eval_run_id, task_id, arm_id, repeat_index)
  `;
  yield* sql`
    CREATE INDEX skill_eval_trials_thread_idx ON skill_eval_trials(thread_id)
  `;

  yield* sql`
    CREATE TABLE skill_eval_judgments (
      judgment_id TEXT PRIMARY KEY,
      eval_run_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      repeat_index INTEGER NOT NULL,
      treatment_arm_id TEXT NOT NULL,
      control_arm_id TEXT NOT NULL,
      order_label TEXT NOT NULL,
      sample_index INTEGER NOT NULL,
      preferred TEXT NOT NULL,
      treatment_score REAL,
      control_score REAL,
      rationale TEXT NOT NULL,
      judge_instance_id TEXT NOT NULL,
      judge_model TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE UNIQUE INDEX skill_eval_judgments_cell_idx
    ON skill_eval_judgments(
      eval_run_id,
      task_id,
      repeat_index,
      treatment_arm_id,
      control_arm_id,
      order_label,
      sample_index
    )
  `;
});
