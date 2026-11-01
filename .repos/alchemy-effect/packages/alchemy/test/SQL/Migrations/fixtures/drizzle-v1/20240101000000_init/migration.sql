CREATE TABLE users (
	id integer PRIMARY KEY NOT NULL,
	name text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX users_name_unique ON users (name);
