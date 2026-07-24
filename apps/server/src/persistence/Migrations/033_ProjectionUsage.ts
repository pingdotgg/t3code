import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_usage_facts (
      fact_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      turn_id TEXT,
      project_id TEXT,
      provider TEXT NOT NULL,
      provider_instance_id TEXT,
      provider_session_id TEXT NOT NULL,
      model TEXT NOT NULL,
      model_raw TEXT NOT NULL,
      reasoning_effort TEXT,
      kind TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      cached_input_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_output_tokens INTEGER NOT NULL DEFAULT 0,
      cost_micro_usd INTEGER,
      stale INTEGER NOT NULL DEFAULT 0,
      observed_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_usage_facts_observed_at
    ON projection_usage_facts(observed_at)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_usage_facts_provider_model
    ON projection_usage_facts(provider, model)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_usage_facts_thread_id
    ON projection_usage_facts(thread_id)
  `;
});
