CREATE TABLE "relay_webhook_deliveries" (
	"delivery_id" varchar(36) PRIMARY KEY,
	"inbox_id" varchar(64) NOT NULL,
	"received_at" varchar(64) NOT NULL,
	"headers" jsonb NOT NULL,
	"body" text NOT NULL,
	"last_attempted_at" varchar(64)
);
--> statement-breakpoint
CREATE TABLE "relay_webhook_inboxes" (
	"inbox_id" varchar(64) PRIMARY KEY,
	"user_id" varchar(191) NOT NULL,
	"environment_id" varchar(191) NOT NULL,
	"environment_public_key" text NOT NULL,
	"created_at" varchar(64) NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_relay_webhook_deliveries_inbox" ON "relay_webhook_deliveries" ("inbox_id","received_at");--> statement-breakpoint
CREATE INDEX "idx_relay_webhook_deliveries_received_at" ON "relay_webhook_deliveries" ("received_at");--> statement-breakpoint
CREATE INDEX "idx_relay_webhook_inboxes_environment" ON "relay_webhook_inboxes" ("environment_id");--> statement-breakpoint
ALTER TABLE "relay_webhook_deliveries" ADD CONSTRAINT "relay_webhook_deliveries_dL1d1foNn1er_fkey" FOREIGN KEY ("inbox_id") REFERENCES "relay_webhook_inboxes"("inbox_id") ON DELETE CASCADE;