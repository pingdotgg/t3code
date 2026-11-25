CREATE TABLE "relay_account_deletions" (
	"user_id" varchar(255) PRIMARY KEY,
	"requested_at" varchar(64) NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL
);
