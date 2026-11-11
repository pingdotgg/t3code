CREATE TABLE scheduled_runs (
  invocation_id text PRIMARY KEY,
  processed_at timestamptz NOT NULL DEFAULT now()
);
