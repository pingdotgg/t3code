import { Effect } from "effect";
import { SshDeviceHostConfigs } from "./device.ts";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { ProjectId, TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";
import {
  DEFAULT_GIT_TEXT_GENERATION_MODEL,
  DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_DRIVER_KIND,
  ProviderOptionSelections,
} from "./model.ts";
import { ModelSelection, ProjectScript } from "./orchestration.ts";
import { BrowserProfile, BrowserProfileId, DEFAULT_BROWSER_PROFILE_ID } from "./browserProfile.ts";
import {
  defaultInstanceIdForDriver,
  ProviderInstanceConfig,
  ProviderInstanceId,
} from "./providerInstance.ts";
import { AgentWorkflowDestinationMode, ReviewChangesScope } from "./agentWorkflows.ts";
import { CollaborativeAcceptancePolicy } from "./collaborativeAcceptance.ts";
import { AgentWorkflowSettings, CustomAgentWorkflowAutomationSettings } from "./workflowRuntime.ts";
import { PullRequestListState } from "./pullRequest.ts";
import { ThreadEnvMode, EnvironmentMachineKind } from "./environment.ts";
import {
  DEFAULT_PREVIEW_APPEARANCE,
  DEFAULT_PREVIEW_ZOOM_FACTOR,
  FILL_PREVIEW_VIEWPORT,
  PreviewAppearancePreference,
  PreviewViewportSetting,
  PreviewZoomFactor,
} from "./preview.ts";

// ── Client Settings (local-only) ───────────────────────────────

export const TimestampFormat = Schema.Literals(["locale", "12-hour", "24-hour"]);
export type TimestampFormat = typeof TimestampFormat.Type;
export const DEFAULT_TIMESTAMP_FORMAT: TimestampFormat = "locale";

export const UiFont = Schema.Literals(["dm-sans", "geist", "system-ui"]);
export type UiFont = typeof UiFont.Type;
export const DEFAULT_UI_FONT: UiFont = "dm-sans";

export const CodeFont = Schema.Literals(["system-mono", "sf-mono", "menlo", "jetbrains-mono"]);
export type CodeFont = typeof CodeFont.Type;
export const DEFAULT_CODE_FONT: CodeFont = "system-mono";

export const FontSize = Schema.Int.check(Schema.isGreaterThanOrEqualTo(6)).check(
  Schema.isLessThanOrEqualTo(24),
);
export type FontSize = typeof FontSize.Type;
export const DEFAULT_CODE_FONT_SIZE: FontSize = 12 as FontSize;
export const DEFAULT_CHAT_FONT_SIZE: FontSize = 14 as FontSize;
export const DEFAULT_STATUS_LINE_FONT_SIZE: FontSize = 14 as FontSize;
export const DEFAULT_TOOL_FONT_SIZE: FontSize = 12 as FontSize;
export const DEFAULT_SIDEBAR_FONT_SIZE: FontSize = 11 as FontSize;
/** Sidebar metadata (project, worktree, branch, PR, timestamps) sits a deliberate step
    below the thread title so the title stays the row's anchor. */
export const DEFAULT_SIDEBAR_META_FONT_SIZE: FontSize = 10 as FontSize;
export const DEFAULT_INPUT_FONT_SIZE: FontSize = 14 as FontSize;

export const MessagePreviewLineCount = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).check(
  Schema.isLessThanOrEqualTo(30),
);
export type MessagePreviewLineCount = typeof MessagePreviewLineCount.Type;

export interface MessagePreviewLineLimits {
  readonly normal: MessagePreviewLineCount;
  readonly crossThread: MessagePreviewLineCount;
  readonly monitoring: MessagePreviewLineCount;
}

export const DEFAULT_MESSAGE_PREVIEW_LINE_LIMITS: MessagePreviewLineLimits = {
  normal: 10 as MessagePreviewLineCount,
  crossThread: 10 as MessagePreviewLineCount,
  monitoring: 4 as MessagePreviewLineCount,
};

export const MessagePreviewLineLimits = Schema.Struct({
  normal: MessagePreviewLineCount.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_MESSAGE_PREVIEW_LINE_LIMITS.normal)),
  ),
  crossThread: MessagePreviewLineCount.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_MESSAGE_PREVIEW_LINE_LIMITS.crossThread)),
  ),
  monitoring: MessagePreviewLineCount.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_MESSAGE_PREVIEW_LINE_LIMITS.monitoring)),
  ),
});

export const SidebarRowSpacing = Schema.Literals(["compact", "default", "relaxed"]);
export type SidebarRowSpacing = typeof SidebarRowSpacing.Type;
export const DEFAULT_SIDEBAR_ROW_SPACING: SidebarRowSpacing = "default";

export const UiDensity = Schema.Literals(["compact", "default", "comfortable", "spacious"]);
export type UiDensity = typeof UiDensity.Type;
export const DEFAULT_UI_DENSITY: UiDensity = "default";

/** Every font size the UI density knob is allowed to drive. */
export interface DensityFontSizes {
  readonly chatFontSize: FontSize;
  readonly codeFontSize: FontSize;
  readonly inputFontSize: FontSize;
  readonly sidebarFontSize: FontSize;
  readonly sidebarMetaFontSize: FontSize;
  readonly statusLineFontSize: FontSize;
  readonly toolFontSize: FontSize;
}

/**
 * Recommended type scale per density. Density already scales spacing, but
 * spacing alone cannot make a dense layout read as dense: text has to come with
 * it. These are the sizes a density is designed around, and the values the
 * settings UI offers as "recommended".
 *
 * `default` must stay in sync with the DEFAULT_*_FONT_SIZE constants above so
 * that the shipped defaults and the recommended values agree.
 */
export const RECOMMENDED_FONT_SIZES_BY_UI_DENSITY: Readonly<Record<UiDensity, DensityFontSizes>> = {
  compact: {
    chatFontSize: 13 as FontSize,
    codeFontSize: 11 as FontSize,
    inputFontSize: 13 as FontSize,
    sidebarFontSize: 10 as FontSize,
    sidebarMetaFontSize: 9 as FontSize,
    statusLineFontSize: 12 as FontSize,
    toolFontSize: 11 as FontSize,
  },
  default: {
    chatFontSize: DEFAULT_CHAT_FONT_SIZE,
    codeFontSize: DEFAULT_CODE_FONT_SIZE,
    inputFontSize: DEFAULT_INPUT_FONT_SIZE,
    sidebarFontSize: DEFAULT_SIDEBAR_FONT_SIZE,
    sidebarMetaFontSize: DEFAULT_SIDEBAR_META_FONT_SIZE,
    statusLineFontSize: DEFAULT_STATUS_LINE_FONT_SIZE,
    toolFontSize: DEFAULT_TOOL_FONT_SIZE,
  },
  comfortable: {
    chatFontSize: 15 as FontSize,
    codeFontSize: 13 as FontSize,
    inputFontSize: 15 as FontSize,
    sidebarFontSize: 12 as FontSize,
    sidebarMetaFontSize: 11 as FontSize,
    statusLineFontSize: 15 as FontSize,
    toolFontSize: 13 as FontSize,
  },
  spacious: {
    chatFontSize: 16 as FontSize,
    codeFontSize: 14 as FontSize,
    inputFontSize: 16 as FontSize,
    sidebarFontSize: 13 as FontSize,
    sidebarMetaFontSize: 12 as FontSize,
    statusLineFontSize: 16 as FontSize,
    toolFontSize: 14 as FontSize,
  },
};

export const SidebarTranslucency = Schema.Literals([
  "off",
  "subtle",
  "medium",
  "strong",
  "liquid-glass",
]);
export type SidebarTranslucency = typeof SidebarTranslucency.Type;
export const DEFAULT_SIDEBAR_TRANSLUCENCY: SidebarTranslucency = "off";

export const SidebarProjectSortOrder = Schema.Literals(["updated_at", "created_at", "manual"]);
export type SidebarProjectSortOrder = typeof SidebarProjectSortOrder.Type;
export const DEFAULT_SIDEBAR_PROJECT_SORT_ORDER: SidebarProjectSortOrder = "updated_at";

export const SidebarThreadSortOrder = Schema.Literals(["updated_at", "created_at"]);
export type SidebarThreadSortOrder = typeof SidebarThreadSortOrder.Type;
export const DEFAULT_SIDEBAR_THREAD_SORT_ORDER: SidebarThreadSortOrder = "updated_at";
export const SidebarThreadFilter = Schema.Literals(["all", "active", "with_pr", "open_pr"]);
export type SidebarThreadFilter = typeof SidebarThreadFilter.Type;
export const DEFAULT_SIDEBAR_THREAD_FILTER: SidebarThreadFilter = "all";
export const DEFAULT_SIDEBAR_V2_ENABLED = false;

/** Initial state filter for the pull requests page when the URL names none. */
export const DEFAULT_PULL_REQUESTS_DEFAULT_STATE: PullRequestListState = "open";
/** Code font size for pull request diffs, independent of the global code size. */
export const DEFAULT_PULL_REQUESTS_CODE_FONT_SIZE: FontSize = 12 as FontSize;

export const ThreadCompletionNotificationMode = Schema.Literals(["off", "background-only", "all"]);
export type ThreadCompletionNotificationMode = typeof ThreadCompletionNotificationMode.Type;
export const DEFAULT_THREAD_COMPLETION_NOTIFICATION_MODE: ThreadCompletionNotificationMode =
  "background-only";

export const SidebarProjectGroupingMode = Schema.Literals([
  "repository",
  "repository_path",
  "separate",
]);
export type SidebarProjectGroupingMode = typeof SidebarProjectGroupingMode.Type;
export const DEFAULT_SIDEBAR_PROJECT_GROUPING_MODE: SidebarProjectGroupingMode = "repository";

// ── Header / sidebar button visibility + per-button behavior ──────
// Client-only UI chrome prefs. Flat keys follow the existing ClientSettings
// convention so patches, persistence, and reset labels stay trivial.

export const DEFAULT_HEADER_SHOW_PROJECT_SCRIPTS = true;
export const DEFAULT_HEADER_SHOW_OPEN_IN = true;
export const DEFAULT_HEADER_SHOW_GIT_ACTIONS = true;
export const DEFAULT_HEADER_SHOW_WORKFLOWS = true;
export const DEFAULT_HEADER_SHOW_WORKFLOW_RUNS = true;
export const DEFAULT_HEADER_SHOW_EXPORT_CHAT = true;
export const DEFAULT_HEADER_SHOW_INSIGHTS_TOGGLE = true;
export const DEFAULT_HEADER_SHOW_BROWSER_TOGGLE = true;
export const DEFAULT_HEADER_SHOW_FILES_TOGGLE = true;
export const DEFAULT_HEADER_SHOW_TERMINAL_TOGGLE = true;
export const DEFAULT_HEADER_SHOW_DIFF_TOGGLE = true;
export const DEFAULT_SIDEBAR_SHOW_SEARCH = true;
export const DEFAULT_SIDEBAR_SHOW_PULL_REQUESTS = true;
export const DEFAULT_SIDEBAR_SHOW_SKILLS = true;
export const DEFAULT_SIDEBAR_SHOW_NEW_THREAD = true;

export const DEFAULT_HEADER_EXPORT_CONFIRM = false;
export const DEFAULT_PROJECT_SCRIPTS_CONFIRM_RUN = false;
export const DEFAULT_OPEN_IN_UPDATE_PREFERRED = true;
export const DEFAULT_GIT_CONFIRM_DEFAULT_BRANCH = true;
export const DEFAULT_GIT_SHOW_QUICK_ACTION = true;
export const DEFAULT_WORKFLOW_CONFIRM_RUN = false;
export const DEFAULT_WORKFLOW_PREWARM_ON_HOVER = true;
export const DEFAULT_WORKFLOW_RUNS_SHOW_BADGE = true;
export const DEFAULT_SIDEBAR_SEARCH_SHOW_SHORTCUT = true;
export const DEFAULT_SIDEBAR_NEW_THREAD_CONFIRM = false;

export const BrowserRecordingFrameRate = Schema.Literals([30, 60]);
export type BrowserRecordingFrameRate = typeof BrowserRecordingFrameRate.Type;
export const DEFAULT_BROWSER_RECORDING_FRAME_RATE: BrowserRecordingFrameRate = 30;
export const DEFAULT_BROWSER_VIEWPORT: PreviewViewportSetting = FILL_PREVIEW_VIEWPORT;
export const BrowserLinkTarget = Schema.Literals(["system", "app"]);
export type BrowserLinkTarget = typeof BrowserLinkTarget.Type;
export const DEFAULT_BROWSER_LINK_TARGET: BrowserLinkTarget = "system";

export const ClientSettingsSchema = Schema.Struct({
  autoOpenPlanSidebar: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  browserDefaultViewport: PreviewViewportSetting.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_BROWSER_VIEWPORT)),
  ),
  browserDefaultZoomFactor: PreviewZoomFactor.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PREVIEW_ZOOM_FACTOR)),
  ),
  browserDefaultAppearance: PreviewAppearancePreference.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PREVIEW_APPEARANCE)),
  ),
  browserLinkTarget: BrowserLinkTarget.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_BROWSER_LINK_TARGET)),
  ),
  browserAutoShowFloatingPreview: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(true)),
  ),
  browserRecordingFrameRate: BrowserRecordingFrameRate.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_BROWSER_RECORDING_FRAME_RATE)),
  ),
  /** User-created browser profiles; built-ins are synthesized at read time. */
  browserProfiles: Schema.Array(BrowserProfile).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  /** Profile used for new tabs when a caller does not specify one. */
  browserDefaultProfileId: BrowserProfileId.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_BROWSER_PROFILE_ID)),
  ),
  chatFontSize: FontSize.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_CHAT_FONT_SIZE))),
  statusLineFontSize: FontSize.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_STATUS_LINE_FONT_SIZE)),
  ),
  codeFontSize: FontSize.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_CODE_FONT_SIZE))),
  inputFontSize: FontSize.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_INPUT_FONT_SIZE))),
  messagePreviewLineLimits: MessagePreviewLineLimits.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_MESSAGE_PREVIEW_LINE_LIMITS)),
  ),
  sidebarFontSize: FontSize.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SIDEBAR_FONT_SIZE)),
  ),
  sidebarMetaFontSize: FontSize.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SIDEBAR_META_FONT_SIZE)),
  ),
  sidebarRowSpacing: SidebarRowSpacing.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SIDEBAR_ROW_SPACING)),
  ),
  sidebarTranslucency: SidebarTranslucency.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SIDEBAR_TRANSLUCENCY)),
  ),
  toolFontSize: FontSize.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_TOOL_FONT_SIZE))),
  confirmThreadArchive: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  confirmThreadDelete: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  codeFont: CodeFont.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_CODE_FONT))),
  diffWordWrap: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  pullRequestsDefaultState: PullRequestListState.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PULL_REQUESTS_DEFAULT_STATE)),
  ),
  pullRequestsCodeFontSize: FontSize.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PULL_REQUESTS_CODE_FONT_SIZE)),
  ),
  // Model favorites. Historically keyed by provider kind, now
  // widened to `ProviderInstanceId` so users can favorite a specific model
  // on a custom provider instance (e.g. "Codex Personal · gpt-5") without
  // the UI collapsing it into the same bucket as the default Codex. The
  // widening is backward-compatible by construction: prior provider-kind
  // strings satisfy the `ProviderInstanceId` slug schema, so previously
  // persisted favorites decode unchanged and continue to point at the
  // default instance for their kind (because `defaultInstanceIdForDriver(kind)`
  // uses the same slug). The field name is kept as `provider` for storage
  // stability; new call sites should treat the value as an instance id.
  favorites: Schema.Array(
    Schema.Struct({
      provider: ProviderInstanceId,
      model: TrimmedNonEmptyString,
    }),
  ).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  providerModelPreferences: Schema.Record(
    ProviderInstanceId,
    Schema.Struct({
      hiddenModels: Schema.Array(Schema.String).pipe(
        Schema.withDecodingDefault(Effect.succeed([])),
      ),
      modelOrder: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
    }),
  ).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  sidebarProjectGroupingMode: SidebarProjectGroupingMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SIDEBAR_PROJECT_GROUPING_MODE)),
  ),
  sidebarProjectGroupingOverrides: Schema.Record(
    TrimmedNonEmptyString,
    SidebarProjectGroupingMode,
  ).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  sidebarProjectSortOrder: SidebarProjectSortOrder.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SIDEBAR_PROJECT_SORT_ORDER)),
  ),
  sidebarThreadSortOrder: SidebarThreadSortOrder.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SIDEBAR_THREAD_SORT_ORDER)),
  ),
  sidebarThreadFilter: SidebarThreadFilter.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SIDEBAR_THREAD_FILTER)),
  ),
  sidebarV2Enabled: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SIDEBAR_V2_ENABLED)),
  ),
  threadCompletionNotifications: ThreadCompletionNotificationMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_THREAD_COMPLETION_NOTIFICATION_MODE)),
  ),
  timestampFormat: TimestampFormat.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_TIMESTAMP_FORMAT)),
  ),
  uiDensity: UiDensity.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_UI_DENSITY))),
  uiFont: UiFont.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_UI_FONT))),
  headerShowProjectScripts: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_HEADER_SHOW_PROJECT_SCRIPTS)),
  ),
  headerShowOpenIn: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_HEADER_SHOW_OPEN_IN)),
  ),
  headerShowGitActions: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_HEADER_SHOW_GIT_ACTIONS)),
  ),
  headerShowWorkflows: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_HEADER_SHOW_WORKFLOWS)),
  ),
  headerShowWorkflowRuns: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_HEADER_SHOW_WORKFLOW_RUNS)),
  ),
  headerShowExportChat: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_HEADER_SHOW_EXPORT_CHAT)),
  ),
  headerShowInsightsToggle: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_HEADER_SHOW_INSIGHTS_TOGGLE)),
  ),
  headerShowBrowserToggle: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_HEADER_SHOW_BROWSER_TOGGLE)),
  ),
  headerShowFilesToggle: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_HEADER_SHOW_FILES_TOGGLE)),
  ),
  headerShowTerminalToggle: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_HEADER_SHOW_TERMINAL_TOGGLE)),
  ),
  headerShowDiffToggle: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_HEADER_SHOW_DIFF_TOGGLE)),
  ),
  sidebarShowSearch: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SIDEBAR_SHOW_SEARCH)),
  ),
  sidebarShowPullRequests: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SIDEBAR_SHOW_PULL_REQUESTS)),
  ),
  sidebarShowSkills: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SIDEBAR_SHOW_SKILLS)),
  ),
  sidebarShowNewThread: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SIDEBAR_SHOW_NEW_THREAD)),
  ),
  headerExportConfirm: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_HEADER_EXPORT_CONFIRM)),
  ),
  projectScriptsConfirmRun: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROJECT_SCRIPTS_CONFIRM_RUN)),
  ),
  openInUpdatePreferred: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_OPEN_IN_UPDATE_PREFERRED)),
  ),
  gitConfirmDefaultBranch: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_GIT_CONFIRM_DEFAULT_BRANCH)),
  ),
  gitShowQuickAction: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_GIT_SHOW_QUICK_ACTION)),
  ),
  workflowConfirmRun: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_WORKFLOW_CONFIRM_RUN)),
  ),
  workflowPrewarmOnHover: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_WORKFLOW_PREWARM_ON_HOVER)),
  ),
  workflowRunsShowBadge: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_WORKFLOW_RUNS_SHOW_BADGE)),
  ),
  sidebarSearchShowShortcut: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SIDEBAR_SEARCH_SHOW_SHORTCUT)),
  ),
  sidebarNewThreadConfirm: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SIDEBAR_NEW_THREAD_CONFIRM)),
  ),
});
export type ClientSettings = typeof ClientSettingsSchema.Type;

export const DEFAULT_CLIENT_SETTINGS: ClientSettings = Schema.decodeSync(ClientSettingsSchema)({});

// ── Server Settings (server-authoritative) ────────────────────

export { ThreadEnvMode } from "./environment.ts";

const makeBinaryPathSetting = (fallback: string) =>
  TrimmedString.pipe(
    Schema.decodeTo(
      Schema.String,
      SchemaTransformation.transformOrFail({
        decode: (value) => Effect.succeed(value || fallback),
        encode: (value) => Effect.succeed(value),
      }),
    ),
    Schema.withDecodingDefault(Effect.succeed(fallback)),
  );

export const CodexSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  binaryPath: makeBinaryPathSetting("codex"),
  homePath: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  shadowHomePath: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  customModels: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});
export type CodexSettings = typeof CodexSettings.Type;

export const ClaudeSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  binaryPath: makeBinaryPathSetting("claude"),
  homePath: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  customModels: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  launchArgs: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
});
export type ClaudeSettings = typeof ClaudeSettings.Type;

export const CursorSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  binaryPath: makeBinaryPathSetting("agent"),
  apiEndpoint: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  customModels: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});
export type CursorSettings = typeof CursorSettings.Type;

export const CopilotSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  binaryPath: makeBinaryPathSetting("copilot"),
  customModels: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});
export type CopilotSettings = typeof CopilotSettings.Type;

export const OpenCodeSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  binaryPath: makeBinaryPathSetting("opencode"),
  serverUrl: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  serverPassword: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  customModels: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});
export type OpenCodeSettings = typeof OpenCodeSettings.Type;

export const ObservabilitySettings = Schema.Struct({
  otlpTracesUrl: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  otlpMetricsUrl: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
});
export type ObservabilitySettings = typeof ObservabilitySettings.Type;

export const ChatExportDetailSettings = Schema.Struct({
  includeMetadata: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  includeToolCalls: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  includeDiffs: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  includePlans: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  includeQueuedTurns: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
});
export type ChatExportDetailSettings = typeof ChatExportDetailSettings.Type;
export const DEFAULT_CHAT_EXPORT_DETAIL_SETTINGS: ChatExportDetailSettings = Schema.decodeSync(
  ChatExportDetailSettings,
)({});

export const ServerSettings = Schema.Struct({
  environmentIcon: Schema.NullOr(EnvironmentMachineKind).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  sidebarAutoSettleAfterDays: Schema.NullOr(Schema.Number).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  sidebarAutoSettleOnMerge: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  defaultModelSelection: Schema.NullOr(ModelSelection).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  defaultProjectScripts: Schema.Array(ProjectScript).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  projectScriptOverrides: Schema.Record(ProjectId, Schema.NullOr(Schema.Array(ProjectScript))).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  newWorktreesStartFromOrigin: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
  ),
  sourceControlWritingStyle: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  enableAssistantStreaming: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  enableAgentBrowserAccess: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  enableDeviceSupport: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  enableAgentDeviceAccess: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  deviceOnboardingCompleted: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  deviceHosts: SshDeviceHostConfigs.pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  defaultThreadEnvMode: ThreadEnvMode.pipe(
    Schema.withDecodingDefault(Effect.succeed("local" as const satisfies ThreadEnvMode)),
  ),
  addProjectBaseDirectory: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  chatExportDirectory: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  chatExportDetail: ChatExportDetailSettings.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_CHAT_EXPORT_DETAIL_SETTINGS)),
  ),
  /**
   * Null means no policy has been explicitly selected. This preserves the
   * opt-in boundary for installations created before collaborative acceptance
   * existed; an explicit "off" policy remains distinguishable from absence.
   */
  collaborativeAcceptance: Schema.NullOr(CollaborativeAcceptancePolicy).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  agentWorkflows: AgentWorkflowSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  textGenerationModelSelection: ModelSelection.pipe(
    Schema.withDecodingDefault(
      Effect.succeed({
        instanceId: defaultInstanceIdForDriver(DEFAULT_PROVIDER_DRIVER_KIND),
        model:
          DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER[DEFAULT_PROVIDER_DRIVER_KIND] ??
          DEFAULT_GIT_TEXT_GENERATION_MODEL,
      }),
    ),
  ),
  /**
   * Default model for delegated helper threads created via `delegate_work`.
   * Factory default is Copilot `gpt-6-luna`; explicit per-delegation
   * `defaults.model` / `child.model` values always win over this setting,
   * and the parent session model is never inherited.
   */
  delegatedThreadModelSelection: ModelSelection.pipe(
    Schema.withDecodingDefault(
      Effect.succeed({
        instanceId: defaultInstanceIdForDriver(DEFAULT_PROVIDER_DRIVER_KIND),
        model: "gpt-6-luna",
      }),
    ),
  ),

  // Legacy single-instance-per-driver settings. Continues to be the source
  // of truth until `providerInstances` (below) lands per-driver migration
  // shims and the server starts hydrating instances from it. Driver-specific
  // schemas live here for the duration of the migration; once each driver
  // owns its config in its own package, this struct shrinks to nothing and
  // is removed entirely.
  providers: Schema.Struct({
    codex: CodexSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
    claudeAgent: ClaudeSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
    cursor: CursorSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
    copilot: CopilotSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
    opencode: OpenCodeSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  }).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  // New driver-agnostic instance map. Keyed by `ProviderInstanceId`; values
  // are `ProviderInstanceConfig` envelopes. The driver-specific config blob
  // is `Schema.Unknown` at this layer so envelopes with unknown drivers
  // (forks, downgrades, in-flight PR branches) round-trip without loss.
  // See providerInstance.ts for the forward/backward compatibility invariant.
  providerInstances: Schema.Record(ProviderInstanceId, ProviderInstanceConfig).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  observability: ObservabilitySettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  // When a thread creates a PR, associate ownership and start monitoring if enabled.
  autoMonitorPullRequestsOnCreate: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(true)),
  ),
  // When owner is missing/unavailable, launch a prepared fallback maintenance thread.
  autoLaunchPrMonitorFallback: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(true)),
  ),
  copilotAutomaticPrFeedback: Schema.Record(ProviderInstanceId, Schema.Boolean).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
});
export type ServerSettings = typeof ServerSettings.Type;

export const DEFAULT_SERVER_SETTINGS: ServerSettings = Schema.decodeSync(ServerSettings)({});

export class ServerSettingsError extends Schema.TaggedErrorClass<ServerSettingsError>()(
  "ServerSettingsError",
  {
    settingsPath: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {
  override get message(): string {
    return `Server settings error at ${this.settingsPath}: ${this.detail}`;
  }
}

// ── Unified type ─────────────────────────────────────────────────────

export type UnifiedSettings = ServerSettings & ClientSettings;
export const DEFAULT_UNIFIED_SETTINGS: UnifiedSettings = {
  ...DEFAULT_SERVER_SETTINGS,
  ...DEFAULT_CLIENT_SETTINGS,
};

// ── Server Settings Patch (replace with a Schema.deepPartial if available) ──────────────────────────────────────────

const ModelSelectionPatch = Schema.Struct({
  instanceId: Schema.optionalKey(ProviderInstanceId),
  model: Schema.optionalKey(TrimmedNonEmptyString),
  options: Schema.optionalKey(ProviderOptionSelections),
});

const CodexSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  binaryPath: Schema.optionalKey(Schema.String),
  homePath: Schema.optionalKey(Schema.String),
  shadowHomePath: Schema.optionalKey(Schema.String),
  customModels: Schema.optionalKey(Schema.Array(Schema.String)),
});

const ClaudeSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  binaryPath: Schema.optionalKey(Schema.String),
  homePath: Schema.optionalKey(Schema.String),
  customModels: Schema.optionalKey(Schema.Array(Schema.String)),
  launchArgs: Schema.optionalKey(Schema.String),
});

const CursorSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  binaryPath: Schema.optionalKey(Schema.String),
  apiEndpoint: Schema.optionalKey(Schema.String),
  customModels: Schema.optionalKey(Schema.Array(Schema.String)),
});

const CopilotSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  binaryPath: Schema.optionalKey(Schema.String),
  customModels: Schema.optionalKey(Schema.Array(Schema.String)),
});

const OpenCodeSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  binaryPath: Schema.optionalKey(Schema.String),
  serverUrl: Schema.optionalKey(Schema.String),
  serverPassword: Schema.optionalKey(Schema.String),
  customModels: Schema.optionalKey(Schema.Array(Schema.String)),
});

const ChatExportDetailSettingsPatch = Schema.Struct({
  includeMetadata: Schema.optionalKey(Schema.Boolean),
  includeToolCalls: Schema.optionalKey(Schema.Boolean),
  includeDiffs: Schema.optionalKey(Schema.Boolean),
  includePlans: Schema.optionalKey(Schema.Boolean),
  includeQueuedTurns: Schema.optionalKey(Schema.Boolean),
});

const AgentWorkflowSettingsPatch = Schema.Struct({
  reviewChanges: Schema.optionalKey(
    Schema.Struct({
      enabled: Schema.optionalKey(Schema.Boolean),
      modelSelection: Schema.optionalKey(Schema.NullOr(ModelSelection)),
      defaultScope: Schema.optionalKey(ReviewChangesScope),
      promptTemplate: Schema.optionalKey(Schema.String),
    }),
  ),
  fixReviewIssues: Schema.optionalKey(
    Schema.Struct({
      enabled: Schema.optionalKey(Schema.Boolean),
      modelSelection: Schema.optionalKey(Schema.NullOr(ModelSelection)),
      promptTemplate: Schema.optionalKey(Schema.String),
    }),
  ),
  builtInOverrides: Schema.optionalKey(
    Schema.Record(
      TrimmedNonEmptyString,
      Schema.Struct({
        enabled: Schema.optionalKey(Schema.Boolean),
        promptTemplate: Schema.optionalKey(Schema.String),
        defaultInput: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
      }),
    ),
  ),
  customWorkflows: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        id: TrimmedNonEmptyString,
        enabled: Schema.optionalKey(Schema.Boolean),
        name: TrimmedNonEmptyString,
        buttonLabel: TrimmedNonEmptyString,
        promptTemplate: Schema.String,
        modelSelection: Schema.optionalKey(Schema.NullOr(ModelSelection)),
        showInHeader: Schema.optionalKey(Schema.Boolean),
        destinationMode: Schema.optionalKey(AgentWorkflowDestinationMode),
        automation: Schema.optionalKey(CustomAgentWorkflowAutomationSettings),
      }),
    ),
  ),
});

export const ProviderInstanceMutation = Schema.Struct({
  instanceId: ProviderInstanceId,
  // `null` removes the instance; a config upserts (replaces) it.
  config: Schema.NullOr(ProviderInstanceConfig),
});
export type ProviderInstanceMutation = typeof ProviderInstanceMutation.Type;

export const ServerSettingsPatch = Schema.Struct({
  sidebarAutoSettleAfterDays: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  sidebarAutoSettleOnMerge: Schema.optionalKey(Schema.Boolean),
  newWorktreesStartFromOrigin: Schema.optionalKey(Schema.Boolean),
  sourceControlWritingStyle: Schema.optionalKey(Schema.String),
  // Server settings
  enableAssistantStreaming: Schema.optionalKey(Schema.Boolean),
  enableAgentBrowserAccess: Schema.optionalKey(Schema.Boolean),
  enableDeviceSupport: Schema.optionalKey(Schema.Boolean),
  enableAgentDeviceAccess: Schema.optionalKey(Schema.Boolean),
  deviceOnboardingCompleted: Schema.optionalKey(Schema.Boolean),
  deviceHosts: Schema.optionalKey(SshDeviceHostConfigs),
  defaultThreadEnvMode: Schema.optionalKey(ThreadEnvMode),
  addProjectBaseDirectory: Schema.optionalKey(Schema.String),
  chatExportDirectory: Schema.optionalKey(Schema.String),
  chatExportDetail: Schema.optionalKey(ChatExportDetailSettingsPatch),
  collaborativeAcceptance: Schema.optionalKey(Schema.NullOr(CollaborativeAcceptancePolicy)),
  agentWorkflows: Schema.optionalKey(AgentWorkflowSettingsPatch),
  textGenerationModelSelection: Schema.optionalKey(ModelSelectionPatch),
  delegatedThreadModelSelection: Schema.optionalKey(ModelSelectionPatch),
  observability: Schema.optionalKey(
    Schema.Struct({
      otlpTracesUrl: Schema.optionalKey(Schema.String),
      otlpMetricsUrl: Schema.optionalKey(Schema.String),
    }),
  ),
  autoMonitorPullRequestsOnCreate: Schema.optionalKey(Schema.Boolean),
  autoLaunchPrMonitorFallback: Schema.optionalKey(Schema.Boolean),
  copilotAutomaticPrFeedback: Schema.optionalKey(Schema.Record(ProviderInstanceId, Schema.Boolean)),
  providers: Schema.optionalKey(
    Schema.Struct({
      codex: Schema.optionalKey(CodexSettingsPatch),
      claudeAgent: Schema.optionalKey(ClaudeSettingsPatch),
      cursor: Schema.optionalKey(CursorSettingsPatch),
      copilot: Schema.optionalKey(CopilotSettingsPatch),
      opencode: Schema.optionalKey(OpenCodeSettingsPatch),
    }),
  ),
  // Whole-map replacement for the new instance config. Patching individual
  // entries is intentionally out of scope: the map is small, and partial
  // patches risk leaving driver-specific config in a half-merged state.
  // The web UI sends a fully-formed map every time it edits this field.
  providerInstances: Schema.optionalKey(Schema.Record(ProviderInstanceId, ProviderInstanceConfig)),
  // Atomic per-instance upsert/remove operations applied server-side against the
  // freshest settings under the write lock. Unlike `providerInstances` (whole-map
  // replace), these preserve concurrent edits to *other* instances, so callers
  // performing read-modify-write on a single instance cannot clobber unrelated
  // entries written between their read and write. A `null` config removes the
  // instance; a present config upserts it.
  providerInstanceMutations: Schema.optionalKey(Schema.Array(ProviderInstanceMutation)),
});
export type ServerSettingsPatch = typeof ServerSettingsPatch.Type;

export const ClientSettingsPatch = Schema.Struct({
  autoOpenPlanSidebar: Schema.optionalKey(Schema.Boolean),
  browserDefaultViewport: Schema.optionalKey(PreviewViewportSetting),
  browserDefaultZoomFactor: Schema.optionalKey(PreviewZoomFactor),
  browserDefaultAppearance: Schema.optionalKey(PreviewAppearancePreference),
  browserLinkTarget: Schema.optionalKey(BrowserLinkTarget),
  browserAutoShowFloatingPreview: Schema.optionalKey(Schema.Boolean),
  browserRecordingFrameRate: Schema.optionalKey(BrowserRecordingFrameRate),
  browserProfiles: Schema.optionalKey(Schema.Array(BrowserProfile)),
  browserDefaultProfileId: Schema.optionalKey(BrowserProfileId),
  chatFontSize: Schema.optionalKey(FontSize),
  statusLineFontSize: Schema.optionalKey(FontSize),
  codeFontSize: Schema.optionalKey(FontSize),
  inputFontSize: Schema.optionalKey(FontSize),
  messagePreviewLineLimits: Schema.optionalKey(MessagePreviewLineLimits),
  sidebarFontSize: Schema.optionalKey(FontSize),
  sidebarMetaFontSize: Schema.optionalKey(FontSize),
  sidebarRowSpacing: Schema.optionalKey(SidebarRowSpacing),
  sidebarTranslucency: Schema.optionalKey(SidebarTranslucency),
  toolFontSize: Schema.optionalKey(FontSize),
  confirmThreadArchive: Schema.optionalKey(Schema.Boolean),
  confirmThreadDelete: Schema.optionalKey(Schema.Boolean),
  codeFont: Schema.optionalKey(CodeFont),
  diffWordWrap: Schema.optionalKey(Schema.Boolean),
  pullRequestsDefaultState: Schema.optionalKey(PullRequestListState),
  pullRequestsCodeFontSize: Schema.optionalKey(FontSize),
  favorites: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        provider: ProviderInstanceId,
        model: TrimmedNonEmptyString,
      }),
    ),
  ),
  providerModelPreferences: Schema.optionalKey(
    Schema.Record(
      ProviderInstanceId,
      Schema.Struct({
        hiddenModels: Schema.Array(Schema.String).pipe(
          Schema.withDecodingDefault(Effect.succeed([])),
        ),
        modelOrder: Schema.Array(Schema.String).pipe(
          Schema.withDecodingDefault(Effect.succeed([])),
        ),
      }),
    ),
  ),
  sidebarProjectGroupingMode: Schema.optionalKey(SidebarProjectGroupingMode),
  sidebarProjectGroupingOverrides: Schema.optionalKey(
    Schema.Record(TrimmedNonEmptyString, SidebarProjectGroupingMode),
  ),
  sidebarProjectSortOrder: Schema.optionalKey(SidebarProjectSortOrder),
  sidebarThreadSortOrder: Schema.optionalKey(SidebarThreadSortOrder),
  sidebarThreadFilter: Schema.optionalKey(SidebarThreadFilter),
  sidebarV2Enabled: Schema.optionalKey(Schema.Boolean),
  timestampFormat: Schema.optionalKey(TimestampFormat),
  uiDensity: Schema.optionalKey(UiDensity),
  uiFont: Schema.optionalKey(UiFont),
  headerShowProjectScripts: Schema.optionalKey(Schema.Boolean),
  headerShowOpenIn: Schema.optionalKey(Schema.Boolean),
  headerShowGitActions: Schema.optionalKey(Schema.Boolean),
  headerShowWorkflows: Schema.optionalKey(Schema.Boolean),
  headerShowWorkflowRuns: Schema.optionalKey(Schema.Boolean),
  headerShowExportChat: Schema.optionalKey(Schema.Boolean),
  headerShowInsightsToggle: Schema.optionalKey(Schema.Boolean),
  headerShowBrowserToggle: Schema.optionalKey(Schema.Boolean),
  headerShowFilesToggle: Schema.optionalKey(Schema.Boolean),
  headerShowTerminalToggle: Schema.optionalKey(Schema.Boolean),
  headerShowDiffToggle: Schema.optionalKey(Schema.Boolean),
  sidebarShowSearch: Schema.optionalKey(Schema.Boolean),
  sidebarShowPullRequests: Schema.optionalKey(Schema.Boolean),
  sidebarShowSkills: Schema.optionalKey(Schema.Boolean),
  sidebarShowNewThread: Schema.optionalKey(Schema.Boolean),
  headerExportConfirm: Schema.optionalKey(Schema.Boolean),
  projectScriptsConfirmRun: Schema.optionalKey(Schema.Boolean),
  openInUpdatePreferred: Schema.optionalKey(Schema.Boolean),
  gitConfirmDefaultBranch: Schema.optionalKey(Schema.Boolean),
  gitShowQuickAction: Schema.optionalKey(Schema.Boolean),
  workflowConfirmRun: Schema.optionalKey(Schema.Boolean),
  workflowPrewarmOnHover: Schema.optionalKey(Schema.Boolean),
  workflowRunsShowBadge: Schema.optionalKey(Schema.Boolean),
  sidebarSearchShowShortcut: Schema.optionalKey(Schema.Boolean),
  sidebarNewThreadConfirm: Schema.optionalKey(Schema.Boolean),
});
export type ClientSettingsPatch = typeof ClientSettingsPatch.Type;

export const MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS = 1;

export const MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS = 90;

export const SidebarAutoSettleAfterDays = Schema.Number.check(
  Schema.isBetween({
    minimum: MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS,
    maximum: MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS,
  }),
);

export type SidebarAutoSettleAfterDays = typeof SidebarAutoSettleAfterDays.Type;

export const DEFAULT_SIDEBAR_AUTO_SETTLE_AFTER_DAYS: SidebarAutoSettleAfterDays = 3;
