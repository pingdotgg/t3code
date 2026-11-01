CREATE TABLE flat_values (
  id INTEGER PRIMARY KEY,
  value TEXT NOT NULL
);
--> statement-breakpoint
INSERT INTO flat_values (id, value) VALUES (1, 'first');
