CREATE TABLE "relay_agent_activity_rows" (
	"environment_id" varchar(191),
	"environment_public_key" text,
	"thread_id" varchar(191),
	"state_json" jsonb NOT NULL,
	"updated_at" varchar(64) NOT NULL,
	"created_at" varchar(64) NOT NULL,
	CONSTRAINT "relay_agent_activity_rows_pkey" PRIMARY KEY("environment_id","environment_public_key","thread_id")
);
--> statement-breakpoint
CREATE TABLE "relay_delivery_attempts" (
	"id" varchar(36) PRIMARY KEY,
	"created_at" varchar(64) NOT NULL,
	"user_id" varchar(255),
	"environment_id" varchar(191),
	"thread_id" varchar(191),
	"device_id" varchar(255),
	"kind" varchar(64) NOT NULL,
	"source_job_id" varchar(64),
	"token_suffix" varchar(16),
	"apns_status" integer,
	"apns_reason" text,
	"apns_id" varchar(128),
	"transport_error" text
);
--> statement-breakpoint
CREATE TABLE "relay_dpop_proofs" (
	"thumbprint" varchar(128),
	"jti" varchar(255),
	"iat" integer NOT NULL,
	"expires_at" varchar(64) NOT NULL,
	"created_at" varchar(64) NOT NULL,
	CONSTRAINT "relay_dpop_proofs_pkey" PRIMARY KEY("thumbprint","jti")
);
--> statement-breakpoint
CREATE TABLE "relay_environment_credentials" (
	"credential_id" varchar(64) PRIMARY KEY,
	"environment_id" varchar(191) NOT NULL,
	"environment_public_key" text NOT NULL,
	"credential_hash" varchar(191) NOT NULL,
	"revoked_at" varchar(64),
	"created_at" varchar(64) NOT NULL,
	"updated_at" varchar(64) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relay_environment_links" (
	"user_id" varchar(191),
	"environment_id" varchar(191),
	"environment_label" text DEFAULT 'T3 Environment' NOT NULL,
	"environment_public_key" text NOT NULL,
	"endpoint_http_base_url" text NOT NULL,
	"endpoint_ws_base_url" text NOT NULL,
	"endpoint_provider_kind" varchar(32) NOT NULL,
	"notifications_enabled" boolean DEFAULT true NOT NULL,
	"live_activities_enabled" boolean DEFAULT true NOT NULL,
	"managed_tunnels_enabled" boolean DEFAULT false NOT NULL,
	"created_by_device_id" varchar(191),
	"revoked_at" varchar(64),
	"created_at" varchar(64) NOT NULL,
	"updated_at" varchar(64) NOT NULL,
	CONSTRAINT "relay_environment_links_pkey" PRIMARY KEY("user_id","environment_id")
);
--> statement-breakpoint
CREATE TABLE "relay_live_activities" (
	"user_id" varchar(255),
	"device_id" varchar(255),
	"activity_push_token" text,
	"remote_start_queued_at" varchar(64),
	"remote_started_at" varchar(64),
	"ended_at" varchar(64),
	"last_aggregate_json" jsonb,
	"last_live_activity_delivery_at" varchar(64),
	"created_at" varchar(64) NOT NULL,
	"updated_at" varchar(64) NOT NULL,
	CONSTRAINT "relay_live_activities_pkey" PRIMARY KEY("user_id","device_id")
);
--> statement-breakpoint
CREATE TABLE "relay_mobile_devices" (
	"user_id" varchar(255),
	"device_id" varchar(255),
	"platform" varchar(16) NOT NULL,
	"ios_major_version" integer NOT NULL,
	"app_version" varchar(64),
	"push_token" text,
	"push_to_start_token" text,
	"preferences_json" jsonb NOT NULL,
	"created_at" varchar(64) NOT NULL,
	"updated_at" varchar(64) NOT NULL,
	CONSTRAINT "relay_mobile_devices_pkey" PRIMARY KEY("user_id","device_id")
);
--> statement-breakpoint
CREATE INDEX "idx_relay_agent_activity_rows_updated" ON "relay_agent_activity_rows" ("updated_at");--> statement-breakpoint
CREATE INDEX "idx_relay_delivery_attempts_environment" ON "relay_delivery_attempts" ("environment_id","thread_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_relay_delivery_attempts_source_job" ON "relay_delivery_attempts" ("source_job_id");--> statement-breakpoint
CREATE INDEX "idx_relay_dpop_proofs_expires_at" ON "relay_dpop_proofs" ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_relay_environment_credentials_hash" ON "relay_environment_credentials" ("credential_hash");--> statement-breakpoint
CREATE INDEX "idx_relay_environment_credentials_environment" ON "relay_environment_credentials" ("environment_id","revoked_at");--> statement-breakpoint
CREATE INDEX "idx_relay_environment_credentials_environment_key" ON "relay_environment_credentials" ("environment_id","environment_public_key","revoked_at");--> statement-breakpoint
CREATE INDEX "idx_relay_environment_links_environment" ON "relay_environment_links" ("environment_id","revoked_at");--> statement-breakpoint
CREATE INDEX "idx_relay_live_activities_user" ON "relay_live_activities" ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_relay_live_activities_activity_push_token" ON "relay_live_activities" ("activity_push_token");--> statement-breakpoint
CREATE INDEX "idx_relay_mobile_devices_user" ON "relay_mobile_devices" ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_relay_mobile_devices_push_token" ON "relay_mobile_devices" ("push_token");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_relay_mobile_devices_push_to_start_token" ON "relay_mobile_devices" ("push_to_start_token");