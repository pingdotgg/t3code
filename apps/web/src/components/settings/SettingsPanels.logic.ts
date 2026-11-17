import type {
  BackgroundActivityProfile,
  BackgroundActivitySettings,
  ProviderInstanceConfig,
  PreviewViewportSetting,
  ProviderInstanceId,
  ServerSettings,
  SidebarProjectGroupingMode,
  UnifiedSettings,
} from "@t3tools/contracts";
import {
  DEFAULT_UNIFIED_SETTINGS,
  MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS,
  MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS,
} from "@t3tools/contracts/settings";
import {
  getBackgroundActivityBaseProfile,
  normalizeBackgroundActivitySettings,
  normalizeServerBackgroundActivitySettings,
  resolveServerBackgroundActivitySettings,
} from "@t3tools/shared/backgroundActivitySettings";
import * as Duration from "effect/Duration";
import * as Equal from "effect/Equal";

export function isProjectGroupingEnabled(mode: SidebarProjectGroupingMode): boolean {
  return mode !== "separate";
}

export function projectGroupingModeFromToggle(
  enabled: boolean,
  lastEnabledMode: SidebarProjectGroupingMode = "repository",
): SidebarProjectGroupingMode {
  if (!enabled) return "separate";
  return lastEnabledMode === "repository_path" ? "repository_path" : "repository";
}

const LAST_ENABLED_PROJECT_GROUPING_MODE_KEY = "t3code:last-enabled-project-grouping-mode";

export function readLastEnabledProjectGroupingMode(): SidebarProjectGroupingMode {
  try {
    return localStorage.getItem(LAST_ENABLED_PROJECT_GROUPING_MODE_KEY) === "repository_path"
      ? "repository_path"
      : "repository";
  } catch {
    return "repository";
  }
}

export function rememberEnabledProjectGroupingMode(mode: SidebarProjectGroupingMode): void {
  if (mode === "separate") return;
  try {
    localStorage.setItem(LAST_ENABLED_PROJECT_GROUPING_MODE_KEY, mode);
  } catch {}
}

export function hasChangedBackgroundActivitySettings(
  settings: Pick<
    UnifiedSettings,
    | "backgroundActivity"
    | "backgroundActivityProfile"
    | "automaticGitFetchInterval"
    | "providerHealthRefreshInterval"
  >,
): boolean {
  return (
    !Equal.equals(settings.backgroundActivity, DEFAULT_UNIFIED_SETTINGS.backgroundActivity) ||
    settings.backgroundActivityProfile !== DEFAULT_UNIFIED_SETTINGS.backgroundActivityProfile ||
    !Equal.equals(
      settings.automaticGitFetchInterval,
      DEFAULT_UNIFIED_SETTINGS.automaticGitFetchInterval,
    ) ||
    !Equal.equals(
      settings.providerHealthRefreshInterval,
      DEFAULT_UNIFIED_SETTINGS.providerHealthRefreshInterval,
    )
  );
}

type TypographySettings = Pick<
  UnifiedSettings,
  | "fontFamilySans"
  | "fontFamilyComposer"
  | "fontFamilyCode"
  | "fontFamilyTerminal"
  | "fontSizeInterface"
  | "fontSizePrompt"
  | "fontSizeCode"
  | "fontSizeTerminal"
>;

export function getChangedTypographySettingLabels(settings: TypographySettings): string[] {
  return [
    ...(settings.fontFamilySans !== DEFAULT_UNIFIED_SETTINGS.fontFamilySans ||
    settings.fontSizeInterface !== DEFAULT_UNIFIED_SETTINGS.fontSizeInterface
      ? ["restore.interfaceFont"]
      : []),
    ...(settings.fontFamilyComposer !== DEFAULT_UNIFIED_SETTINGS.fontFamilyComposer ||
    settings.fontSizePrompt !== DEFAULT_UNIFIED_SETTINGS.fontSizePrompt
      ? ["restore.promptFont"]
      : []),
    ...(settings.fontFamilyCode !== DEFAULT_UNIFIED_SETTINGS.fontFamilyCode ||
    settings.fontSizeCode !== DEFAULT_UNIFIED_SETTINGS.fontSizeCode
      ? ["restore.codeFont"]
      : []),
    ...(settings.fontFamilyTerminal !== DEFAULT_UNIFIED_SETTINGS.fontFamilyTerminal ||
    settings.fontSizeTerminal !== DEFAULT_UNIFIED_SETTINGS.fontSizeTerminal
      ? ["restore.terminalFont"]
      : []),
  ];
}

export type BrowserDefaultSettings = Pick<
  UnifiedSettings,
  | "browserDefaultViewport"
  | "browserDefaultZoomFactor"
  | "browserDefaultAppearance"
  | "browserRecordingFrameRate"
  | "browserRecordingShowKeyPresses"
  | "browserRecordingShowMousePresses"
  | "browserLinkTarget"
  | "browserSearchEngine"
  | "browserCustomSearchUrl"
  | "browserAutoShowFloatingPreview"
  | "pullRequestLinksOpenInApp"
>;

function isSamePreviewViewport(
  left: PreviewViewportSetting,
  right: PreviewViewportSetting,
): boolean {
  if (left._tag !== right._tag) return false;
  if (left._tag === "fill" || right._tag === "fill") return true;
  if (left.width !== right.width || left.height !== right.height) return false;
  return left._tag === "preset" && right._tag === "preset"
    ? left.presetId === right.presetId
    : true;
}

export function getChangedBrowserSettingLabels(settings: BrowserDefaultSettings): string[] {
  return [
    ...(isSamePreviewViewport(
      settings.browserDefaultViewport,
      DEFAULT_UNIFIED_SETTINGS.browserDefaultViewport,
    )
      ? []
      : ["restore.browserViewport"]),
    ...(settings.browserDefaultZoomFactor !== DEFAULT_UNIFIED_SETTINGS.browserDefaultZoomFactor
      ? ["restore.browserZoom"]
      : []),
    ...(settings.browserDefaultAppearance !== DEFAULT_UNIFIED_SETTINGS.browserDefaultAppearance
      ? ["restore.browserAppearance"]
      : []),
    ...(settings.browserRecordingFrameRate !== DEFAULT_UNIFIED_SETTINGS.browserRecordingFrameRate
      ? ["restore.recordingFrameRate"]
      : []),
    ...(settings.browserRecordingShowKeyPresses ? ["restore.recordingKeyPresses"] : []),
    ...(settings.browserRecordingShowMousePresses ? ["restore.recordingMousePresses"] : []),
    ...(settings.browserLinkTarget !== DEFAULT_UNIFIED_SETTINGS.browserLinkTarget
      ? ["restore.openLinksIn"]
      : []),
    ...(settings.browserSearchEngine !== DEFAULT_UNIFIED_SETTINGS.browserSearchEngine ||
    settings.browserCustomSearchUrl !== DEFAULT_UNIFIED_SETTINGS.browserCustomSearchUrl
      ? ["restore.searchEngine"]
      : []),
    ...(settings.browserAutoShowFloatingPreview !==
    DEFAULT_UNIFIED_SETTINGS.browserAutoShowFloatingPreview
      ? ["restore.floatingPreview"]
      : []),
    ...(settings.pullRequestLinksOpenInApp !== DEFAULT_UNIFIED_SETTINGS.pullRequestLinksOpenInApp
      ? ["restore.openPullRequestsInApp"]
      : []),
  ];
}

export function resolveBackgroundActivityProfileOption(
  settings: ServerSettings,
): BackgroundActivityProfile | "advanced" {
  const resolved = resolveServerBackgroundActivitySettings(settings);
  const normalized = normalizeBackgroundActivitySettings({
    schemaVersion: 1,
    profile: "custom",
    baseProfile: resolved.profile,
    overrides: {
      automaticGitFetchInterval: resolved.automaticGitFetchInterval,
      providerHealthRefreshInterval: resolved.providerHealthRefreshInterval,
      hostPowerMonitorActiveInterval: resolved.hostPowerMonitorActiveInterval,
      hostPowerMonitorIdleInterval: resolved.hostPowerMonitorIdleInterval,
      pauseWhenHostLocked: resolved.pauseWhenHostLocked,
      pauseWhenHostLowPower: resolved.pauseWhenHostLowPower,
      pauseWhenClientLowPower: resolved.pauseWhenClientLowPower,
      pauseWhenOnBattery: resolved.pauseWhenOnBattery,
    },
  });
  return normalized.profile === "custom" ? "advanced" : normalized.profile;
}

export function backgroundActivitySharedPolicySettings(
  settings: ServerSettings,
  profile: BackgroundActivityProfile,
): BackgroundActivitySettings {
  const normalized = normalizeServerBackgroundActivitySettings(settings);
  return {
    schemaVersion: 1,
    profile: "custom",
    baseProfile: profile,
    overrides: normalized.profile === "custom" ? normalized.overrides : {},
  };
}

export function buildProviderInstanceUpdatePatch(input: {
  readonly settings: Pick<ServerSettings, "providerInstances">;
  readonly instanceId: ProviderInstanceId;
  readonly instance: ProviderInstanceConfig;
  readonly textGenerationModelSelection?:
    | ServerSettings["textGenerationModelSelection"]
    | undefined;
}): Partial<UnifiedSettings> {
  return {
    providerInstances: {
      ...input.settings.providerInstances,
      [input.instanceId]: input.instance,
    },
    ...(input.textGenerationModelSelection !== undefined
      ? { textGenerationModelSelection: input.textGenerationModelSelection }
      : {}),
  };
}

export const PROVIDER_HEALTH_INTERVAL_STEP_SECONDS = 30;

type BackgroundActivityOverridePatch = Partial<{
  [K in keyof BackgroundActivitySettings["overrides"]]:
    | BackgroundActivitySettings["overrides"][K]
    | undefined;
}>;

export function durationToSeconds(duration: Duration.Duration): number {
  return Math.round(Duration.toMillis(duration) / 1_000);
}

export function normalizeIntervalSeconds(value: number | null, minimum = 0): number {
  if (value === null || !Number.isFinite(value)) {
    return minimum;
  }
  return Math.max(minimum, Math.round(value));
}

export function backgroundActivityOverrideSettings(
  current: BackgroundActivitySettings,
  resolved: ReturnType<typeof resolveServerBackgroundActivitySettings>,
  overrides: BackgroundActivityOverridePatch,
) {
  const nextOverrides: BackgroundActivityOverridePatch = {
    automaticGitFetchInterval: resolved.automaticGitFetchInterval,
    providerHealthRefreshInterval: resolved.providerHealthRefreshInterval,
    hostPowerMonitorActiveInterval: resolved.hostPowerMonitorActiveInterval,
    hostPowerMonitorIdleInterval: resolved.hostPowerMonitorIdleInterval,
    pauseWhenHostLocked: resolved.pauseWhenHostLocked,
    pauseWhenHostLowPower: resolved.pauseWhenHostLowPower,
    pauseWhenClientLowPower: resolved.pauseWhenClientLowPower,
    pauseWhenOnBattery: resolved.pauseWhenOnBattery,
    ...overrides,
  };
  for (const [key, value] of Object.entries(nextOverrides)) {
    if (value === undefined) {
      delete nextOverrides[key as keyof typeof nextOverrides];
    }
  }
  return {
    backgroundActivity: {
      schemaVersion: 1 as const,
      profile: "custom" as const,
      baseProfile: getBackgroundActivityBaseProfile(current),
      overrides: nextOverrides as BackgroundActivitySettings["overrides"],
    },
  };
}

/**
 * Saving a shorter age settles threads at once, so typing stays in `draft` until the edit is
 * finished. `pending` is the submission in flight; `saved` is the only value a draft falls back to.
 */
export interface AutoSettleDaysField {
  readonly saved: number;
  readonly draft: string;
  readonly dirty: boolean;
  readonly pending: number | null;
  readonly revision: number;
}

export function autoSettleDaysField(saved: number): AutoSettleDaysField {
  return { saved, draft: String(saved), dirty: false, pending: null, revision: 0 };
}

export function syncAutoSettleDaysField(
  field: AutoSettleDaysField,
  saved: number,
): AutoSettleDaysField {
  // An earlier save can be confirmed while a later one is still in flight.
  const pending = field.pending === saved ? null : field.pending;
  if (field.saved === saved && pending === field.pending) return field;
  return {
    ...field,
    saved,
    pending,
    draft: field.dirty ? field.draft : String(pending ?? saved),
  };
}

export function editAutoSettleDaysField(
  field: AutoSettleDaysField,
  draft: string,
): AutoSettleDaysField {
  return { ...field, draft, dirty: true };
}

export function cancelAutoSettleDaysField(field: AutoSettleDaysField): AutoSettleDaysField {
  return { ...field, draft: String(field.pending ?? field.saved), dirty: false };
}

export function commitAutoSettleDaysField(field: AutoSettleDaysField): {
  readonly field: AutoSettleDaysField;
  readonly submit: number | null;
} {
  const current = field.pending ?? field.saved;
  const days = field.draft.trim() === "" ? Number.NaN : Number(field.draft);
  if (
    !Number.isInteger(days) ||
    days < MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS ||
    days > MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS
  ) {
    return { field: { ...field, draft: String(current), dirty: false }, submit: null };
  }
  const settled = { ...field, draft: String(days), dirty: false };
  // An edit ending on the saved value is sent again: a save can land on the shown environment
  // and fail on another, and retyping the number is how it is retried.
  if (!field.dirty || days === field.pending) return { field: settled, submit: null };
  return { field: { ...settled, pending: days, revision: field.revision + 1 }, submit: days };
}

export function failAutoSettleDaysField(
  field: AutoSettleDaysField,
  revision: number,
): AutoSettleDaysField {
  if (field.revision !== revision) return field;
  return { ...field, pending: null, draft: field.dirty ? field.draft : String(field.saved) };
}
