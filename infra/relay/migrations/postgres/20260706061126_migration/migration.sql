ALTER TABLE "relay_mobile_devices" ADD COLUMN "bundle_id" varchar(255);
--> statement-breakpoint
ALTER TABLE "relay_mobile_devices" ADD COLUMN "aps_environment" varchar(16);
