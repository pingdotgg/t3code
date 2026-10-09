CREATE TABLE gateway_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  upstream_origin TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
