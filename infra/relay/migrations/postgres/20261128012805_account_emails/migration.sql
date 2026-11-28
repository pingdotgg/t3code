CREATE TABLE "relay_account_emails" (
	"user_id" varchar(255) PRIMARY KEY,
	"encrypted_email" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "relay_account_deletions" ADD COLUMN "encrypted_notify_email" text;