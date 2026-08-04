import type {
  RelayAgentActivityAggregateState,
  RelayAgentActivityState,
  RelayAgentAwarenessPreferences,
} from "@t3tools/contracts/relay";
import {
  boolean,
  index,
  int,
  json,
  mysqlTable,
  primaryKey,
  text,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";

// InnoDB cannot index TEXT columns without a prefix length, so every column
// that participates in an index or primary key is a bounded VARCHAR here
// (push/activity tokens, hostnames, tunnel names, environment public keys).

export const relayMobileDevices = mysqlTable(
  "relay_mobile_devices",
  {
    userId: varchar("user_id", { length: 255 }).notNull(),
    deviceId: varchar("device_id", { length: 255 }).notNull(),
    label: text("label").notNull().default("iOS device"),
    platform: varchar("platform", { length: 16 }).notNull().$type<"ios">(),
    iosMajorVersion: int("ios_major_version").notNull(),
    appVersion: varchar("app_version", { length: 64 }),
    bundleId: varchar("bundle_id", { length: 255 }),
    apsEnvironment: varchar("aps_environment", { length: 16 }).$type<"sandbox" | "production">(),
    pushToken: varchar("push_token", { length: 255 }),
    pushToStartToken: varchar("push_to_start_token", { length: 255 }),
    preferencesJson: json("preferences_json").notNull().$type<RelayAgentAwarenessPreferences>(),
    createdAt: varchar("created_at", { length: 64 }).notNull(),
    updatedAt: varchar("updated_at", { length: 64 }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.deviceId] }),
    uniqueIndex("idx_relay_mobile_devices_push_token").on(table.pushToken),
    uniqueIndex("idx_relay_mobile_devices_push_to_start_token").on(table.pushToStartToken),
  ],
);

export const relayLiveActivities = mysqlTable(
  "relay_live_activities",
  {
    userId: varchar("user_id", { length: 255 }).notNull(),
    deviceId: varchar("device_id", { length: 255 }).notNull(),
    activityPushToken: varchar("activity_push_token", { length: 255 }),
    remoteStartQueuedAt: varchar("remote_start_queued_at", { length: 64 }),
    remoteStartedAt: varchar("remote_started_at", { length: 64 }),
    endedAt: varchar("ended_at", { length: 64 }),
    lastAggregateJson: json("last_aggregate_json").$type<RelayAgentActivityAggregateState>(),
    lastLiveActivityDeliveryAt: varchar("last_live_activity_delivery_at", { length: 64 }),
    createdAt: varchar("created_at", { length: 64 }).notNull(),
    updatedAt: varchar("updated_at", { length: 64 }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.deviceId] }),
    uniqueIndex("idx_relay_live_activities_activity_push_token").on(table.activityPushToken),
  ],
);

export const relayEnvironmentLinks = mysqlTable(
  "relay_environment_links",
  {
    userId: varchar("user_id", { length: 191 }).notNull(),
    environmentId: varchar("environment_id", { length: 191 }).notNull(),
    environmentLabel: text("environment_label").notNull().default("T3 Environment"),
    environmentPublicKey: varchar("environment_public_key", { length: 255 }).notNull(),
    endpointHttpBaseUrl: text("endpoint_http_base_url").notNull(),
    endpointWsBaseUrl: text("endpoint_ws_base_url").notNull(),
    endpointProviderKind: varchar("endpoint_provider_kind", { length: 32 }).notNull(),
    notificationsEnabled: boolean("notifications_enabled").notNull().default(true),
    liveActivitiesEnabled: boolean("live_activities_enabled").notNull().default(true),
    managedTunnelsEnabled: boolean("managed_tunnels_enabled").notNull().default(false),
    createdByDeviceId: varchar("created_by_device_id", { length: 191 }),
    revokedAt: varchar("revoked_at", { length: 64 }),
    createdAt: varchar("created_at", { length: 64 }).notNull(),
    updatedAt: varchar("updated_at", { length: 64 }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.environmentId] }),
    index("idx_relay_environment_links_environment").on(table.environmentId, table.revokedAt),
  ],
);

export const relayManagedEndpointAllocations = mysqlTable(
  "relay_managed_endpoint_allocations",
  {
    userId: varchar("user_id", { length: 191 }).notNull(),
    environmentId: varchar("environment_id", { length: 191 }).notNull(),
    hostname: varchar("hostname", { length: 255 }).notNull(),
    tunnelId: varchar("tunnel_id", { length: 191 }),
    tunnelName: varchar("tunnel_name", { length: 255 }).notNull(),
    dnsRecordId: varchar("dns_record_id", { length: 191 }),
    readyAt: varchar("ready_at", { length: 64 }),
    createdAt: varchar("created_at", { length: 64 }).notNull(),
    updatedAt: varchar("updated_at", { length: 64 }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.environmentId] }),
    uniqueIndex("idx_relay_managed_endpoint_allocations_hostname").on(table.hostname),
    uniqueIndex("idx_relay_managed_endpoint_allocations_tunnel_name").on(table.tunnelName),
  ],
);

export const relayManagedTunnelLimits = mysqlTable("relay_managed_tunnel_limits", {
  userId: varchar("user_id", { length: 191 }).primaryKey(),
  maxTunnels: int("max_tunnels").notNull(),
  createdAt: varchar("created_at", { length: 64 }).notNull(),
  updatedAt: varchar("updated_at", { length: 64 }).notNull(),
});

export const relayEnvironmentCredentials = mysqlTable(
  "relay_environment_credentials",
  {
    credentialId: varchar("credential_id", { length: 64 }).primaryKey(),
    environmentId: varchar("environment_id", { length: 191 }).notNull(),
    environmentPublicKey: varchar("environment_public_key", { length: 255 }).notNull(),
    credentialHash: varchar("credential_hash", { length: 191 }).notNull(),
    revokedAt: varchar("revoked_at", { length: 64 }),
    createdAt: varchar("created_at", { length: 64 }).notNull(),
    updatedAt: varchar("updated_at", { length: 64 }).notNull(),
  },
  (table) => [
    uniqueIndex("idx_relay_environment_credentials_hash").on(table.credentialHash),
    index("idx_relay_environment_credentials_environment").on(table.environmentId, table.revokedAt),
    index("idx_relay_environment_credentials_environment_key").on(
      table.environmentId,
      table.environmentPublicKey,
      table.revokedAt,
    ),
  ],
);

export const relayAgentActivityRows = mysqlTable(
  "relay_agent_activity_rows",
  {
    environmentId: varchar("environment_id", { length: 191 }).notNull(),
    environmentPublicKey: varchar("environment_public_key", { length: 255 }).notNull(),
    threadId: varchar("thread_id", { length: 191 }).notNull(),
    stateJson: json("state_json").notNull().$type<RelayAgentActivityState>(),
    updatedAt: varchar("updated_at", { length: 64 }).notNull(),
    createdAt: varchar("created_at", { length: 64 }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.environmentId, table.environmentPublicKey, table.threadId] }),
    index("idx_relay_agent_activity_rows_updated").on(table.updatedAt),
  ],
);

export const relayDeliveryAttempts = mysqlTable(
  "relay_delivery_attempts",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    createdAt: varchar("created_at", { length: 64 }).notNull(),
    userId: varchar("user_id", { length: 255 }),
    environmentId: varchar("environment_id", { length: 191 }),
    threadId: varchar("thread_id", { length: 191 }),
    deviceId: varchar("device_id", { length: 255 }),
    kind: varchar("kind", { length: 64 }).notNull(),
    sourceJobId: varchar("source_job_id", { length: 64 }),
    tokenSuffix: varchar("token_suffix", { length: 16 }),
    apnsStatus: int("apns_status"),
    apnsReason: text("apns_reason"),
    apnsId: varchar("apns_id", { length: 128 }),
    transportError: text("transport_error"),
  },
  (table) => [
    index("idx_relay_delivery_attempts_environment").on(
      table.environmentId,
      table.threadId,
      table.createdAt,
    ),
    uniqueIndex("idx_relay_delivery_attempts_source_job").on(table.sourceJobId),
  ],
);

export const relayDpopProofs = mysqlTable(
  "relay_dpop_proofs",
  {
    thumbprint: varchar("thumbprint", { length: 128 }).notNull(),
    jti: varchar("jti", { length: 255 }).notNull(),
    iat: int("iat").notNull(),
    expiresAt: varchar("expires_at", { length: 64 }).notNull(),
    createdAt: varchar("created_at", { length: 64 }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.thumbprint, table.jti] }),
    index("idx_relay_dpop_proofs_expires_at").on(table.expiresAt),
  ],
);
