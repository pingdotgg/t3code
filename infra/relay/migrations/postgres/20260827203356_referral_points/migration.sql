CREATE TABLE "relay_referral_accounts" (
	"user_id" varchar(191) PRIMARY KEY,
	"referral_code" varchar(16) NOT NULL,
	"referrer_user_id" varchar(191),
	"referred_at" varchar(64),
	"qualified_at" varchar(64),
	"created_at" varchar(64) NOT NULL,
	"updated_at" varchar(64) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relay_referral_point_entries" (
	"id" varchar(36) PRIMARY KEY,
	"user_id" varchar(191) NOT NULL,
	"points" integer NOT NULL,
	"reason" varchar(32) NOT NULL,
	"referred_user_id" varchar(191) NOT NULL,
	"qualifying_environment_id" varchar(191) NOT NULL,
	"created_at" varchar(64) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_relay_referral_accounts_code" ON "relay_referral_accounts" ("referral_code");--> statement-breakpoint
CREATE INDEX "idx_relay_referral_accounts_referrer" ON "relay_referral_accounts" ("referrer_user_id","qualified_at");--> statement-breakpoint
CREATE INDEX "idx_relay_referral_point_entries_user" ON "relay_referral_point_entries" ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_relay_referral_point_entries_award" ON "relay_referral_point_entries" ("user_id","reason","referred_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_relay_referral_point_entries_environment_award" ON "relay_referral_point_entries" ("reason","qualifying_environment_id");