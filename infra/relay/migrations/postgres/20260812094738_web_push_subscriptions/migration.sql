CREATE TABLE "relay_web_push_subscriptions" (
	"user_id" varchar(255),
	"subscription_id" varchar(255),
	"label" text DEFAULT 'Web browser' NOT NULL,
	"endpoint" text NOT NULL,
	"expiration_time" varchar(64),
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"preferences_json" jsonb NOT NULL,
	"created_at" varchar(64) NOT NULL,
	"updated_at" varchar(64) NOT NULL,
	CONSTRAINT "relay_web_push_subscriptions_pkey" PRIMARY KEY("user_id","subscription_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_relay_web_push_subscriptions_endpoint" ON "relay_web_push_subscriptions" ("endpoint");--> statement-breakpoint
CREATE INDEX "idx_relay_web_push_subscriptions_user" ON "relay_web_push_subscriptions" ("user_id");