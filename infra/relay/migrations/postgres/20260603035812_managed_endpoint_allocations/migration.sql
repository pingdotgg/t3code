CREATE TABLE "relay_managed_endpoint_allocations" (
	"user_id" varchar(191),
	"environment_id" varchar(191),
	"hostname" text NOT NULL,
	"tunnel_id" varchar(191),
	"tunnel_name" text NOT NULL,
	"dns_record_id" varchar(191),
	"ready_at" varchar(64),
	"created_at" varchar(64) NOT NULL,
	"updated_at" varchar(64) NOT NULL,
	CONSTRAINT "relay_managed_endpoint_allocations_pkey" PRIMARY KEY("user_id","environment_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_relay_managed_endpoint_allocations_hostname" ON "relay_managed_endpoint_allocations" ("hostname");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_relay_managed_endpoint_allocations_tunnel_name" ON "relay_managed_endpoint_allocations" ("tunnel_name");