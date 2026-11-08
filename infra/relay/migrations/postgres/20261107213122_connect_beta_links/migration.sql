ALTER TABLE "relay_environment_links" ADD COLUMN "beta_enrollment_id" varchar(255);--> statement-breakpoint
ALTER TABLE "relay_environment_links" ADD COLUMN "beta_endpoint_key" varchar(16);--> statement-breakpoint
ALTER TABLE "relay_environment_links" ADD COLUMN "beta_connector_hash" varchar(64);--> statement-breakpoint
CREATE UNIQUE INDEX "idx_relay_environment_links_beta_key" ON "relay_environment_links" ("beta_endpoint_key") WHERE ("beta_endpoint_key" is not null);--> statement-breakpoint
CREATE UNIQUE INDEX "idx_relay_environment_links_beta_hash" ON "relay_environment_links" ("beta_connector_hash") WHERE ("beta_connector_hash" is not null);