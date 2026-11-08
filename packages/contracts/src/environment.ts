import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  ForwardCompatibleOptional,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { SourceControlProviderKind } from "./sourceControl.ts";

export const ORCHESTRATION_PROTOCOL_VERSION = 2;
export const ORCHESTRATION_PROTOCOL_VERSION_TEXT = "2";
export const ORCHESTRATION_PROTOCOL_QUERY_PARAM = "orchestrationProtocol";
export const ORCHESTRATION_PROTOCOL_HEADER = "x-t3-orchestration-protocol";

/** Wire shapes a client understands, comma-separated; a client that omits one gets the older shape. */
export const CLIENT_CAPABILITIES_QUERY_PARAM = "clientCapabilities";
/** Secret fields may hold a secret provider reference instead of a string. */
export const SETTINGS_SECRET_REFERENCES_CAPABILITY = "settingsSecretReferences";

export const ExecutionEnvironmentPlatformOs = Schema.Literals([
  "darwin",
  "linux",
  "windows",
  "unknown",
]);
export type ExecutionEnvironmentPlatformOs = typeof ExecutionEnvironmentPlatformOs.Type;

export const ExecutionEnvironmentPlatformArch = Schema.Literals(["arm64", "x64", "other"]);
export type ExecutionEnvironmentPlatformArch = typeof ExecutionEnvironmentPlatformArch.Type;

export const ENVIRONMENT_MACHINE_KINDS = [
  "server",
  "cloud",
  "linux",
  "desktop",
  "laptop",
  "mac-mini",
  "mac-studio",
] as const;
export const EnvironmentMachineKind = Schema.Literals(ENVIRONMENT_MACHINE_KINDS);
export type EnvironmentMachineKind = typeof EnvironmentMachineKind.Type;
export const isEnvironmentMachineKind = Schema.is(EnvironmentMachineKind);

export const ExecutionEnvironmentPlatform = Schema.Struct({
  os: ExecutionEnvironmentPlatformOs,
  arch: ExecutionEnvironmentPlatformArch,
  machine: ForwardCompatibleOptional(EnvironmentMachineKind),
});

// Kept outside settings.ts to avoid an orchestration import cycle.
export const ThreadEnvMode = Schema.Literals(["local", "worktree"]);
export type ThreadEnvMode = typeof ThreadEnvMode.Type;

export const WorktreeSubmodules = Schema.Literals(["recursive", "top-level", "none"]);
export type WorktreeSubmodules = typeof WorktreeSubmodules.Type;
export type ExecutionEnvironmentPlatform = typeof ExecutionEnvironmentPlatform.Type;

export const ServerSelfUpdateMethod = Schema.Literals(["boot-service", "respawn", "desktop-app"]);
export type ServerSelfUpdateMethod = typeof ServerSelfUpdateMethod.Type;

export const ServerInstallation = Schema.Union([
  Schema.Struct({ kind: Schema.Literals(["npx", "pnpm-dlx", "bunx"]) }),
  Schema.Struct({ kind: Schema.Literal("npm-global"), prefix: TrimmedNonEmptyString }),
]);
export type ServerInstallation = typeof ServerInstallation.Type;

export const ServerSelfUpdateCapability = Schema.Literals([
  "boot-service",
  "respawn",
  "desktop-managed",
]);
export type ServerSelfUpdateCapability = typeof ServerSelfUpdateCapability.Type;

export const ExecutionEnvironmentCapabilities = Schema.Struct({
  repositoryIdentity: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  connectionProbe: Schema.optionalKey(Schema.Boolean),
  attachmentUploads: Schema.optionalKey(Schema.Boolean),
  questionAttachments: Schema.optionalKey(Schema.Boolean),
  fileAttachments: Schema.optionalKey(
    Schema.Struct({
      maxUploadBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    }),
  ),
  pullRequests: Schema.optionalKey(Schema.Boolean),
  pullRequestChecks: Schema.optionalKey(Schema.Boolean),
  /** Side chats: hidden `lineage.sideChat` forks. Older servers ignore the fork flag. */
  sideChats: Schema.optionalKey(Schema.Boolean),
  vcsBranchStatus: Schema.optionalKey(Schema.Boolean),
  /** Every protocol-2 server sends this; older mobile builds still read it. */
  inlineMessageContext: Schema.optionalKey(Schema.Boolean),
  requiredWorktreeBootstrap: Schema.optionalKey(Schema.Boolean),
  threadSettlement: Schema.optionalKey(Schema.Boolean),
  threadAutoSettlement: Schema.optionalKey(Schema.Boolean),
  storageCleanup: Schema.optionalKey(Schema.Boolean),
  storageCleanupRun: Schema.optionalKey(Schema.Boolean),
  databaseStorage: Schema.optionalKey(Schema.Boolean),
  otlpEndpointCheck: Schema.optionalKey(Schema.Boolean),
  projectWorktreeCleanup: Schema.optionalKey(Schema.Boolean),
  settledWorktreeCleanup: Schema.optionalKey(Schema.Boolean),
  worktreesDirectory: Schema.optionalKey(Schema.Boolean),
  threadAutoSettlementScope: Schema.optionalKey(Schema.Boolean),
  threadRestartContinuation: Schema.optionalKey(Schema.Boolean),
  projectSettingsOverrides: Schema.optionalKey(Schema.Boolean),
  /** Hide the switch when absent; older servers silently drop per-project provider patches. */
  projectProviderInstanceOverrides: Schema.optionalKey(Schema.Boolean),
  threadSnooze: Schema.optionalKey(Schema.Boolean),
  /** Serves `orchestration.forceStopThread`; hide Force stop where it is absent. */
  threadForceStop: Schema.optionalKey(Schema.Boolean),
  /** Every protocol-2 server sends this; older mobile builds still read it. */
  environmentThemes: Schema.optionalKey(Schema.Boolean),
  usageLimitSources: Schema.optionalKey(Schema.Boolean),
  /** Honors `workspaceSnapshotsOnDemand`; older servers send every snapshot and drop them in the stream. */
  providerWorkspaceSnapshotsOnDemand: Schema.optionalKey(Schema.Boolean),
  usagePriceOverrides: Schema.optionalKey(Schema.Boolean),
  usageModelAliases: Schema.optionalKey(Schema.Boolean),
  threadPinning: Schema.optionalKey(Schema.Boolean),
  threadPinReorder: Schema.optionalKey(Schema.Boolean),
  threadActiveReorder: Schema.optionalKey(Schema.Boolean),
  threadAutoSettleOptOut: Schema.optionalKey(Schema.Boolean),
  threadProjectFromScratch: Schema.optionalKey(Schema.Boolean),
  threadTitleRegeneration: Schema.optionalKey(Schema.Boolean),
  threadVisitedTracking: Schema.optionalKey(Schema.Boolean),
  threadPullRequestLinking: Schema.optionalKey(Schema.Boolean),
  serverResolvedCommandContext: Schema.optionalKey(Schema.Boolean),
  threadStop: Schema.optionalKey(Schema.Boolean),
  /** Absent on older servers and on Windows hosts, which cannot stop a discovered server. */
  localServerStop: Schema.optionalKey(Schema.Boolean),
  threadPullRequests: Schema.optionalKey(Schema.Boolean),
  threadPullRequestWatch: Schema.optionalKey(Schema.Boolean),
  pullRequestStackActions: Schema.optionalKey(Schema.Boolean),
  serverSelfUpdate: Schema.optionalKey(ServerSelfUpdateCapability),
  /** Server answers server.getNpmRelease using its configured npm registry. */
  npmReleaseLookup: Schema.optionalKey(Schema.Boolean),
  /** Manual commands must update this install, not the host's default global prefix. */
  serverInstallation: ForwardCompatibleOptional(ServerInstallation),
  serverSelfUpdateProgress: Schema.optionalKey(Schema.Boolean),
  serverUpdateThreadContinuation: Schema.optionalKey(Schema.Boolean),
  /** Only explicit false skips Live Activity seeding; older servers may still publish. */
  agentActivityPublishing: Schema.optionalKey(Schema.Boolean),
  projectCloneTracking: Schema.optionalKey(Schema.Boolean),
  /** Server keeps `pinned` and `archived` from project.update. Older servers drop them. */
  projectOrganization: Schema.optionalKey(Schema.Boolean),
  /** Server answers projects.listIgnoredFiles. */
  ignoredFileListing: Schema.optionalKey(Schema.Boolean),
  environmentIcon: Schema.optionalKey(Schema.Boolean),
  desktopAppUpdate: Schema.optionalKey(Schema.Boolean),
  /** The desktop app switches update tracks when a server update request names one. */
  desktopAppChannelSwitch: Schema.optionalKey(Schema.Boolean),
  /** Subscribe to command output only when advertised; older servers never send it. */
  commandOutputStreaming: Schema.optionalKey(Schema.Boolean),
  /** Hosts headless Chromium tabs streamed over /api/preview-stream for clients without a local runtime. */
  serverBrowser: Schema.optionalKey(Schema.Boolean),
  /** Server links to other environments (`PeerLink`) and its agents can work
      in them. Absent on servers from before linking, which clients must not
      offer linking for. */
  peerLinks: Schema.optionalKey(Schema.Boolean),
  /** Server's `/mcp` narrows an OAuth client's modes from `T3-Mode-Limit`, so
      a linked environment's calls keep its agent's limits. Another environment
      links to this one only when it is set. */
  mcpModeLimitHeader: Schema.optionalKey(Schema.Boolean),
  /** Work a linked environment starts here stays within its link
      (`linkOrigin`). Another environment links to this one only when it is
      set, since without it that work could change the user's own threads. */
  linkFence: Schema.optionalKey(Schema.Boolean),
  /** Server answers server.prepareTriage. */
  triage: Schema.optionalKey(Schema.Boolean),
  /** Server accepts `{ type: "once" }` scheduled tasks; older servers reject them on save. */
  oneTimeSchedules: Schema.optionalKey(Schema.Boolean),
  /** Server honors `freshContext` on sends; older servers ignore it and keep the old context. */
  freshContext: Schema.optionalKey(Schema.Boolean),
  /** Server saves and runs scheduled task `threadMode`; older servers ignore it. */
  scheduledTaskThreadModes: Schema.optionalKey(Schema.Boolean),
  /** Server can transcribe 16 kHz mono PCM audio on the environment machine. */
  voiceTranscription: Schema.optionalKey(Schema.Boolean),
  cloudVoiceTranscription: Schema.optionalKey(Schema.Boolean),
});
export type ExecutionEnvironmentCapabilities = typeof ExecutionEnvironmentCapabilities.Type;

export const ExecutionEnvironmentDescriptor = Schema.Struct({
  environmentId: EnvironmentId,
  label: TrimmedNonEmptyString,
  platform: ExecutionEnvironmentPlatform,
  serverVersion: TrimmedNonEmptyString,
  orchestrationProtocolVersion: Schema.optionalKey(Schema.Int),
  /** Highest migration this server's database holds; absent on older servers. */
  databaseMigration: Schema.optionalKey(Schema.Int),
  capabilities: ExecutionEnvironmentCapabilities,
});
export type ExecutionEnvironmentDescriptor = typeof ExecutionEnvironmentDescriptor.Type;

export const RepositoryIdentityLocator = Schema.Struct({
  source: Schema.Literal("git-remote"),
  remoteName: TrimmedNonEmptyString,
  remoteUrl: TrimmedNonEmptyString,
});
export type RepositoryIdentityLocator = typeof RepositoryIdentityLocator.Type;

export const RepositoryOrigin = Schema.Struct({
  canonicalKey: TrimmedNonEmptyString,
  remoteUrl: Schema.optionalKey(TrimmedNonEmptyString),
  displayName: Schema.optionalKey(TrimmedNonEmptyString),
});
export type RepositoryOrigin = typeof RepositoryOrigin.Type;

export const RepositoryIdentity = Schema.Struct({
  canonicalKey: TrimmedNonEmptyString,
  locator: RepositoryIdentityLocator,
  webUrl: Schema.optionalKey(TrimmedNonEmptyString),
  /** Work tree root, or the git dir for a bare repository. */
  rootPath: Schema.optionalKey(TrimmedNonEmptyString),
  displayName: Schema.optionalKey(TrimmedNonEmptyString),
  provider: Schema.optionalKey(SourceControlProviderKind),
  owner: Schema.optionalKey(TrimmedNonEmptyString),
  name: Schema.optionalKey(TrimmedNonEmptyString),
  origin: Schema.optionalKey(RepositoryOrigin),
});
export type RepositoryIdentity = typeof RepositoryIdentity.Type;

export function repositoryGroupingKeyOf(identity: RepositoryIdentity): string {
  return identity.origin?.canonicalKey ?? identity.canonicalKey;
}

export function repositoryGroupingDisplayNameOf(identity: RepositoryIdentity): string | undefined {
  return identity.origin
    ? (identity.origin.displayName ?? identity.origin.canonicalKey)
    : identity.displayName;
}

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

export const BoatSandboxSize = Schema.Literals(["small", "default", "large", "xlarge"]);
export type BoatSandboxSize = typeof BoatSandboxSize.Type;

export const BOAT_SANDBOX_HOURLY_USD = {
  small: 0.018,
  default: 0.036,
  large: 0.072,
  xlarge: 0.144,
} as const satisfies Record<BoatSandboxSize, number>;

export const DEFAULT_MAX_CONCURRENT_SANDBOXES = 3;

export const CloudSandboxState = Schema.Literals([
  "starting",
  "ready",
  "stopping",
  "stopped",
  "degraded",
  "error",
]);
export type CloudSandboxState = typeof CloudSandboxState.Type;
export const BoatSandboxState = CloudSandboxState;
export type BoatSandboxState = CloudSandboxState;

export const BoatSandboxSummary = Schema.Struct({
  sandboxId: Schema.String,
  name: Schema.String,
  size: BoatSandboxSize,
  state: BoatSandboxState,
  autoStopDeadline: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  hourlyRateUsd: Schema.NullOr(Schema.Number),
});
export type BoatSandboxSummary = typeof BoatSandboxSummary.Type;

export const BoatDesktopStreamSession = Schema.Struct({
  desktopUrl: Schema.String,
  expiresAt: Schema.NullOr(Schema.String),
  viewMode: Schema.Literals(["desktop", "browser"]),
});
export type BoatDesktopStreamSession = typeof BoatDesktopStreamSession.Type;

export const CloudSandboxDriverKind = Schema.Literals([
  "boat",
  "daytona",
  "e2b",
  "modal",
  "custom",
]);
export type CloudSandboxDriverKind = typeof CloudSandboxDriverKind.Type;

export const SandboxAutoStopMinutes = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: 43200 }),
);
export const SandboxProfileId = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[a-zA-Z0-9_-]{1,64}$/u),
).pipe(Schema.brand("SandboxProfileId"));
export type SandboxProfileId = typeof SandboxProfileId.Type;

/**
 * A named provider configuration the server provisions ephemeral sandboxes
 * from. The API key never leaves the server's secret store, so the public
 * shape exposes only whether one is set.
 */
export const CloudSandboxProfile = Schema.Struct({
  profileId: SandboxProfileId,
  name: TrimmedNonEmptyString,
  driverKind: CloudSandboxDriverKind,
  apiKeySet: Schema.Boolean,
  defaultSize: Schema.NullOr(BoatSandboxSize),
  autoStopMinutes: SandboxAutoStopMinutes,
  /** Boot template saved snapshot; null creates each sandbox from scratch. */
  template: Schema.NullOr(TrimmedNonEmptyString),
  monthlyBudgetUsd: Schema.NullOr(Schema.Number.check(Schema.isGreaterThan(0))),
  maxConcurrentSandboxes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
});
export type CloudSandboxProfile = typeof CloudSandboxProfile.Type;

/** Setting `apiKey` replaces the stored key; omitting it keeps the current one. */
export const CloudSandboxProfileSaveInput = Schema.Struct({
  profileId: SandboxProfileId,
  name: TrimmedNonEmptyString,
  driverKind: CloudSandboxDriverKind,
  apiKey: Schema.optionalKey(TrimmedNonEmptyString),
  defaultSize: Schema.NullOr(BoatSandboxSize),
  autoStopMinutes: SandboxAutoStopMinutes,
  template: Schema.NullOr(TrimmedNonEmptyString),
  monthlyBudgetUsd: Schema.NullOr(Schema.Number.check(Schema.isGreaterThan(0))),
  maxConcurrentSandboxes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
});
export type CloudSandboxProfileSaveInput = typeof CloudSandboxProfileSaveInput.Type;

export const CloudSandboxProfileTestInput = Schema.Union([
  Schema.Struct({ profileId: SandboxProfileId }),
  Schema.Struct({ driverKind: CloudSandboxDriverKind, apiKey: TrimmedNonEmptyString }),
]);
export type CloudSandboxProfileTestInput = typeof CloudSandboxProfileTestInput.Type;

/** Spend accumulated against a profile since the period began. */
export const CloudSandboxProfileSpend = Schema.Struct({
  /** UTC calendar month in `YYYY-MM` form. */
  period: TrimmedNonEmptyString,
  usd: Schema.Number,
  /** Sandboxes currently billed hourly; their running cost is not yet included. */
  running: Schema.Int,
});
export type CloudSandboxProfileSpend = typeof CloudSandboxProfileSpend.Type;

export const CloudSandboxProfileStatus = Schema.Struct({
  profile: CloudSandboxProfile,
  spend: Schema.NullOr(CloudSandboxProfileSpend),
});
export type CloudSandboxProfileStatus = typeof CloudSandboxProfileStatus.Type;

export const CloudSandboxCapabilities = Schema.Struct({
  diskForking: Schema.Boolean,
  desktopStreaming: Schema.Boolean,
  browserStreaming: Schema.optionalKey(Schema.Boolean),
  recording: Schema.optionalKey(Schema.Boolean),
  usage: Schema.optionalKey(Schema.Boolean),
  resizeMode: Schema.optionalKey(Schema.Literals(["none", "restart", "hot"])),
  autoStopKeepalive: Schema.Boolean,
  publicPortHosting: Schema.Boolean,
  protectedPortHosting: Schema.optionalKey(Schema.Boolean),
  hotResize: Schema.Boolean,
  rootAccess: Schema.Boolean,
});
export type CloudSandboxCapabilities = typeof CloudSandboxCapabilities.Type;

export const CloudSandboxSummary = Schema.Struct({
  sandboxId: Schema.String,
  name: Schema.String,
  driverKind: CloudSandboxDriverKind,
  state: CloudSandboxState,
  size: Schema.optionalKey(Schema.String),
  autoStopDeadline: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  hourlyRateUsd: Schema.optionalKey(Schema.NullOr(Schema.Number)),
});
export type CloudSandboxSummary = typeof CloudSandboxSummary.Type;

export const CloudSandboxDetails = Schema.Struct({
  sandboxId: Schema.String,
  name: Schema.String,
  driverKind: CloudSandboxDriverKind,
  state: CloudSandboxState,
  size: Schema.optionalKey(Schema.String),
  autoStopDeadline: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  hourlyRateUsd: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  sshHost: Schema.optionalKey(Schema.String),
  sshPort: Schema.optionalKey(Schema.Int),
  sshUsername: Schema.optionalKey(Schema.String),
});
export type CloudSandboxDetails = typeof CloudSandboxDetails.Type;

export const SandboxDesktopStreamSession = Schema.Struct({
  desktopUrl: Schema.String,
  expiresAt: Schema.NullOr(Schema.String),
  viewMode: Schema.Literals(["desktop", "browser"]),
});
export type SandboxDesktopStreamSession = typeof SandboxDesktopStreamSession.Type;

export const SandboxForkOptions = Schema.Struct({
  size: Schema.optionalKey(Schema.String),
  autoStopMinutes: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 43200 })),
  ),
  requestId: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
});
export type SandboxForkOptions = typeof SandboxForkOptions.Type;

export const SandboxSnapshot = Schema.Struct({
  name: Schema.String,
  state: Schema.Literals(["saving", "ready", "failed"]),
  sourceSandboxId: Schema.String,
  error: Schema.optionalKey(Schema.String),
});
export type SandboxSnapshot = typeof SandboxSnapshot.Type;
export const SandboxDeletionOperation = Schema.Struct({
  operationId: Schema.String,
  sandboxId: Schema.String,
  state: Schema.Literals(["pending", "processing", "blocked", "completed"]),
});
export type SandboxDeletionOperation = typeof SandboxDeletionOperation.Type;
export const SandboxUsage = Schema.Struct({
  sandboxId: Schema.String,
  listRateUsdPerHour: Schema.Number,
  billableSeconds: Schema.Number,
  listValueUsd: Schema.Number,
  running: Schema.Boolean,
  since: Schema.String,
  until: Schema.String,
});
export type SandboxUsage = typeof SandboxUsage.Type;
export const SandboxRecordingId = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,80}$/u));
export const SandboxRecording = Schema.Struct({
  recordingId: SandboxRecordingId,
  state: Schema.Literals(["recording", "completed", "failed"]),
  path: Schema.String,
  mimeType: Schema.Literal("video/mp4"),
});
export type SandboxRecording = typeof SandboxRecording.Type;

export const SandboxHostedPortResult = Schema.Struct({
  port: Schema.Int,
  url: Schema.String,
  isPublic: Schema.Boolean,
});
export type SandboxHostedPortResult = typeof SandboxHostedPortResult.Type;

export const CloudSandboxSelection = Schema.Struct({
  requestId: Schema.optionalKey(Schema.String),
  template: Schema.optionalKey(Schema.String),
  name: TrimmedNonEmptyString,
  size: BoatSandboxSize,
  autoStopMinutes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 43200 })),
});
export type CloudSandboxSelection = typeof CloudSandboxSelection.Type;
export const CloudSandboxPrepareInput = Schema.Struct({
  profile: SandboxProfileId,
  sandbox: CloudSandboxSelection,
});
export type CloudSandboxPrepareInput = typeof CloudSandboxPrepareInput.Type;

export const CloudSandboxOperationResult = Schema.Union([
  Schema.TaggedStruct("list", { sandboxes: Schema.Array(CloudSandboxSummary) }),
  Schema.TaggedStruct("status", {
    sandbox: CloudSandboxDetails,
    capabilities: CloudSandboxCapabilities,
  }),
  Schema.TaggedStruct("desktop", { session: SandboxDesktopStreamSession }),
  Schema.TaggedStruct("fork", { sandbox: CloudSandboxDetails }),
  Schema.TaggedStruct("host", { port: SandboxHostedPortResult }),
  Schema.TaggedStruct("deleted", {}),
]);
export type CloudSandboxOperationResult = typeof CloudSandboxOperationResult.Type;

export const CLOUD_SANDBOX_ACTIVITY_PATH = "/api/cloud-sandboxes/activity";
export const CloudSandboxActivity = Schema.Struct({ active: Schema.Boolean });
