ALTER TABLE "relay_live_activities" ADD COLUMN "last_delivered_locale" varchar(16);--> statement-breakpoint
ALTER TABLE "relay_mobile_devices" ADD COLUMN "locale" varchar(16);