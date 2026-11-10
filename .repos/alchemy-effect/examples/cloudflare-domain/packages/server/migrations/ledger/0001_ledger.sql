CREATE TABLE ledger (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  amount INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX ledger_account ON ledger (account_id, at);
