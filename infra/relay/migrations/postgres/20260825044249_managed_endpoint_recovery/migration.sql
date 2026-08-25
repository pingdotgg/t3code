ALTER TABLE "relay_managed_endpoint_allocations" ADD COLUMN "recovery_enabled_at" varchar(64);--> statement-breakpoint
ALTER TABLE "relay_managed_endpoint_allocations" ADD COLUMN "recovery_environment_public_key" text;--> statement-breakpoint
ALTER TABLE "relay_managed_endpoint_allocations" ADD COLUMN "generation" integer DEFAULT 0 NOT NULL;