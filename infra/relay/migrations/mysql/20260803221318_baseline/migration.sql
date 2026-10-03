CREATE TABLE `relay_agent_activity_rows` (
	`environment_id` varchar(191) NOT NULL,
	`environment_public_key` varchar(255) NOT NULL,
	`thread_id` varchar(191) NOT NULL,
	`state_json` json NOT NULL,
	`updated_at` varchar(64) NOT NULL,
	`created_at` varchar(64) NOT NULL,
	CONSTRAINT PRIMARY KEY(`environment_id`,`environment_public_key`,`thread_id`)
);
--> statement-breakpoint
CREATE TABLE `relay_delivery_attempts` (
	`id` varchar(36) PRIMARY KEY,
	`created_at` varchar(64) NOT NULL,
	`user_id` varchar(255),
	`environment_id` varchar(191),
	`thread_id` varchar(191),
	`device_id` varchar(255),
	`kind` varchar(64) NOT NULL,
	`source_job_id` varchar(64),
	`token_suffix` varchar(16),
	`apns_status` int,
	`apns_reason` text,
	`apns_id` varchar(128),
	`transport_error` text,
	CONSTRAINT `idx_relay_delivery_attempts_source_job` UNIQUE INDEX(`source_job_id`)
);
--> statement-breakpoint
CREATE TABLE `relay_dpop_proofs` (
	`thumbprint` varchar(128) NOT NULL,
	`jti` varchar(255) NOT NULL,
	`iat` int NOT NULL,
	`expires_at` varchar(64) NOT NULL,
	`created_at` varchar(64) NOT NULL,
	CONSTRAINT PRIMARY KEY(`thumbprint`,`jti`)
);
--> statement-breakpoint
CREATE TABLE `relay_environment_credentials` (
	`credential_id` varchar(64) PRIMARY KEY,
	`environment_id` varchar(191) NOT NULL,
	`environment_public_key` varchar(255) NOT NULL,
	`credential_hash` varchar(191) NOT NULL,
	`revoked_at` varchar(64),
	`created_at` varchar(64) NOT NULL,
	`updated_at` varchar(64) NOT NULL,
	CONSTRAINT `idx_relay_environment_credentials_hash` UNIQUE INDEX(`credential_hash`)
);
--> statement-breakpoint
CREATE TABLE `relay_environment_links` (
	`user_id` varchar(191) NOT NULL,
	`environment_id` varchar(191) NOT NULL,
	`environment_label` text NOT NULL DEFAULT ('T3 Environment'),
	`environment_public_key` varchar(255) NOT NULL,
	`endpoint_http_base_url` text NOT NULL,
	`endpoint_ws_base_url` text NOT NULL,
	`endpoint_provider_kind` varchar(32) NOT NULL,
	`notifications_enabled` boolean NOT NULL DEFAULT true,
	`live_activities_enabled` boolean NOT NULL DEFAULT true,
	`managed_tunnels_enabled` boolean NOT NULL DEFAULT false,
	`created_by_device_id` varchar(191),
	`revoked_at` varchar(64),
	`created_at` varchar(64) NOT NULL,
	`updated_at` varchar(64) NOT NULL,
	CONSTRAINT PRIMARY KEY(`user_id`,`environment_id`)
);
--> statement-breakpoint
CREATE TABLE `relay_live_activities` (
	`user_id` varchar(255) NOT NULL,
	`device_id` varchar(255) NOT NULL,
	`activity_push_token` varchar(255),
	`remote_start_queued_at` varchar(64),
	`remote_started_at` varchar(64),
	`ended_at` varchar(64),
	`last_aggregate_json` json,
	`last_live_activity_delivery_at` varchar(64),
	`created_at` varchar(64) NOT NULL,
	`updated_at` varchar(64) NOT NULL,
	CONSTRAINT PRIMARY KEY(`user_id`,`device_id`),
	CONSTRAINT `idx_relay_live_activities_activity_push_token` UNIQUE INDEX(`activity_push_token`)
);
--> statement-breakpoint
CREATE TABLE `relay_managed_endpoint_allocations` (
	`user_id` varchar(191) NOT NULL,
	`environment_id` varchar(191) NOT NULL,
	`hostname` varchar(255) NOT NULL,
	`tunnel_id` varchar(191),
	`tunnel_name` varchar(255) NOT NULL,
	`dns_record_id` varchar(191),
	`ready_at` varchar(64),
	`created_at` varchar(64) NOT NULL,
	`updated_at` varchar(64) NOT NULL,
	CONSTRAINT PRIMARY KEY(`user_id`,`environment_id`),
	CONSTRAINT `idx_relay_managed_endpoint_allocations_hostname` UNIQUE INDEX(`hostname`),
	CONSTRAINT `idx_relay_managed_endpoint_allocations_tunnel_name` UNIQUE INDEX(`tunnel_name`)
);
--> statement-breakpoint
CREATE TABLE `relay_managed_tunnel_limits` (
	`user_id` varchar(191) PRIMARY KEY,
	`max_tunnels` int NOT NULL,
	`created_at` varchar(64) NOT NULL,
	`updated_at` varchar(64) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `relay_mobile_devices` (
	`user_id` varchar(255) NOT NULL,
	`device_id` varchar(255) NOT NULL,
	`label` text NOT NULL DEFAULT ('iOS device'),
	`platform` varchar(16) NOT NULL,
	`ios_major_version` int NOT NULL,
	`app_version` varchar(64),
	`bundle_id` varchar(255),
	`aps_environment` varchar(16),
	`push_token` varchar(255),
	`push_to_start_token` varchar(255),
	`preferences_json` json NOT NULL,
	`created_at` varchar(64) NOT NULL,
	`updated_at` varchar(64) NOT NULL,
	CONSTRAINT PRIMARY KEY(`user_id`,`device_id`),
	CONSTRAINT `idx_relay_mobile_devices_push_token` UNIQUE INDEX(`push_token`),
	CONSTRAINT `idx_relay_mobile_devices_push_to_start_token` UNIQUE INDEX(`push_to_start_token`)
);
--> statement-breakpoint
CREATE INDEX `idx_relay_agent_activity_rows_updated` ON `relay_agent_activity_rows` (`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_relay_delivery_attempts_environment` ON `relay_delivery_attempts` (`environment_id`,`thread_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_relay_dpop_proofs_expires_at` ON `relay_dpop_proofs` (`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_relay_environment_credentials_environment` ON `relay_environment_credentials` (`environment_id`,`revoked_at`);--> statement-breakpoint
CREATE INDEX `idx_relay_environment_credentials_environment_key` ON `relay_environment_credentials` (`environment_id`,`environment_public_key`,`revoked_at`);--> statement-breakpoint
CREATE INDEX `idx_relay_environment_links_environment` ON `relay_environment_links` (`environment_id`,`revoked_at`);