ALTER TABLE "relay_mobile_devices" ADD COLUMN "widget_access_token_hash" text;--> statement-breakpoint
ALTER TABLE "relay_mobile_devices" ADD COLUMN "widget_push_token" text;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_relay_mobile_devices_widget_access_token" ON "relay_mobile_devices" ("widget_access_token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_relay_mobile_devices_widget_push_token" ON "relay_mobile_devices" ("widget_push_token");