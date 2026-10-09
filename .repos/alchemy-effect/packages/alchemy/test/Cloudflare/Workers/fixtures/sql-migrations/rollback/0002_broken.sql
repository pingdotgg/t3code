INSERT INTO stable_values (id, value) VALUES (2, 'must roll back');
--> statement-breakpoint
CREATE TABLE must_roll_back (id INTEGER PRIMARY KEY);
--> statement-breakpoint
INSERT INTO missing_table (id) VALUES (1);
