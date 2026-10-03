import { Effect, Schema } from "effect";

import {
  EnvironmentId,
  ForwardCompatibleOptional,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

export const EnvironmentMachineKind = Schema.Literals([
  "server",
  "cloud",
  "linux",
  "desktop",
  "laptop",
  "mac-mini",
  "mac-studio",
]);
export type EnvironmentMachineKind = typeof EnvironmentMachineKind.Type;
export const isEnvironmentMachineKind = Schema.is(EnvironmentMachineKind);
export const ThreadEnvMode = Schema.Literals(["local", "worktree"]);
export type ThreadEnvMode = typeof ThreadEnvMode.Type;

export const ExecutionEnvironmentPlatformOs = Schema.Literals([
  "darwin",
  "linux",
  "windows",
  "unknown",
]);
export type ExecutionEnvironmentPlatformOs = typeof ExecutionEnvironmentPlatformOs.Type;

export const ExecutionEnvironmentPlatformArch = Schema.Literals(["arm64", "x64", "other"]);
export type ExecutionEnvironmentPlatformArch = typeof ExecutionEnvironmentPlatformArch.Type;

export const ExecutionEnvironmentPlatform = Schema.Struct({
  os: ExecutionEnvironmentPlatformOs,
  arch: ExecutionEnvironmentPlatformArch,
  machine: ForwardCompatibleOptional(EnvironmentMachineKind),
});
export type ExecutionEnvironmentPlatform = typeof ExecutionEnvironmentPlatform.Type;

/** Wire version for orchestration snapshots, streams, commands, and RPC payloads. */
export const ORCHESTRATION_PROTOCOL_VERSION = 1;
export const ORCHESTRATION_PROTOCOL_QUERY_PARAM = "orchestrationProtocol";

export const ServerSelfUpdateMethod = Schema.Literals(["boot-service", "respawn"]);
export type ServerSelfUpdateMethod = typeof ServerSelfUpdateMethod.Type;

export const ServerSelfUpdateCapability = Schema.Literals([
  "boot-service",
  "respawn",
  "desktop-managed",
]);
export type ServerSelfUpdateCapability = typeof ServerSelfUpdateCapability.Type;

export const ExecutionEnvironmentCapabilities = Schema.Struct({
  ownedMobileProtocolVersion: Schema.optionalKey(PositiveInt),
  repositoryIdentity: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  connectionProbe: Schema.optionalKey(Schema.Boolean),
  pullRequests: Schema.optionalKey(Schema.Boolean),
  threadSettlement: Schema.optionalKey(Schema.Boolean),
  threadSnooze: Schema.optionalKey(Schema.Boolean),
  threadPinning: Schema.optionalKey(Schema.Boolean),
  threadPinReorder: Schema.optionalKey(Schema.Boolean),
  threadTitleRegeneration: Schema.optionalKey(Schema.Boolean),
  agentWorkflows: Schema.optionalKey(Schema.Boolean),
  serverSelfUpdate: Schema.optionalKey(ServerSelfUpdateCapability),
  serverSelfUpdateProgress: Schema.optionalKey(Schema.Boolean),
  agentActivityPublishing: Schema.optionalKey(Schema.Boolean),
  attachmentUploads: Schema.optionalKey(Schema.Boolean),
  fileAttachments: Schema.optionalKey(
    Schema.Struct({
      maxUploadBytes: PositiveInt,
    }),
  ),
  threadAutoSettlement: Schema.optionalKey(Schema.Boolean),
  environmentThemes: Schema.optionalKey(Schema.Boolean),
  usageLimitSources: Schema.optionalKey(Schema.Boolean),
  usagePriceOverrides: Schema.optionalKey(Schema.Boolean),
  usageSummary: Schema.optionalKey(Schema.Boolean),
  providerFeedback: Schema.optionalKey(Schema.Boolean),
  resourceTelemetry: Schema.optionalKey(Schema.Boolean),
  mediaFiles: Schema.optionalKey(Schema.Boolean),
  nativeAppIcons: Schema.optionalKey(Schema.Boolean),
  providerWorkspaceSnapshots: Schema.optionalKey(Schema.Boolean),
  threadPullRequestLinking: Schema.optionalKey(Schema.Boolean),
  /** Advertises thread-context attachments (`t3-context://` refs + `t3_thread_read`). */
  threadContext: Schema.optionalKey(Schema.Boolean),
  serverUpdateThreadContinuation: Schema.optionalKey(Schema.Boolean),
  environmentIcon: Schema.optionalKey(Schema.Boolean),
  desktopAppUpdate: Schema.optionalKey(Schema.Boolean),
});
export type ExecutionEnvironmentCapabilities = typeof ExecutionEnvironmentCapabilities.Type;

export const ExecutionEnvironmentDescriptor = Schema.Struct({
  environmentId: EnvironmentId,
  label: TrimmedNonEmptyString,
  platform: ExecutionEnvironmentPlatform,
  serverVersion: TrimmedNonEmptyString,
  /** Missing metadata denotes protocol 1. Bump this for breaking wire changes. */
  orchestrationProtocolVersion: Schema.optionalKey(Schema.Int),
  capabilities: ExecutionEnvironmentCapabilities,
});
export type ExecutionEnvironmentDescriptor = typeof ExecutionEnvironmentDescriptor.Type;

export const EnvironmentConnectionState = Schema.Literals([
  "connecting",
  "connected",
  "disconnected",
  "error",
]);
export type EnvironmentConnectionState = typeof EnvironmentConnectionState.Type;

export const RepositoryIdentityLocator = Schema.Struct({
  source: Schema.Literal("git-remote"),
  remoteName: TrimmedNonEmptyString,
  remoteUrl: TrimmedNonEmptyString,
});
export type RepositoryIdentityLocator = typeof RepositoryIdentityLocator.Type;

export const RepositoryIdentity = Schema.Struct({
  canonicalKey: TrimmedNonEmptyString,
  locator: RepositoryIdentityLocator,
  rootPath: Schema.optionalKey(TrimmedNonEmptyString),
  displayName: Schema.optionalKey(TrimmedNonEmptyString),
  provider: Schema.optionalKey(TrimmedNonEmptyString),
  owner: Schema.optionalKey(TrimmedNonEmptyString),
  name: Schema.optionalKey(TrimmedNonEmptyString),
});
export type RepositoryIdentity = typeof RepositoryIdentity.Type;

export const ScopedProjectRef = Schema.Struct({
  environmentId: EnvironmentId,
  projectId: ProjectId,
});
export type ScopedProjectRef = typeof ScopedProjectRef.Type;

export const ScopedThreadRef = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
});
export type ScopedThreadRef = typeof ScopedThreadRef.Type;

export const ScopedThreadSessionRef = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
});
export type ScopedThreadSessionRef = typeof ScopedThreadSessionRef.Type;

export const DesktopSshEnvironmentTargetSchema = Schema.Struct({
  host: Schema.optionalKey(TrimmedNonEmptyString),
  alias: Schema.optionalKey(TrimmedNonEmptyString),
  hostname: Schema.optionalKey(TrimmedNonEmptyString),
  port: Schema.optionalKey(Schema.Number),
  username: Schema.optionalKey(TrimmedNonEmptyString),
});
export type DesktopSshEnvironmentTarget = typeof DesktopSshEnvironmentTargetSchema.Type;

export const DesktopSshEnvironmentBootstrap = Schema.Struct({
  target: DesktopSshEnvironmentTargetSchema,
  httpBaseUrl: Schema.optionalKey(TrimmedNonEmptyString),
  wsBaseUrl: Schema.optionalKey(TrimmedNonEmptyString),
  pairingToken: Schema.optionalKey(TrimmedNonEmptyString),
});
export type DesktopSshEnvironmentBootstrap = typeof DesktopSshEnvironmentBootstrap.Type;
