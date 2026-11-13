import {
  EasDeviceHostConfigs,
  SimlockDeviceHostConfigs,
  SshDeviceHostConfigs,
} from "./device.ts";
import {
  AuthOrchestrationOperateScope,
  AuthSettingsWriteScope,
  AuthProvidersManageScope,
  type AuthEnvironmentScope,
} from "./auth.ts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  ProjectId,
  TrimmedNonEmptyString,
  TrimmedString,
} from "./baseSchemas.ts";
import { UsageLimitSourceId } from "./usageLimitSourceId.ts";
import { SecretProviderId } from "./secretReference.ts";
import {
  EnvironmentMachineKind,
  ThreadEnvMode,
  WorktreeSubmodules,
} from "./environment.ts";
import { ProviderOptionSelections } from "./model.ts";
import { ModelSelection } from "./modelSelection.ts";
import { ProjectScript, type ProjectMutation } from "./project.ts";
import { RuntimeMode } from "./providerPolicy.ts";
import { BrowserProfile, BrowserProfileId } from "./browserProfile.ts";
import {
  BrowserRecordingFrameRate,
  PreviewAppearancePreference,
  PreviewViewportSetting,
  PreviewZoomFactor,
} from "./preview.ts";
import {
  ProviderInstanceConfig,
  ProviderInstanceId,
  ProviderDriverKind,
} from "./providerInstance.ts";
import { PullRequestMergeMethod } from "./pullRequest.ts";
import type { ModelPreferences } from "./settingsPart2.ts";
import type { ClientSettings } from "./settingsPart3.ts";
import { AppearanceContrast, BrowserCustomSearchUrl, BrowserLinkTarget, BrowserSearchEngine, ChatWidth, CodeFontSize, DiffColorScheme, DiffLayout, EffortDisplay, EnvironmentIdentificationMode, FontFamilyPreference, GlassOpacity, InterfaceFontSize, LoadBalancingWeights, ModelFavorite, ModelFavorites, NotificationMode, PanelAnimationDurationMs, PromptFontSize, ProviderModelPreferences, QuitConfirmationMode, SidebarAutoSettleAfterDays, SidebarProjectGroupingMode, SidebarProjectSortOrder, SidebarThreadSortOrder, SnapShotShortcut, SnapShotSound, SnoozePresetSettings, TerminalFontSize, TimestampFormat } from "./settingsPart2.ts";
import { BackgroundActivityProfile, BranchNamingMode, ClaudeSettings, DEFAULT_CLIENT_SETTINGS, IdleCompactionMode, LegacyCompactIdleThreads, SecretProviderConfigWrite, SourceControlHostSettings, SourceControlWritingStyleMode, SourceControlWritingStyleSettings, UsageLimitSourceConfig, UsageModelPriceOverride } from "./settingsPart3.ts";
import { BackgroundActivityOverrides, BackgroundActivityProfileSelection, DEFAULT_SERVER_SETTINGS, ProjectSettingsOverrides, ResponseStreamingMode, ServerSettings, SettledWorktreeRetentionDays, StorageRetentionDays, WorktreeKeepWhen, keepUnknownOverrideKeys, providerInstanceConfigEnabledFlag } from "./settingsPart4.ts";
export type {
  ModelPreferences,
  SnapShotModifierPairShortcut,
} from "./settingsPart2.ts";
export type {
  BranchNamingOptions,
  ClientSettings,
  ProviderSettingsFormAnnotation,
  ProviderSettingsFormControl,
  ProviderSettingsFormOption,
  ProviderSettingsFormSchemaAnnotation,
  ProviderSettingsOrder,
} from "./settingsPart3.ts";
export type { ProjectScopedServerSettingKey } from "./settingsPart4.ts";
export {
  AppearanceContrast,
  BROWSER_CUSTOM_SEARCH_URL_MAX_LENGTH,
  BrowserLinkTarget,
  BrowserSearchEngine,
  ChatWidth,
  CodeFontSize,
  DEFAULT_BROWSER_AUTO_SHOW_FLOATING_PREVIEW,
  DEFAULT_BROWSER_LINK_TARGET,
  DEFAULT_BROWSER_SEARCH_ENGINE,
  DEFAULT_BROWSER_VIEWPORT,
  DEFAULT_CODE_FONT_SIZE,
  DEFAULT_ENVIRONMENT_IDENTIFICATION_MODE,
  DEFAULT_INTERFACE_FONT_SIZE,
  DEFAULT_PROMPT_FONT_SIZE,
  DEFAULT_SIDEBAR_PROJECT_SORT_ORDER,
  DEFAULT_SNOOZE_PRESETS,
  DiffLayout,
  EffortDisplay,
  EnvironmentIdentificationMode,
  GlassOpacity,
  InterfaceFontSize,
  MAX_APPEARANCE_CONTRAST,
  MAX_CODE_FONT_SIZE,
  MAX_GLASS_OPACITY,
  MAX_INTERFACE_FONT_SIZE,
  MAX_PANEL_ANIMATION_DURATION_MS,
  MAX_PROMPT_FONT_SIZE,
  MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS,
  MAX_SNOOZE_PRESETS,
  MAX_SNOOZE_PRESET_MINUTES,
  MAX_TERMINAL_FONT_SIZE,
  MIN_APPEARANCE_CONTRAST,
  MIN_CODE_FONT_SIZE,
  MIN_GLASS_OPACITY,
  MIN_INTERFACE_FONT_SIZE,
  MIN_PANEL_ANIMATION_DURATION_MS,
  MIN_PROMPT_FONT_SIZE,
  MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS,
  MIN_TERMINAL_FONT_SIZE,
  PanelAnimationDurationMs,
  PromptFontSize,
  QuitConfirmationMode,
  SNAP_SHOT_MODIFIERS,
  SidebarAutoSettleAfterDays,
  SidebarProjectGroupingMode,
  SidebarProjectSortOrder,
  SidebarThreadSortOrder,
  SnapShotKeyChord,
  SnapShotModifier,
  SnapShotShortcut,
  SnapShotSound,
  SnoozePresetDay,
  SnoozePresetSetting,
  TerminalFontSize,
  TimestampFormat,
  isModifierPairShortcut,
  snapShotModifierPairLabel,
  snapShotShortcutModifierPair,
} from "./settingsPart2.ts";
export {
  ANTIGRAVITY_AUTH_METHODS,
  AntigravityAuthMethod,
  AntigravitySettings,
  BackgroundActivityProfile,
  BranchNamingMode,
  ClaudeSettings,
  ClientSettingsSchema,
  CodexSettings,
  DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL,
  DEFAULT_BACKGROUND_ACTIVITY_PROFILE,
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL,
  IDLE_COMPACTION_MODES,
  IdleCompactionMode,
  SecretProviderConfig,
  SecretProviderKind,
  SecretProviderLabel,
  SourceControlWritingStyleMode,
  SourceControlWritingStyleSettings,
  UsageLimitSourceConfig,
  UsageModelPriceOverride,
  isSecretSetting,
  makeBinaryPathSetting,
  makeProviderSettingsSchema,
  secretSetting,
  secretSettingsFields,
} from "./settingsPart3.ts";
export {
  BackgroundActivityProfileSelection,
  BackgroundActivitySettings,
  DATABASE_COMPACTION_RECOMMENDED_BYTES,
  DEFAULT_SERVER_SETTINGS,
  DatabaseStorageStatus,
  PROJECT_SCOPED_SERVER_SETTING_KEYS,
  ProjectSettingsOverrides,
  ResponseStreamingMode,
  ServerSettings,
  StorageCleanupReport,
  StorageCleanupReportEntry,
  StorageCleanupSettings,
  WorktreeCleanupRules,
  WorktreeKeepWhen,
  isNullableProjectSettingsOverride,
  keepUnknownOverrideKeys,
  providerInstanceConfigEnabledFlag,
  shouldRecommendDatabaseCompaction,
} from "./settingsPart4.ts";

// Must match each driver's enabled decoding default.
const DEFAULT_DISABLED_PROVIDER_DRIVERS: ReadonlySet<ProviderDriverKind> = new Set(
  ["cursor", "grok", "fx", "kiro", "muse", "pi", "opencode", "antigravity"].map((driver) =>
    ProviderDriverKind.make(driver),
  ),
);

const DEFAULT_ENABLED_DEFAULT_INSTANCES: ReadonlySet<ProviderInstanceId> = new Set(
  ["codex", "claudeAgent"].map((instanceId) => ProviderInstanceId.make(instanceId)),
);

export const isUnconfiguredDefaultInstanceEnabled = (instanceId: ProviderInstanceId): boolean =>
  DEFAULT_ENABLED_DEFAULT_INSTANCES.has(instanceId);

const defaultEnabledForDriver = (driver: ProviderDriverKind): boolean =>
  !DEFAULT_DISABLED_PROVIDER_DRIVERS.has(driver);

export const resolveProviderInstanceEnabled = (
  instance: Pick<ProviderInstanceConfig, "driver" | "enabled" | "config">,
): boolean => {
  const configEnabled = providerInstanceConfigEnabledFlag(instance.config);
  if (instance.enabled === false || configEnabled === false) {
    return false;
  }
  return instance.enabled ?? configEnabled ?? defaultEnabledForDriver(instance.driver);
};

export const resolveProjectProviderInstanceEnabled = (
  settings: Pick<ServerSettings, "providerInstances" | "projectSettingsOverrides">,
  projectId: ProjectId | null,
  instanceId: ProviderInstanceId,
): boolean => {
  const override =
    projectId === null
      ? undefined
      : settings.projectSettingsOverrides[projectId]?.providerInstances?.[instanceId]?.enabled;
  if (override !== undefined) return override;
  const instanceConfig = Object.hasOwn(settings.providerInstances, instanceId)
    ? settings.providerInstances[instanceId]
    : undefined;
  return instanceConfig !== undefined
    ? resolveProviderInstanceEnabled(instanceConfig)
    : isUnconfiguredDefaultInstanceEnabled(instanceId);
};

const decodeClaudeSettings = Schema.decodeUnknownOption(ClaudeSettings);

type IdleCompactionSettings = Pick<ServerSettings, "compactIdleThreads" | "idleCompaction">;

/** The environment-wide idle compaction mode, from whichever field the settings carry. */
export const globalIdleCompaction = (settings: IdleCompactionSettings): IdleCompactionMode =>
  settings.idleCompaction ??
  (typeof settings.compactIdleThreads === "string"
    ? settings.compactIdleThreads
    : settings.compactIdleThreads
      ? "beforeCacheExpires"
      : "onReturn");

/** Sets the mode, and the legacy switch shipped clients still read alongside it. */
export const withIdleCompaction = <S extends IdleCompactionSettings>(
  settings: S,
  mode: IdleCompactionMode,
): S => ({ ...settings, idleCompaction: mode, compactIdleThreads: mode === "beforeCacheExpires" });

/** Whether a server reads modes, rather than only the boolean switch from before them. */
export const readsIdleCompactionModes = (settings: IdleCompactionSettings) =>
  settings.idleCompaction !== undefined || typeof settings.compactIdleThreads === "string";

/**
 * The patch that sets `mode` in the form the server's settings show it reads:
 * the mode for a server that has `idleCompaction` or kept the mode in the legacy
 * field, the boolean switch for a server from before modes.
 */
export const idleCompactionPatch = (settings: IdleCompactionSettings, mode: IdleCompactionMode) =>
  settings.idleCompaction !== undefined
    ? { idleCompaction: mode }
    : readsIdleCompactionModes(settings)
      ? { compactIdleThreads: mode }
      : { compactIdleThreads: mode === "beforeCacheExpires" };

export const resolveIdleCompaction = (
  settings: Pick<ServerSettings, "providerInstances" | "compactIdleThreads" | "idleCompaction">,
  instanceId: ProviderInstanceId,
): IdleCompactionMode => {
  const instance = Object.hasOwn(settings.providerInstances, instanceId)
    ? settings.providerInstances[instanceId]
    : undefined;
  const override = decodeClaudeSettings(instance?.config ?? {}).pipe(
    Option.map((config) => config.idleCompaction),
    Option.getOrElse(() => "default" as const),
  );
  return override === "default" ? globalIdleCompaction(settings) : override;
};

const ServerSettingsOperation = Schema.Literals([
  "normalize",
  "check-exists",
  "create-provider-instance",
  "read-file",
  "read-provider-history",
  "read-project-settings",
  "read-secret",
  "remove-secret",
  "remove-stale-secret",
  "write-secret",
  "write-secret-provider",
  "write-file",
  "prepare-directory",
  "write-managed-setting",
  "use-disallowed-provider",
]);
type ServerSettingsOperation = typeof ServerSettingsOperation.Type;

/** Why a provider the administrator's policy leaves out cannot be used. */
export const disallowedProviderMessage = (organization: string | undefined, label: string) =>
  `${organization === undefined ? "Your organization" : `${organization}'s`} policy does not allow the ${label} provider.`;

export class ServerSettingsError extends Schema.TaggedError<ServerSettingsError>()(
  "ServerSettingsError",
  {
    settingsPath: Schema.String,
    operation: ServerSettingsOperation,
    providerInstanceId: Schema.optional(Schema.String),
    environmentVariable: Schema.optional(Schema.String),
    /** For `write-managed-setting`: the locked dot path and who manages it. */
    managedSetting: Schema.optional(Schema.String),
    managedBy: Schema.optional(Schema.String),
    /** For `use-disallowed-provider`: the provider's name as users know it. */
    providerLabel: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    if (this.operation === "write-managed-setting") {
      return `${this.managedSetting ?? "This setting"} is managed by ${this.managedBy ?? "your organization"} and cannot be changed.`;
    }
    if (this.operation === "use-disallowed-provider") {
      return disallowedProviderMessage(
        this.managedBy,
        this.providerLabel ?? this.providerInstanceId ?? "this",
      );
    }
    const provider =
      this.providerInstanceId === undefined ? "" : ` for provider ${this.providerInstanceId}`;
    const variable =
      this.environmentVariable === undefined
        ? ""
        : ` and environment variable ${this.environmentVariable}`;
    return `Server settings ${this.operation} failed${provider}${variable} at ${this.settingsPath}.`;
  }
}

export type UnifiedSettings = Omit<ServerSettings, keyof ModelPreferences> & ClientSettings;

export const DEFAULT_UNIFIED_SETTINGS: UnifiedSettings = {
  ...DEFAULT_SERVER_SETTINGS,
  ...DEFAULT_CLIENT_SETTINGS,
};

const ModelSelectionPatch = Schema.Struct({
  instanceId: Schema.optionalKey(ProviderInstanceId),
  model: Schema.optionalKey(TrimmedNonEmptyString),
  options: Schema.optionalKey(ProviderOptionSelections),
});

export const ServerSettingsPatch = Schema.Struct({
  setModelFavorites: Schema.optionalKey(
    Schema.Array(Schema.Struct({ ...ModelFavorite.fields, favorite: Schema.Boolean })),
  ),
  setModelsHidden: Schema.optionalKey(
    Schema.Array(Schema.Struct({ ...ModelFavorite.fields, hidden: Schema.Boolean })),
  ),
  setProviderModelOrder: Schema.optionalKey(
    Schema.Struct({ provider: ProviderInstanceId, modelOrder: Schema.Array(TrimmedString) }),
  ),
  favorites: Schema.optionalKey(ModelFavorites),
  providerModelPreferences: Schema.optionalKey(ProviderModelPreferences),
  // Applied under the settings service's write lock, only while still unset.
  migrateModelPreferences: Schema.optionalKey(
    Schema.Struct({
      favorites: Schema.optionalKey(ModelFavorites),
      providerModelPreferences: Schema.optionalKey(ProviderModelPreferences),
    }),
  ),
  worktreeCleanup: Schema.optionalKey(
    Schema.NullOr(
      Schema.Union([
        Schema.Struct({ mode: Schema.Literal("off") }),
        Schema.Struct({
          mode: Schema.Literal("custom"),
          rules: Schema.Struct({
            worktreeKeepWhen: Schema.optionalKey(WorktreeKeepWhen),
            worktreeAfterDays: Schema.optionalKey(StorageRetentionDays),
            worktreeSettledAfterDays: Schema.optionalKey(SettledWorktreeRetentionDays),
            worktreeOnMerge: Schema.optionalKey(Schema.Boolean),
            worktreeOnDelete: Schema.optionalKey(Schema.Boolean),
            worktreeUnchanged: Schema.optionalKey(Schema.Boolean),
          }),
        }),
      ]),
    ),
  ),
  storageCleanup: Schema.optionalKey(
    Schema.Struct({
      worktreeKeepWhen: Schema.optionalKey(WorktreeKeepWhen),
      worktreeAfterDays: Schema.optionalKey(StorageRetentionDays),
      worktreeSettledAfterDays: Schema.optionalKey(SettledWorktreeRetentionDays),
      worktreeOnMerge: Schema.optionalKey(Schema.Boolean),
      worktreeOnDelete: Schema.optionalKey(Schema.Boolean),
      worktreeUnchanged: Schema.optionalKey(Schema.Boolean),
      browserArtifactsAfterDays: Schema.optionalKey(StorageRetentionDays),
      logsAfterDays: Schema.optionalKey(StorageRetentionDays),
    }),
  ),
  worktreesDirectory: Schema.optionalKey(TrimmedString),
  responseStreamingMode: Schema.optionalKey(ResponseStreamingMode),
  enableProviderUpdateChecks: Schema.optionalKey(Schema.Boolean),
  continueThreadsAfterServerUpdate: Schema.optionalKey(Schema.Boolean),
  enableAgentBrowserAccess: Schema.optionalKey(Schema.Boolean),
  projectAgentBrowserAccessOverrides: Schema.optionalKey(
    Schema.Record(ProjectId, Schema.NullOr(Schema.Boolean)),
  ),
  defaultAutoPull: Schema.optionalKey(Schema.Boolean),
  defaultProjectScripts: Schema.optionalKey(Schema.Array(ProjectScript)),
  projectScriptOverrides: Schema.optionalKey(
    Schema.Record(ProjectId, Schema.NullOr(Schema.Array(ProjectScript))),
  ),
  projectAutoPullOverrides: Schema.optionalKey(
    Schema.Record(ProjectId, Schema.NullOr(Schema.Boolean)),
  ),
  defaultModelSelection: Schema.optionalKey(Schema.NullOr(ModelSelection)),
  defaultRuntimeMode: Schema.optionalKey(RuntimeMode),
  fallbackModelSelection: Schema.optionalKey(Schema.NullOr(ModelSelection)),
  /** Replaces each project's override set; null removes it. Omitted providerInstances retains its stored value. */
  projectSettingsOverrides: Schema.optionalKey(
    Schema.Record(
      ProjectId,
      Schema.NullOr(
        keepUnknownOverrideKeys(
          Schema.Struct({
            ...ProjectSettingsOverrides.fields,
            sourceControlWritingStyle: Schema.optionalKey(SourceControlWritingStyleSettings),
          }),
        ),
      ),
    ),
  ),
  enableAgentDeviceAccess: Schema.optionalKey(Schema.Boolean),
  enableDeviceSupport: Schema.optionalKey(Schema.Boolean),
  deviceOnboardingCompleted: Schema.optionalKey(Schema.Boolean),
  deviceHosts: Schema.optionalKey(SshDeviceHostConfigs),
  easDeviceHosts: Schema.optionalKey(EasDeviceHostConfigs),
  simlockDeviceHosts: Schema.optionalKey(SimlockDeviceHostConfigs),
  simlockDeviceHostsEnabled: Schema.optionalKey(Schema.Boolean),
  sidebarAutoSettleAfterDays: Schema.optionalKey(Schema.NullOr(SidebarAutoSettleAfterDays)),
  compactIdleThreads: Schema.optionalKey(LegacyCompactIdleThreads),
  idleCompaction: Schema.optionalKey(IdleCompactionMode),
  sidebarAutoSettleKeepPullRequests: Schema.optionalKey(Schema.Boolean),
  sidebarAutoSettleOnMerge: Schema.optionalKey(Schema.Boolean),
  autoResumeLimitedThreads: Schema.optionalKey(Schema.Boolean),
  snoozeLimitedThreads: Schema.optionalKey(Schema.Boolean),
  snoozePresets: Schema.optionalKey(SnoozePresetSettings),
  hiddenThreadTags: Schema.optionalKey(Schema.Array(Schema.String)),
  hideTaggedThreads: Schema.optionalKey(Schema.Boolean),
  guestSharingEnabled: Schema.optionalKey(Schema.Boolean),
  linkedEnvironmentsEnabled: Schema.optionalKey(Schema.Boolean),
  backgroundActivity: Schema.optionalKey(
    Schema.Struct({
      schemaVersion: Schema.optionalKey(Schema.Literal(1)),
      profile: Schema.optionalKey(BackgroundActivityProfileSelection),
      baseProfile: Schema.optionalKey(BackgroundActivityProfile),
      overrides: Schema.optionalKey(BackgroundActivityOverrides),
    }),
  ),
  automaticGitFetchInterval: Schema.optionalKey(Schema.DurationFromMillis),
  providerHealthRefreshInterval: Schema.optionalKey(Schema.DurationFromMillis),
  backgroundActivityProfile: Schema.optionalKey(BackgroundActivityProfile),
  environmentIcon: Schema.optionalKey(Schema.NullOr(EnvironmentMachineKind)),
  defaultThreadEnvMode: Schema.optionalKey(Schema.NullOr(ThreadEnvMode)),
  newWorktreesStartFromOrigin: Schema.optionalKey(Schema.Boolean),
  worktreeSubmodules: Schema.optionalKey(Schema.NullOr(WorktreeSubmodules)),
  addProjectBaseDirectory: Schema.optionalKey(TrimmedString),
  textGenerationModelSelection: Schema.optionalKey(ModelSelectionPatch),
  threadTitleInstructions: Schema.optionalKey(TrimmedString),
  branchNamingMode: Schema.optionalKey(BranchNamingMode),
  branchNamePrefix: Schema.optionalKey(TrimmedString),
  branchNameInstructions: Schema.optionalKey(TrimmedString),
  removeAgentCreditsOnMerge: Schema.optionalKey(Schema.Boolean),
  sourceControlWritingStyle: Schema.optionalKey(
    Schema.Struct({
      mode: Schema.optionalKey(SourceControlWritingStyleMode),
      customInstructions: Schema.optionalKey(TrimmedString),
      followChangeRequestTemplates: Schema.optionalKey(Schema.Boolean),
    }),
  ),
  sourceControlWriterModelSelection: Schema.optionalKey(Schema.NullOr(ModelSelection)),
  reviewGuidesEnabled: Schema.optionalKey(Schema.Boolean),
  reviewGuideModelSelection: Schema.optionalKey(Schema.NullOr(ModelSelection)),
  reviewGuideInstructions: Schema.optionalKey(TrimmedString),
  pullRequestMergeMethod: Schema.optionalKey(Schema.NullOr(PullRequestMergeMethod)),
  observability: Schema.optionalKey(
    Schema.Struct({
      otlpTracesUrl: Schema.optionalKey(TrimmedString),
      otlpMetricsUrl: Schema.optionalKey(TrimmedString),
      otlpLogsUrl: Schema.optionalKey(TrimmedString),
    }),
  ),
  /** Merges per host, replacing patched fields whole; redaction markers retain secrets, empty secrets remove them. A non-empty token map keeps the saved tokens of hosts it omits; an empty map clears them all. */
  sourceControlHosts: Schema.optionalKey(Schema.Record(Schema.String, SourceControlHostSettings)),
  // Replace whole maps to avoid half-merged driver configs.
  providerInstances: Schema.optionalKey(Schema.Record(ProviderInstanceId, ProviderInstanceConfig)),
  // Merge per source to avoid racing other edits; null removes an entry.
  usageLimitSources: Schema.optionalKey(
    Schema.Record(UsageLimitSourceId, Schema.NullOr(UsageLimitSourceConfig)),
  ),
  secretProviders: Schema.optionalKey(
    Schema.Record(SecretProviderId, Schema.NullOr(SecretProviderConfigWrite)),
  ),
  cursorKeychainUsageEnabled: Schema.optionalKey(Schema.Boolean),

  usagePriceOverrides: Schema.optionalKey(
    Schema.Record(TrimmedNonEmptyString, Schema.NullOr(UsageModelPriceOverride)),
  ),

  usageModelAliases: Schema.optionalKey(
    Schema.Record(TrimmedNonEmptyString, Schema.NullOr(TrimmedNonEmptyString)),
  ),
});
export type ServerSettingsPatch = typeof ServerSettingsPatch.Type;

export function requiredScopesForServerSettingsPatch(
  patch: ServerSettingsPatch,
): ReadonlyArray<AuthEnvironmentScope> {
  let changesProviders = false;
  let changesSettings = false;
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (
      key === "providers" ||
      key === "providerInstances" ||
      key === "usageLimitSources" ||
      key === "secretProviders"
    ) {
      changesProviders = true;
    } else {
      changesSettings = true;
    }
  }
  return [
    ...(changesSettings || !changesProviders ? [AuthSettingsWriteScope] : []),
    ...(changesProviders ? [AuthProvidersManageScope] : []),
  ];
}

/** Host-executed project scripts require settings-write authority in addition to orchestration:operate. */
export function requiredScopesForProjectMutation(
  mutation: ProjectMutation,
): ReadonlyArray<AuthEnvironmentScope> {
  if (mutation.type === "project.delete" || mutation.scripts === undefined) {
    return [AuthOrchestrationOperateScope];
  }
  return [
    AuthOrchestrationOperateScope,
    ...requiredScopesForServerSettingsPatch({ defaultProjectScripts: mutation.scripts }),
  ];
}

export const ClientSettingsPatch = Schema.Struct({
  notificationMode: Schema.optionalKey(NotificationMode),
  inAppNotificationsEnabled: Schema.optionalKey(Schema.Boolean),
  diffColorScheme: Schema.optionalKey(DiffColorScheme),
  chatWidth: Schema.optionalKey(ChatWidth),
  effortDisplay: Schema.optionalKey(EffortDisplay),
  loadBalancingEnabled: Schema.optionalKey(Schema.Boolean),
  loadBalancingWeights: Schema.optionalKey(LoadBalancingWeights),
  appearanceContrast: Schema.optionalKey(AppearanceContrast),
  panelAnimationDurationMs: Schema.optionalKey(PanelAnimationDurationMs),
  browserDefaultViewport: Schema.optionalKey(PreviewViewportSetting),
  browserDefaultZoomFactor: Schema.optionalKey(PreviewZoomFactor),
  browserDefaultAppearance: Schema.optionalKey(PreviewAppearancePreference),
  browserRecordingFrameRate: Schema.optionalKey(BrowserRecordingFrameRate),
  browserRecordingShowKeyPresses: Schema.optionalKey(Schema.Boolean),
  browserRecordingShowMousePresses: Schema.optionalKey(Schema.Boolean),
  browserLinkTarget: Schema.optionalKey(BrowserLinkTarget),
  browserSearchEngine: Schema.optionalKey(BrowserSearchEngine),
  browserCustomSearchUrl: Schema.optionalKey(BrowserCustomSearchUrl),
  browserAutoShowFloatingPreview: Schema.optionalKey(Schema.Boolean),
  browserProfiles: Schema.optionalKey(Schema.Array(BrowserProfile)),
  browserDefaultProfileId: Schema.optionalKey(BrowserProfileId),
  confirmQuit: Schema.optionalKey(QuitConfirmationMode),
  confirmThreadArchive: Schema.optionalKey(Schema.Boolean),
  confirmThreadDelete: Schema.optionalKey(Schema.Boolean),
  confirmThreadUnpin: Schema.optionalKey(Schema.Boolean),
  diffFilesCollapsed: Schema.optionalKey(Schema.Boolean),
  diffIgnoreWhitespace: Schema.optionalKey(Schema.Boolean),
  diffLayout: Schema.optionalKey(DiffLayout),
  environmentIdentificationMode: Schema.optionalKey(EnvironmentIdentificationMode),
  glassOpacity: Schema.optionalKey(GlassOpacity),
  onboardingCompletedAt: Schema.optionalKey(Schema.NullOr(Schema.String)),
  fontSizeInterface: Schema.optionalKey(InterfaceFontSize),
  fontSizePrompt: Schema.optionalKey(PromptFontSize),
  fontSizeCode: Schema.optionalKey(CodeFontSize),
  fontSizeTerminal: Schema.optionalKey(TerminalFontSize),
  fontFamilyCode: Schema.optionalKey(FontFamilyPreference),
  fontFamilyComposer: Schema.optionalKey(FontFamilyPreference),
  fontFamilySans: Schema.optionalKey(FontFamilyPreference),
  fontFamilyTerminal: Schema.optionalKey(FontFamilyPreference),
  fontSmoothing: Schema.optionalKey(Schema.Boolean),
  persistComposerContextStrip: Schema.optionalKey(Schema.Boolean),
  favorites: Schema.optionalKey(ModelFavorites),
  providerModelPreferences: Schema.optionalKey(ProviderModelPreferences),
  pullRequestMergeMethodOverrides: Schema.optionalKey(
    Schema.Record(TrimmedNonEmptyString, PullRequestMergeMethod),
  ),
  pullRequestLinksOpenInApp: Schema.optionalKey(Schema.Boolean),
  planModeEnabled: Schema.optionalKey(Schema.Boolean),
  contextWindowMeterEnabled: Schema.optionalKey(Schema.Boolean),
  composerRichTextEnabled: Schema.optionalKey(Schema.Boolean),
  sendShortcut: Schema.optionalKey(Schema.Literals(["enter", "mod-enter-multiline", "mod-enter"])),
  followUpBehavior: Schema.optionalKey(Schema.Literals(["queue", "steer"])),
  proactivePanelsEnabled: Schema.optionalKey(Schema.Boolean),
  showSkillsInSlashMenu: Schema.optionalKey(Schema.Boolean),
  boringSidebarEnabled: Schema.optionalKey(Schema.Boolean),
  boringSidebarMultilineRows: Schema.optionalKey(Schema.Boolean),
  threadDetailsUsageEnabled: Schema.optionalKey(Schema.Boolean),
  threadDetailsItems: Schema.optionalKey(Schema.Record(Schema.String, Schema.Boolean)),
  legacySidebarEnabled: Schema.optionalKey(Schema.Boolean),
  sidebarWorkingShelfEnabled: Schema.optionalKey(Schema.Boolean),
  sidebarProjectGroupingMode: Schema.optionalKey(SidebarProjectGroupingMode),
  sidebarProjectGroupingOverrides: Schema.optionalKey(
    Schema.Record(TrimmedNonEmptyString, SidebarProjectGroupingMode),
  ),
  sidebarProjectSortOrder: Schema.optionalKey(SidebarProjectSortOrder),
  sidebarThreadSortOrder: Schema.optionalKey(SidebarThreadSortOrder),
  timestampFormat: Schema.optionalKey(TimestampFormat),
  snapShotEnabled: Schema.optionalKey(Schema.Boolean),
  snapShotIncludeAccessibility: Schema.optionalKey(Schema.Boolean),
  snapShotShortcut: Schema.optionalKey(SnapShotShortcut),
  snapShotPlaySound: Schema.optionalKey(Schema.Boolean),
  snapShotSound: Schema.optionalKey(SnapShotSound),
  snapShotFlash: Schema.optionalKey(Schema.Boolean),
  snapShotAnimations: Schema.optionalKey(Schema.Boolean),
  wordWrap: Schema.optionalKey(Schema.Boolean),
  mathRenderingEnabled: Schema.optionalKey(Schema.Boolean),
});
export type ClientSettingsPatch = typeof ClientSettingsPatch.Type;
export {
  BROWSER_RECORDING_FRAME_RATES,
  BrowserRecordingFrameRate,
  DEFAULT_BROWSER_RECORDING_FRAME_RATE,
} from "./preview.ts";
