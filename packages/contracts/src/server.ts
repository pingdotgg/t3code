import * as Schema from "effect/Schema";
import {
  type EnvironmentMachineKind,
  ExecutionEnvironmentDescriptor,
  ServerSelfUpdateMethod,
} from "./environment.ts";
import { ServerAuthDescriptor } from "./auth.ts";
import {
  ForwardCompatibleArray,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import {
  KeybindingCommand,
  KeybindingValue,
  KeybindingWhen,
  ResolvedKeybindingsConfig,
} from "./keybindings.ts";
import {
  EditorId,
  FileManagerRevealKind,
  RemoteOpenTarget,
} from "./editor.ts";
import { ManagedPolicySummary } from "./managedPolicy.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import { UsageLimitSourceSnapshots } from "./providerUsageLimits.ts";
import { ServerSettings } from "./settings.ts";
import { DesktopUpdateChannelSchema } from "./ipc.ts";
import { ServerConfigIssues, ServerObservability, ServerProcessResourceHistoryBucket, ServerProcessSignal, ServerProviders } from "./serverPart2.ts";
export {
  OtlpEndpointCheckInput,
  OtlpEndpointCheckResult,
  OtlpEndpointSource,
  OtlpSignal,
  PROVIDER_WORKSPACE_SNAPSHOT_TTL_MS,
  ServerConfigIssue,
  ServerObservability,
  ServerPrepareTriageError,
  ServerPrepareTriageInput,
  ServerPrepareTriageResult,
  ServerProcessDiagnosticsEntry,
  ServerProcessDiagnosticsResult,
  ServerProcessResourceHistoryInput,
  ServerProcessSignal,
  ServerProvider,
  ServerProviderAuth,
  ServerProviderCompatibilityAdvisory,
  ServerProviderCompatibilityStatus,
  ServerProviderModel,
  ServerProviderSkill,
  ServerProviderSlashCommand,
  ServerProviderState,
  ServerProviderUpdateRequiredModel,
  ServerProviderUpdateState,
  ServerProviderVersionAdvisory,
  ServerProviderWorkspaceSnapshot,
  ServerProviders,
  ServerTraceDiagnosticsErrorKind,
  ServerTraceDiagnosticsFailureSummary,
  ServerTraceDiagnosticsLogEvent,
  ServerTraceDiagnosticsRecentFailure,
  ServerTraceDiagnosticsResult,
  ServerTraceDiagnosticsSpanOccurrence,
  ServerTraceDiagnosticsSpanSummary,
  TRIAGE_PROMPT_FILE_NAME,
  isProviderAvailable,
  isProviderTextGenerationCapable,
  isProviderWorkspaceSnapshotCurrent,
} from "./serverPart2.ts";

export const ServerProcessResourceHistorySummary = Schema.Struct({
  processKey: TrimmedNonEmptyString,
  pid: PositiveInt,
  ppid: NonNegativeInt,
  command: TrimmedNonEmptyString,
  depth: NonNegativeInt,
  isServerRoot: Schema.Boolean,
  firstSeenAt: Schema.DateTimeUtc,
  lastSeenAt: Schema.DateTimeUtc,
  currentCpuPercent: Schema.Number,
  avgCpuPercent: Schema.Number,
  maxCpuPercent: Schema.Number,
  cpuSecondsApprox: Schema.Number,
  currentRssBytes: NonNegativeInt,
  maxRssBytes: NonNegativeInt,
  sampleCount: NonNegativeInt,
});
export type ServerProcessResourceHistorySummary = typeof ServerProcessResourceHistorySummary.Type;

const ServerProcessResourceHistoryFailureTag = Schema.Literals([
  "ProcessDiagnosticsQueryTimeoutError",
  "ProcessDiagnosticsQueryFailedError",
  "ProcessDiagnosticsServerProcessSignalError",
  "ProcessDiagnosticsNotDescendantError",
  "ProcessDiagnosticsSignalFailedError",
]);
type ServerProcessResourceHistoryFailureTag =
  typeof ServerProcessResourceHistoryFailureTag.Type;

export const ServerProcessResourceHistoryResult = Schema.Struct({
  readAt: Schema.DateTimeUtc,
  windowMs: NonNegativeInt,
  bucketMs: NonNegativeInt,
  sampleIntervalMs: NonNegativeInt,
  retainedSampleCount: NonNegativeInt,
  totalCpuSecondsApprox: Schema.Number,
  buckets: Schema.Array(ServerProcessResourceHistoryBucket),
  topProcesses: Schema.Array(ServerProcessResourceHistorySummary),
  error: Schema.Option(
    Schema.Struct({
      failureTag: ServerProcessResourceHistoryFailureTag,
      message: TrimmedNonEmptyString,
    }),
  ),
});
export type ServerProcessResourceHistoryResult = typeof ServerProcessResourceHistoryResult.Type;

export const ServerSignalProcessInput = Schema.Struct({
  pid: PositiveInt,
  startTimeMs: NonNegativeInt,
  signal: ServerProcessSignal,
});
export type ServerSignalProcessInput = typeof ServerSignalProcessInput.Type;

export const ServerSignalProcessResult = Schema.Struct({
  pid: PositiveInt,
  signal: ServerProcessSignal,
  signaled: Schema.Boolean,
  message: Schema.Option(TrimmedNonEmptyString),
});
export type ServerSignalProcessResult = typeof ServerSignalProcessResult.Type;

const EnvironmentThemeColor = Schema.String.check(
  Schema.isPattern(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/),
);
type EnvironmentThemeColor = typeof EnvironmentThemeColor.Type;

/** Reserve appearance keywords so published themes cannot replace stock preferences. */
export const EnvironmentThemeId = Schema.String.check(
  Schema.isPattern(/^(?!(?:system|light|dark)$)[a-z0-9](?:[a-z0-9-]{0,47})$/),
);
export type EnvironmentThemeId = typeof EnvironmentThemeId.Type;

const EnvironmentThemeColors = Schema.Record(
  Schema.String.check(Schema.isPattern(/^[a-zA-Z][a-zA-Z0-9]{0,63}$/)),
  TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
);

const environmentThemeFields = {
  version: Schema.optional(Schema.Literal(1)),
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(48)),
  appearance: Schema.Literals(["light", "dark"]),
  /** Derive the palette from canvas/accent, then overlay colors; without them, colors is the palette. */
  canvas: Schema.optional(EnvironmentThemeColor),
  accent: Schema.optional(EnvironmentThemeColor),
  colors: Schema.optional(EnvironmentThemeColors),
  variants: Schema.optional(
    Schema.Struct({
      light: Schema.optional(EnvironmentThemeColors),
      dark: Schema.optional(EnvironmentThemeColors),
    }),
  ),
};

export const EnvironmentThemeFile = Schema.Struct(environmentThemeFields);
export type EnvironmentThemeFile = typeof EnvironmentThemeFile.Type;

export const EnvironmentTheme = Schema.Struct({
  id: EnvironmentThemeId,
  ...environmentThemeFields,
});
export type EnvironmentTheme = typeof EnvironmentTheme.Type;

export function environmentThemeFileHasColors(file: EnvironmentThemeFile): boolean {
  return (
    (file.canvas !== undefined && file.accent !== undefined) ||
    (file.colors !== undefined && Object.keys(file.colors).length > 0)
  );
}

/** tailnet means this machine's Tailscale interface; other private addresses are lan. */
const ServerDirectEndpointKind = Schema.Literals(["lan", "tailnet"]);
type ServerDirectEndpointKind = typeof ServerDirectEndpointKind.Type;

export const ServerDirectEndpoint = Schema.Struct({
  kind: ServerDirectEndpointKind,
  httpBaseUrl: TrimmedNonEmptyString,
});
export type ServerDirectEndpoint = typeof ServerDirectEndpoint.Type;

/**
 * A stretch where the server's event loop could not run, so it answered
 * nothing and clients may have dropped the connection.
 */
export const ServerEventLoopStall = Schema.Struct({
  detectedAt: IsoDateTime,
  durationMs: NonNegativeInt,
  /** One-minute load average when the stall was seen. Absent on Windows, which has none. */
  loadAverage: Schema.optionalKey(Schema.Number),
  cpuCount: PositiveInt,
});
export type ServerEventLoopStall = typeof ServerEventLoopStall.Type;

export const ServerConfig = Schema.Struct({
  environment: ExecutionEnvironmentDescriptor,
  auth: ServerAuthDescriptor,
  cwd: TrimmedNonEmptyString,
  keybindingsConfigPath: TrimmedNonEmptyString,
  keybindings: ResolvedKeybindingsConfig,
  issues: ServerConfigIssues,
  providers: ServerProviders,
  availableEditors: ForwardCompatibleArray(EditorId),
  remoteOpenTargets: Schema.optionalKey(ForwardCompatibleArray(RemoteOpenTarget)),
  /** Hints only; verify each address answers as this environment. */
  directEndpoints: Schema.optionalKey(ForwardCompatibleArray(ServerDirectEndpoint)),
  observability: ServerObservability,
  settings: ServerSettings,
  /** Present when an administrator's policy file manages this environment. */
  managedPolicy: Schema.optionalKey(ManagedPolicySummary),
  shellResumeCompletionMarker: Schema.optionalKey(Schema.Boolean),
  /**
   * The shell can leave idle subagent children out of snapshots (`omitIdleSubagents`), and
   * `getThreadFamily` and `getWorktreeThreadIds` serve the rows it leaves out.
   */
  shellThreadFamilies: Schema.optionalKey(Schema.Boolean),
  /**
   * The shell can leave older settled threads out of snapshots (`omitOlderSettled`), and
   * `getOlderSettledThreads` serves them. Only servers that also advertise `shellThreadFamilies`.
   */
  shellOlderSettled: Schema.optionalKey(Schema.Boolean),
  shellRevealInFileManager: Schema.optionalKey(Schema.Boolean),
  shellRevealInFileManagerKind: Schema.optionalKey(FileManagerRevealKind),
  threadResumeCompletionMarker: Schema.optionalKey(Schema.Boolean),
  /** Send window fields only when advertised. */
  threadSnapshotPagination: Schema.optionalKey(Schema.Boolean),
  threadFind: Schema.optionalKey(Schema.Boolean),
  threadFindProgressive: Schema.optionalKey(Schema.Boolean),
  /** Settings patches may carry `secretProviders`; older servers drop the key without an error. */
  secretProviderSettings: Schema.optionalKey(Schema.Boolean),
  /** Secret settings may point at a secret provider; older servers drop the reference. */
  secretReferences: Schema.optionalKey(Schema.Boolean),
  scratchWorkspaceRoot: Schema.optionalKey(TrimmedNonEmptyString),
  newProjectsRoot: Schema.optionalKey(TrimmedNonEmptyString),
  /**
   * The latest stall long enough to notice, sent only for a few minutes after
   * it. A client that reconnects reads it to say why the host stopped
   * answering. Clients do not cache it, since it describes the host at connect.
   */
  lastEventLoopStall: Schema.optionalKey(ServerEventLoopStall),
  /**
   * Never sent in a config snapshot: the theme stream emits the current set
   * before any change, so a snapshot carrying it too would hand every
   * subscriber the same array twice per connect.
   */
  environmentThemes: Schema.optional(Schema.Array(EnvironmentTheme)),
  /** Stream-only and opt-in; the source stream emits the current set on subscribe. */
  usageLimitSources: Schema.optional(UsageLimitSourceSnapshots),
});
export type ServerConfig = typeof ServerConfig.Type;

export function resolveEnvironmentMachineKind(
  config: {
    readonly environment: Pick<ExecutionEnvironmentDescriptor, "platform">;
    readonly settings?: Pick<ServerSettings, "environmentIcon">;
  } | null,
): EnvironmentMachineKind {
  return config?.settings?.environmentIcon ?? config?.environment.platform.machine ?? "server";
}

const ServerUpsertKeybindingReplaceTarget = Schema.Struct({
  key: KeybindingValue,
  command: KeybindingCommand,
  when: Schema.optional(KeybindingWhen),
});

export const ServerUpsertKeybindingInput = Schema.Struct({
  key: KeybindingValue,
  command: KeybindingCommand,
  when: Schema.optional(KeybindingWhen),
  replace: Schema.optional(ServerUpsertKeybindingReplaceTarget),
});
export type ServerUpsertKeybindingInput = typeof ServerUpsertKeybindingInput.Type;

export const ServerRemoveKeybindingInput = ServerUpsertKeybindingReplaceTarget;
export type ServerRemoveKeybindingInput = typeof ServerRemoveKeybindingInput.Type;

export const ServerUpsertKeybindingResult = Schema.Struct({
  keybindings: ResolvedKeybindingsConfig,
  issues: ServerConfigIssues,
});
export type ServerUpsertKeybindingResult = typeof ServerUpsertKeybindingResult.Type;

export const ServerRemoveKeybindingResult = ServerUpsertKeybindingResult;
export type ServerRemoveKeybindingResult = typeof ServerRemoveKeybindingResult.Type;

const ServerConfigUpdatedPayload = Schema.Struct({
  issues: ServerConfigIssues,
  providers: ServerProviders,
  settings: Schema.optional(ServerSettings),
});
type ServerConfigUpdatedPayload = typeof ServerConfigUpdatedPayload.Type;

const ServerConfigKeybindingsUpdatedPayload = Schema.Struct({
  keybindings: ResolvedKeybindingsConfig,
  issues: ServerConfigIssues,
});
type ServerConfigKeybindingsUpdatedPayload =
  typeof ServerConfigKeybindingsUpdatedPayload.Type;

const ServerConfigProviderStatusesPayload = Schema.Struct({
  providers: ServerProviders,
});
type ServerConfigProviderStatusesPayload = typeof ServerConfigProviderStatusesPayload.Type;

const ServerConfigSettingsUpdatedPayload = Schema.Struct({
  settings: ServerSettings,
});
type ServerConfigSettingsUpdatedPayload = typeof ServerConfigSettingsUpdatedPayload.Type;

const ServerConfigStreamSnapshotEvent = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("snapshot"),
  config: ServerConfig,
});
type ServerConfigStreamSnapshotEvent = typeof ServerConfigStreamSnapshotEvent.Type;

const ServerConfigStreamKeybindingsUpdatedEvent = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("keybindingsUpdated"),
  payload: ServerConfigKeybindingsUpdatedPayload,
});
type ServerConfigStreamKeybindingsUpdatedEvent =
  typeof ServerConfigStreamKeybindingsUpdatedEvent.Type;

const ServerConfigStreamProviderStatusesEvent = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("providerStatuses"),
  payload: ServerConfigProviderStatusesPayload,
});
type ServerConfigStreamProviderStatusesEvent =
  typeof ServerConfigStreamProviderStatusesEvent.Type;

const ServerConfigStreamSettingsUpdatedEvent = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("settingsUpdated"),
  payload: ServerConfigSettingsUpdatedPayload,
});
type ServerConfigStreamSettingsUpdatedEvent =
  typeof ServerConfigStreamSettingsUpdatedEvent.Type;

const ServerConfigEnvironmentThemesUpdatedPayload = Schema.Struct({
  themes: Schema.Array(EnvironmentTheme),
});
type ServerConfigEnvironmentThemesUpdatedPayload =
  typeof ServerConfigEnvironmentThemesUpdatedPayload.Type;

const ServerConfigStreamEnvironmentThemesUpdatedEvent = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("environmentThemesUpdated"),
  payload: ServerConfigEnvironmentThemesUpdatedPayload,
});
type ServerConfigStreamEnvironmentThemesUpdatedEvent =
  typeof ServerConfigStreamEnvironmentThemesUpdatedEvent.Type;

const ServerConfigUsageLimitSourcesUpdatedPayload = Schema.Struct({
  sources: UsageLimitSourceSnapshots,
});
type ServerConfigUsageLimitSourcesUpdatedPayload =
  typeof ServerConfigUsageLimitSourcesUpdatedPayload.Type;

const ServerConfigStreamUsageLimitSourcesUpdatedEvent = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("usageLimitSourcesUpdated"),
  payload: ServerConfigUsageLimitSourcesUpdatedPayload,
});
type ServerConfigStreamUsageLimitSourcesUpdatedEvent =
  typeof ServerConfigStreamUsageLimitSourcesUpdatedEvent.Type;

export const ServerConfigStreamEvent = Schema.Union([
  ServerConfigStreamSnapshotEvent,
  ServerConfigStreamKeybindingsUpdatedEvent,
  ServerConfigStreamProviderStatusesEvent,
  ServerConfigStreamSettingsUpdatedEvent,
  ServerConfigStreamEnvironmentThemesUpdatedEvent,
  ServerConfigStreamUsageLimitSourcesUpdatedEvent,
]);
export type ServerConfigStreamEvent = typeof ServerConfigStreamEvent.Type;

export const ServerSelfUpdateOutcome = Schema.Struct({
  id: TrimmedNonEmptyString,
  fromVersion: TrimmedNonEmptyString,
  targetVersion: TrimmedNonEmptyString,
  status: Schema.Literals(["committed", "rolled-back", "failed"]),
  reason: Schema.optionalKey(TrimmedNonEmptyString),
});
export type ServerSelfUpdateOutcome = typeof ServerSelfUpdateOutcome.Type;

const ServerLifecycleReadyPayload = Schema.Struct({
  at: IsoDateTime,
  environment: ExecutionEnvironmentDescriptor,
  updateOutcome: Schema.optionalKey(ServerSelfUpdateOutcome),
});
type ServerLifecycleReadyPayload = typeof ServerLifecycleReadyPayload.Type;

export const ServerLifecycleWelcomePayload = Schema.Struct({
  environment: ExecutionEnvironmentDescriptor,
  cwd: TrimmedNonEmptyString,
  projectName: TrimmedNonEmptyString,
  bootstrapStatus: Schema.optional(Schema.Literals(["pending", "complete"])),
  bootstrapProjectId: Schema.optional(ProjectId),
  bootstrapThreadId: Schema.optional(ThreadId),
  bootstrapProjectCreated: Schema.optional(Schema.Boolean),
  bootstrapThreadCreated: Schema.optional(Schema.Boolean),
});
export type ServerLifecycleWelcomePayload = typeof ServerLifecycleWelcomePayload.Type;

export const ServerLifecycleLegacyThreadMigrationPayload = Schema.Struct({
  status: Schema.Union([Schema.Literal("running"), Schema.Literal("complete")]),
  totalThreadCount: NonNegativeInt,
});
export type ServerLifecycleLegacyThreadMigrationPayload =
  typeof ServerLifecycleLegacyThreadMigrationPayload.Type;

const ServerLifecycleStreamWelcomeEvent = Schema.Struct({
  version: Schema.Literal(1),
  sequence: NonNegativeInt,
  type: Schema.Literal("welcome"),
  payload: ServerLifecycleWelcomePayload,
});
type ServerLifecycleStreamWelcomeEvent = typeof ServerLifecycleStreamWelcomeEvent.Type;

export const ServerLifecycleStreamReadyEvent = Schema.Struct({
  version: Schema.Literal(1),
  sequence: NonNegativeInt,
  type: Schema.Literal("ready"),
  payload: ServerLifecycleReadyPayload,
});
export type ServerLifecycleStreamReadyEvent = typeof ServerLifecycleStreamReadyEvent.Type;

const ServerLifecycleStreamLegacyThreadMigrationEvent = Schema.Struct({
  version: Schema.Literal(1),
  sequence: NonNegativeInt,
  type: Schema.Literal("legacyThreadMigration"),
  payload: ServerLifecycleLegacyThreadMigrationPayload,
});
type ServerLifecycleStreamLegacyThreadMigrationEvent =
  typeof ServerLifecycleStreamLegacyThreadMigrationEvent.Type;

export const ServerLifecycleStreamEvent = Schema.Union([
  ServerLifecycleStreamWelcomeEvent,
  ServerLifecycleStreamReadyEvent,
  ServerLifecycleStreamLegacyThreadMigrationEvent,
]);
export type ServerLifecycleStreamEvent = typeof ServerLifecycleStreamEvent.Type;

export const ServerProviderUpdatedPayload = Schema.Struct({
  providers: ServerProviders,
});
export type ServerProviderUpdatedPayload = typeof ServerProviderUpdatedPayload.Type;

export const ServerProviderUpdateInput = Schema.Struct({
  provider: ProviderDriverKind,
  targetVersion: Schema.optionalKey(TrimmedNonEmptyString),
  instanceId: Schema.optionalKey(ProviderInstanceId),
});
export type ServerProviderUpdateInput = typeof ServerProviderUpdateInput.Type;

export class ServerProviderUpdateError extends Schema.TaggedError<ServerProviderUpdateError>()(
  "ServerProviderUpdateError",
  {
    provider: ProviderDriverKind,
    reason: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Provider update failed for ${this.provider}: ${this.reason}`;
  }
}

export const ServerNpmReleaseInput = Schema.Struct({
  spec: Schema.String.check(
    Schema.isMaxLength(64),
    Schema.isPattern(/^(?:latest|nightly|\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/),
  ),
});
export type ServerNpmReleaseInput = typeof ServerNpmReleaseInput.Type;

export const ServerNpmRelease = Schema.Struct({
  version: Schema.String,
  databaseMigration: Schema.optionalKey(Schema.Int),
});
export type ServerNpmRelease = typeof ServerNpmRelease.Type;

export class ServerNpmReleaseError extends Schema.TaggedError<ServerNpmReleaseError>()(
  "ServerNpmReleaseError",
  { reason: Schema.String },
) {
  override get message(): string {
    return `Could not check the configured npm registry: ${this.reason}`;
  }
}

export const ServerSelfUpdateInput = Schema.Struct({
  /** Exact npm version, never a dist-tag, so server and client agree on the request. */
  targetVersion: TrimmedNonEmptyString,
  /** Desktop-managed hosts move their app to this update track first. Sent only for a track switch. */
  channel: Schema.optionalKey(DesktopUpdateChannelSchema),
  /** The target release's highest migration; the host refuses to leave Nightly without it. */
  targetDatabaseMigration: Schema.optionalKey(Schema.Int),
});
export type ServerSelfUpdateInput = typeof ServerSelfUpdateInput.Type;

export const ServerSelfUpdateResult = Schema.Struct({
  targetVersion: TrimmedNonEmptyString,
  method: ServerSelfUpdateMethod,
  updateId: Schema.optionalKey(TrimmedNonEmptyString),
  desktopUpdateToken: Schema.optionalKey(TrimmedNonEmptyString),
});
export type ServerSelfUpdateResult = typeof ServerSelfUpdateResult.Type;

export const DesktopUpdateCommitInput = Schema.Struct({
  requestId: TrimmedNonEmptyString,
});
export type DesktopUpdateCommitInput = typeof DesktopUpdateCommitInput.Type;

export const ServerSelfUpdateProgressStage = Schema.Literals(["downloading", "installing"]);
export type ServerSelfUpdateProgressStage = typeof ServerSelfUpdateProgressStage.Type;

export const ServerSelfUpdateProgressEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("progress"),
    stage: ServerSelfUpdateProgressStage,
  }),
  Schema.Struct({
    type: Schema.Literal("complete"),
    result: ServerSelfUpdateResult,
  }),
]);
export type ServerSelfUpdateProgressEvent = typeof ServerSelfUpdateProgressEvent.Type;

export class ServerSelfUpdateError extends Schema.TaggedError<ServerSelfUpdateError>()(
  "ServerSelfUpdateError",
  {
    reason: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Server update failed: ${this.reason}`;
  }
}
