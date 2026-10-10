CREATE TABLE posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL
);
--> statement-breakpoint
INSERT INTO posts (user_id, title) VALUES (1, 'pending migration');
