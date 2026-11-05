CREATE TABLE `notes` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`body` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
