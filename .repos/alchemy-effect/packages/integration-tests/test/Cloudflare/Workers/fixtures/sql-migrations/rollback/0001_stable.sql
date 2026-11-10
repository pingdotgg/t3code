CREATE TABLE stable_values (
  id INTEGER PRIMARY KEY,
  value TEXT NOT NULL
);
--> statement-breakpoint
INSERT INTO stable_values (id, value) VALUES (1, 'committed');
