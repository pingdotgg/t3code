CREATE TABLE uploads (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL,
  object_key text NOT NULL UNIQUE,
  filename text NOT NULL,
  content_type text NOT NULL,
  expected_bytes bigint NOT NULL CHECK (expected_bytes BETWEEN 1 AND 10485760),
  actual_bytes bigint,
  status text NOT NULL DEFAULT 'awaiting_upload'
    CHECK (status IN ('awaiting_upload', 'ready', 'rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);
CREATE INDEX uploads_owner_created ON uploads (owner_id, created_at DESC);
CREATE TABLE upload_events (
  invocation_id text PRIMARY KEY,
  object_key text NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now()
);
