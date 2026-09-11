import { useAtomValue } from "@effect/atom-react";
import {
  ArchiveIcon,
  ArchiveX,
  ChevronRightIcon,
  LoaderIcon,
  PlayIcon,
  SettingsIcon,
} from "lucide-react";
import { Spinner } from "~/components/ui/spinner";
import { Link, useNavigate } from "@tanstack/react-router";
import type { CSSProperties, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type AgentNotificationEvent,
  type AgentNotificationKind,
  type AgentNotificationSoundId,
  type AgentNotificationSounds,
  AGENT_NOTIFICATION_SOUND_IDS,
  type BackgroundActivityProfile,
  type DesktopUpdateChannel,
  type ModelSelection,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ScopedThreadRef,
  type SidebarProjectGroupingMode,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  DEFAULT_ENVIRONMENT_IDENTIFICATION_MODE,
  DEFAULT_UNIFIED_SETTINGS,
  type DiffLayout,
  type EnvironmentIdentificationMode,
  MAX_APPEARANCE_CONTRAST,
  MAX_CODE_FONT_SIZE,
  MAX_GLASS_OPACITY,
  MAX_INTERFACE_FONT_SIZE,
  MAX_INACTIVE_WORKTREE_AGE_DAYS,
  MAX_INACTIVE_WORKTREE_CLEANUP_INTERVAL_DAYS,
  MAX_DECISION_FOLLOW_UP_LIMIT,
  MAX_DECISION_FOLLOW_UP_REMINDER_DAYS,
  MAX_PRODUCT_OPPORTUNITY_CANDIDATES,
  MAX_PULL_REQUEST_ROLLUP_IDLE_DAYS,
  MAX_PULL_REQUEST_ROLLUP_INTERVAL_DAYS,
  MAX_PULL_REQUEST_ROLLUP_LIMIT,
  MAX_PULL_REQUEST_ROLLUP_REPAIR_ATTEMPTS,
  MAX_PROMPT_FONT_SIZE,
  MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS,
  MAX_TERMINAL_FONT_SIZE,
  MIN_CODE_FONT_SIZE,
  MIN_APPEARANCE_CONTRAST,
  MIN_GLASS_OPACITY,
  MIN_INTERFACE_FONT_SIZE,
  MIN_INACTIVE_WORKTREE_AGE_DAYS,
  MIN_INACTIVE_WORKTREE_CLEANUP_INTERVAL_DAYS,
  MIN_DECISION_FOLLOW_UP_LIMIT,
  MIN_DECISION_FOLLOW_UP_REMINDER_DAYS,
  MIN_PRODUCT_OPPORTUNITY_CANDIDATES,
  MIN_PULL_REQUEST_ROLLUP_IDLE_DAYS,
  MIN_PULL_REQUEST_ROLLUP_INTERVAL_DAYS,
  MIN_PULL_REQUEST_ROLLUP_LIMIT,
  MIN_PULL_REQUEST_ROLLUP_REPAIR_ATTEMPTS,
  MIN_PROMPT_FONT_SIZE,
  MAX_PANEL_ANIMATION_DURATION_MS,
  MIN_PANEL_ANIMATION_DURATION_MS,
  MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS,
  MIN_TERMINAL_FONT_SIZE,
  type QuitConfirmationMode,
} from "@t3tools/contracts/settings";
import { resolveServerBackgroundActivitySettings } from "@t3tools/shared/backgroundActivitySettings";
import { createModelSelection } from "@t3tools/shared/model";
import * as Duration from "effect/Duration";
import * as Equal from "effect/Equal";
import * as Schema from "effect/Schema";
import { APP_VERSION, HOSTED_APP_CHANNEL, HOSTED_APP_CHANNEL_LABEL } from "../../branding";
import {
  canCheckForUpdate,
  getDesktopUpdateButtonTooltip,
  getDesktopUpdateInstallConfirmationMessage,
  isDesktopUpdateButtonDisabled,
  resolveDesktopUpdateButtonAction,
} from "../../components/desktopUpdate.logic";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import {
  resolveEnvironmentIdentificationPillLabel,
  useEnvironmentStageLabel,
} from "../SidebarStageBackdrop";
import { isElectron } from "../../env";
import { clearPwaCachesAndReload } from "../../pwa";
import { buildHostedChannelSelectionUrl, type HostedAppChannel } from "../../hostedPairing";
import { useCustomThemes } from "../../hooks/useCustomThemes";
import {
  readAppearanceModePreference,
  readThemeHalves,
  readThemePreference,
  useTheme,
} from "../../hooks/useTheme";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import {
  useClientSettings,
  usePrimarySettings,
  useUpdateClientSettings,
  useUpdatePrimarySettings,
} from "../../hooks/useSettings";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";
import { useScopedModelDisabledReason } from "./useScopedModelAvailability";
import { useSettingsScope } from "./SettingsScopeContext";
import { ProjectDefaultsSettings } from "./ProjectDefaultsSettings";
import { useThreadActions } from "../../hooks/useThreadActions";
import { useDesktopUpdateState } from "../../state/desktopUpdate";
import {
  getCustomModelOptionsByInstance,
  resolveAppModelSelectionState,
} from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { ensureLocalApi, readLocalApi } from "../../localApi";
import { isMacPlatform } from "../../lib/utils";
import { primaryServerProvidersAtom, EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { usePrimaryEnvironment } from "../../state/environments";
import { useArchivedThreadSnapshots } from "../../lib/archivedThreadsState";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { DraftInput } from "../ui/draft-input";
import { Input } from "../ui/input";
import {
  DEFAULT_CODE_FONT_STACK,
  DEFAULT_SANS_FONT_STACK,
  isFontFamilyAvailable,
  isMonospaceFamily,
  resolveDefaultFamilyLabel,
  resolveTerminalFontPreference,
  resolveTerminalFontSizePreference,
  TYPOGRAPHY_ADVANCED_STORAGE_KEY,
} from "../../appearanceFonts";
import { CodeFontPreview, PromptFontPreview, TerminalFontPreview } from "./SettingsFontPreviews";
import { discoverInstalledFonts, FontFamilyPicker, useFontEnumeration } from "./FontFamilyPicker";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../ui/number-field";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { ScopedSwitch } from "./ScopedSwitch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ThemeLibrary } from "./ThemeSettings";
import {
  backgroundActivityOverrideSettings,
  backgroundActivitySharedPolicySettings,
  durationToSeconds,
  getChangedBrowserSettingLabels,
  getChangedTypographySettingLabels,
  normalizeIntervalSeconds,
  PROVIDER_HEALTH_INTERVAL_STEP_SECONDS,
  hasChangedBackgroundActivitySettings,
  isProjectGroupingEnabled,
  projectGroupingModeFromToggle,
  readLastEnabledProjectGroupingMode,
  rememberEnabledProjectGroupingMode,
  resolveBackgroundActivityProfileOption,
} from "./SettingsPanels.logic";
import {
  PolicyTooltip,
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
  useSettingsSearchTarget,
  useSettingsSearchTargetId,
} from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { ProjectFavicon } from "../ProjectFavicon";
import { PanelAnimationsPreview } from "./PanelAnimationsPreview";

import {
  agentNotificationSoundLabel,
  playAgentNotificationSound,
  playAgentNotificationSoundId,
} from "../../agentNotifications/sound";
import {
  getBrowserNotificationStatus,
  getExistingBrowserPushSubscription,
  showBrowserNotificationPreview,
  subscribeBrowserPush,
  unsubscribeBrowserPush,
  type BrowserNotificationStatus,
} from "../../agentNotifications/browserNotifications";
import {
  getPwaPushConfig,
  registerPwaPushSubscription,
  removePwaPushSubscription,
  testPwaPushSubscription,
} from "../../agentNotifications/pwaPushRelay";
import { DictationMicrophonePicker } from "./DictationMicrophonePicker";
import { DictationKeybindRecorder } from "./DictationKeybindRecorder";
import { DictationSetupAgentButton } from "./DictationSetupAgentButton";

const ENVIRONMENT_IDENTIFICATION_LABELS: Record<EnvironmentIdentificationMode, string> = {
  artwork: "Artwork",
  pill: "Version pill",
  none: "None",
};

const TIMESTAMP_FORMAT_LABELS = {
  locale: "System default",
  "12-hour": "12-hour",
  "24-hour": "24-hour",
} as const;

const DIFF_LAYOUT_LABELS: Record<DiffLayout, string> = {
  stacked: "Stacked",
  split: "Split",
};

const QUIT_CONFIRMATION_MODE_LABELS: Record<QuitConfirmationMode, string> = {
  direct: "Direct",
  hold: "Hold",
  "double-click": "Double press",
};

const BACKGROUND_ACTIVITY_PROFILE_LABELS: Record<BackgroundActivityProfile, string> = {
  balanced: "Balanced",
  performance: "Performance",
  "battery-saver": "Battery saver",
};

type BackgroundActivityProfileOption = BackgroundActivityProfile | "advanced";

const BACKGROUND_ACTIVITY_PROFILE_OPTION_LABELS: Record<BackgroundActivityProfileOption, string> = {
  ...BACKGROUND_ACTIVITY_PROFILE_LABELS,
  advanced: "Advanced",
};

const BACKGROUND_ACTIVITY_PROFILE_DESCRIPTIONS: Record<BackgroundActivityProfile, string> = {
  balanced: "Pauses probes for idle clients, locked hosts, or low power mode.",
  performance: "Allows scoped background probes while any subscribed client remains connected.",
  "battery-saver": "Also pauses background probes when the host or client is on battery.",
};

const ADVANCED_BACKGROUND_ACTIVITY_DESCRIPTION = "Uses custom intervals.";

const DEFAULT_DRIVER_KIND = ProviderDriverKind.make("codex");
const BACKGROUND_ACTIVITY_BOOLEAN_OVERRIDES: ReadonlyArray<{
  readonly key:
    | "pauseWhenHostLocked"
    | "pauseWhenHostLowPower"
    | "pauseWhenClientLowPower"
    | "pauseWhenOnBattery";
  readonly label: string;
}> = [
  { key: "pauseWhenHostLocked", label: "Pause when host is locked" },
  { key: "pauseWhenHostLowPower", label: "Pause on host low power" },
  { key: "pauseWhenClientLowPower", label: "Pause on client low power" },
  { key: "pauseWhenOnBattery", label: "Pause on battery" },
];

function resetBackgroundActivitySettings() {
  return {
    backgroundActivity: DEFAULT_UNIFIED_SETTINGS.backgroundActivity,
  };
}

function backgroundActivityProfileSettings(profile: BackgroundActivityProfile) {
  return {
    backgroundActivity: {
      schemaVersion: 1 as const,
      profile,
      overrides: {},
    },
  };
}

function AboutVersionTitle() {
  return (
    <span className="inline-flex items-baseline gap-2">
      <span>Version</span>
      <code className="text-[11px] font-medium text-muted-foreground">{APP_VERSION}</code>
    </span>
  );
}

function AboutVersionSection() {
  const updateState = useDesktopUpdateState();
  const [isChangingUpdateChannel, setIsChangingUpdateChannel] = useState(false);
  const [isUpdateActionPending, setIsUpdateActionPending] = useState(false);

  const hasDesktopBridge = typeof window !== "undefined" && Boolean(window.desktopBridge);
  const selectedUpdateChannel = updateState?.channel ?? "latest";
  const selectedHostedAppChannel = hasDesktopBridge ? null : HOSTED_APP_CHANNEL;

  const handleUpdateChannelChange = useCallback(
    (channel: DesktopUpdateChannel) => {
      const bridge = window.desktopBridge;
      if (
        !bridge ||
        typeof bridge.setUpdateChannel !== "function" ||
        channel === selectedUpdateChannel
      ) {
        return;
      }

      setIsChangingUpdateChannel(true);
      void bridge
        .setUpdateChannel(channel)
        .catch((error: unknown) => {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not change update track",
              description: error instanceof Error ? error.message : "Update track change failed.",
            }),
          );
        })
        .finally(() => {
          setIsChangingUpdateChannel(false);
        });
    },
    [selectedUpdateChannel],
  );

  const handleButtonClick = useCallback(async () => {
    const bridge = window.desktopBridge;
    if (!bridge) return;

    const action = updateState ? resolveDesktopUpdateButtonAction(updateState) : "none";

    if (action === "download") {
      void bridge.downloadUpdate().catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not download update",
            description: error instanceof Error ? error.message : "Download failed.",
          }),
        );
      });
      return;
    }

    if (action === "install") {
      if (isUpdateActionPending) return;
      setIsUpdateActionPending(true);
      let confirmed = false;
      try {
        confirmed = await ensureLocalApi().dialogs.confirm(
          getDesktopUpdateInstallConfirmationMessage(
            updateState ?? { availableVersion: null, downloadedVersion: null },
          ),
        );
      } catch (error) {
        setIsUpdateActionPending(false);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not confirm update",
            description: error instanceof Error ? error.message : "Update confirmation failed.",
          }),
        );
        return;
      }
      if (!confirmed) {
        setIsUpdateActionPending(false);
        return;
      }
      void bridge
        .installUpdate()
        .catch((error: unknown) => {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not install update",
              description: error instanceof Error ? error.message : "Install failed.",
            }),
          );
        })
        .finally(() => setIsUpdateActionPending(false));
      return;
    }

    if (typeof bridge.checkForUpdate !== "function") return;
    void bridge
      .checkForUpdate()
      .then((result) => {
        if (!result.checked) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not check for updates",
              description:
                result.state.message ?? "Automatic updates are not available in this build.",
            }),
          );
        }
      })
      .catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not check for updates",
            description: error instanceof Error ? error.message : "Update check failed.",
          }),
        );
      });
  }, [isUpdateActionPending, updateState]);

  const action = updateState ? resolveDesktopUpdateButtonAction(updateState) : "none";
  const buttonTooltip = updateState ? getDesktopUpdateButtonTooltip(updateState) : null;
  const buttonDisabled =
    action === "none"
      ? !canCheckForUpdate(updateState)
      : isDesktopUpdateButtonDisabled(updateState);

  const actionLabel: Record<string, string> = { download: "Download", install: "Install" };
  const statusLabel: Record<string, string> = {
    checking: "Checking…",
    downloading: "Downloading…",
    "up-to-date": "Up to Date",
  };
  const buttonLabel =
    actionLabel[action] ?? statusLabel[updateState?.status ?? ""] ?? "Check for Updates";
  const description =
    action === "download" || action === "install"
      ? "Update available."
      : "Current version of the application.";

  return (
    <>
      <SettingsRow
        title={<AboutVersionTitle />}
        description={description}
        control={
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="sm"
                  variant="outline"
                  disabled={buttonDisabled || isUpdateActionPending}
                  onClick={handleButtonClick}
                >
                  {buttonLabel}
                </Button>
              }
            />
            {buttonTooltip ? <TooltipPopup>{buttonTooltip}</TooltipPopup> : null}
          </Tooltip>
        }
      />
      {hasDesktopBridge ? (
        <SettingsRow
          title="Update track"
          description="Use stable releases or nightly builds. Switch back anytime."
          control={
            <Select
              value={selectedUpdateChannel}
              onValueChange={(value) => {
                handleUpdateChannelChange(value as DesktopUpdateChannel);
              }}
            >
              <SelectTrigger
                size="sm"
                className="w-full sm:w-40"
                aria-label="Update track"
                disabled={isChangingUpdateChannel}
              >
                <SelectValue>
                  {selectedUpdateChannel === "nightly" ? "Nightly" : "Stable"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="latest">
                  Stable
                </SelectItem>
                <SelectItem hideIndicator value="nightly">
                  Nightly
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />
      ) : selectedHostedAppChannel ? (
        <SettingsRow
          title="Update track"
          description="Switches the hosted app release channel."
          control={
            <Select
              value={selectedHostedAppChannel}
              onValueChange={(value) => {
                if (value === selectedHostedAppChannel) return;
                window.location.assign(
                  buildHostedChannelSelectionUrl({ channel: value as HostedAppChannel }),
                );
              }}
            >
              <SelectTrigger size="sm" className="w-full sm:w-40" aria-label="Update track">
                <SelectValue>{HOSTED_APP_CHANNEL_LABEL}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="latest">
                  Latest
                </SelectItem>
                <SelectItem hideIndicator value="nightly">
                  Nightly
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />
      ) : null}
    </>
  );
}

export function useSettingsRestore(onRestored?: () => void) {
  const {
    theme,
    setTheme,
    followSystem,
    setFollowSystem,
    setThemeHalf,
    clearThemeHalves,
    themeHalves,
  } = useTheme();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();

  const isTextGenerationModelDirty = !Equal.equals(
    settings.textGenerationModelSelection ?? null,
    DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection ?? null,
  );
  const isBackgroundActivityDirty = hasChangedBackgroundActivitySettings(settings);

  const changedSettingLabels = useMemo(
    () => [
      ...(theme !== "system" ? ["Theme"] : []),
      ...(!followSystem ? ["Follow system"] : []),
      ...(themeHalves !== null ? ["Theme mix"] : []),
      ...(settings.appearanceContrast !== DEFAULT_UNIFIED_SETTINGS.appearanceContrast
        ? ["Contrast"]
        : []),
      ...(settings.glassOpacity !== DEFAULT_UNIFIED_SETTINGS.glassOpacity ? ["Glass opacity"] : []),
      ...(settings.diffColorScheme !== DEFAULT_UNIFIED_SETTINGS.diffColorScheme
        ? ["Diff colors"]
        : []),
      ...(settings.panelAnimationDurationMs !== DEFAULT_UNIFIED_SETTINGS.panelAnimationDurationMs
        ? ["Panel animations"]
        : []),
      ...(settings.environmentIdentificationMode !==
      DEFAULT_UNIFIED_SETTINGS.environmentIdentificationMode
        ? ["Environment identification"]
        : []),
      ...(settings.timestampFormat !== DEFAULT_UNIFIED_SETTINGS.timestampFormat
        ? ["Time format"]
        : []),
      ...(settings.sidebarThreadPreviewCount !== DEFAULT_UNIFIED_SETTINGS.sidebarThreadPreviewCount
        ? ["Visible threads"]
        : []),
      ...(settings.sidebarProjectGroupingMode !==
      DEFAULT_UNIFIED_SETTINGS.sidebarProjectGroupingMode
        ? ["Project Grouping"]
        : []),
      ...(settings.sidebarAutoSettleAfterDays !==
      DEFAULT_UNIFIED_SETTINGS.sidebarAutoSettleAfterDays
        ? ["Auto-settle inactive threads"]
        : []),
      ...(settings.sidebarAutoSettleOnMerge !== DEFAULT_UNIFIED_SETTINGS.sidebarAutoSettleOnMerge
        ? ["Auto-settle merged threads"]
        : []),
      ...(settings.wordWrap !== DEFAULT_UNIFIED_SETTINGS.wordWrap ? ["Word wrap"] : []),
      ...getChangedTypographySettingLabels(settings),
      ...(settings.diffIgnoreWhitespace !== DEFAULT_UNIFIED_SETTINGS.diffIgnoreWhitespace
        ? ["Diff whitespace changes"]
        : []),
      ...(settings.dictationMicrophoneDeviceId !==
      DEFAULT_UNIFIED_SETTINGS.dictationMicrophoneDeviceId
        ? ["Microphone"]
        : []),
      ...(settings.autoOpenPlanSidebar !== DEFAULT_UNIFIED_SETTINGS.autoOpenPlanSidebar
        ? ["Auto-open task panel"]
        : []),
      ...(settings.showSkillsInSlashMenu !== DEFAULT_UNIFIED_SETTINGS.showSkillsInSlashMenu
        ? ["Show skills in slash menu"]
        : []),
      ...(settings.composerCollapseOnScroll !== DEFAULT_UNIFIED_SETTINGS.composerCollapseOnScroll
        ? ["Collapse composer on scroll"]
        : []),
      ...(settings.contextWindowMeterEnabled !== DEFAULT_UNIFIED_SETTINGS.contextWindowMeterEnabled
        ? ["Context window indicator"]
        : []),
      ...(settings.enableLegacyTokenStreaming !==
      DEFAULT_UNIFIED_SETTINGS.enableLegacyTokenStreaming
        ? ["Stream token by token"]
        : []),
      ...(settings.enableProviderUpdateChecks !==
      DEFAULT_UNIFIED_SETTINGS.enableProviderUpdateChecks
        ? ["Provider update checks"]
        : []),
      ...(!Equal.equals(
        settings.continuousImprovement,
        DEFAULT_UNIFIED_SETTINGS.continuousImprovement,
      )
        ? ["Continuous Improvement Mode"]
        : []),
      ...(!Equal.equals(settings.pullRequestRollup, DEFAULT_UNIFIED_SETTINGS.pullRequestRollup)
        ? ["Pull request rollup"]
        : []),
      ...(!Equal.equals(settings.repositoryReview, DEFAULT_UNIFIED_SETTINGS.repositoryReview)
        ? ["Repository review model"]
        : []),
      ...(settings.continueThreadsAfterServerUpdate !==
      DEFAULT_UNIFIED_SETTINGS.continueThreadsAfterServerUpdate
        ? ["Continue threads after restarts"]
        : []),
      ...(isBackgroundActivityDirty ? ["Background activity"] : []),
      ...(settings.defaultThreadEnvMode !== DEFAULT_UNIFIED_SETTINGS.defaultThreadEnvMode
        ? ["New thread mode"]
        : []),
      ...(settings.newWorktreesStartFromOrigin !==
      DEFAULT_UNIFIED_SETTINGS.newWorktreesStartFromOrigin
        ? ["New worktrees start from origin"]
        : []),
      ...(settings.addProjectBaseDirectory !== DEFAULT_UNIFIED_SETTINGS.addProjectBaseDirectory
        ? ["Add project base directory"]
        : []),
      ...(settings.confirmThreadUnpin !== DEFAULT_UNIFIED_SETTINGS.confirmThreadUnpin
        ? ["Unpin confirmation"]
        : []),
      ...(settings.confirmThreadArchive !== DEFAULT_UNIFIED_SETTINGS.confirmThreadArchive
        ? ["Archive confirmation"]
        : []),
      ...(settings.confirmThreadDelete !== DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete
        ? ["Delete confirmation"]
        : []),
      ...(settings.confirmQuit !== DEFAULT_UNIFIED_SETTINGS.confirmQuit ? ["Quit shortcut"] : []),
      ...(isTextGenerationModelDirty ? ["Text generation model"] : []),
      ...getChangedBrowserSettingLabels(settings),
      ...(settings.enableAgentBrowserAccess !== DEFAULT_UNIFIED_SETTINGS.enableAgentBrowserAccess
        ? ["Agent browser access"]
        : []),
    ],
    [
      isTextGenerationModelDirty,
      isBackgroundActivityDirty,
      settings.browserDefaultViewport,
      settings.browserDefaultZoomFactor,
      settings.browserDefaultAppearance,
      settings.browserRecordingFrameRate,
      settings.browserLinkTarget,
      settings.browserAutoShowFloatingPreview,
      settings.appearanceContrast,
      settings.diffColorScheme,
      settings.enableAgentBrowserAccess,
      settings.confirmQuit,
      settings.confirmThreadArchive,
      settings.confirmThreadDelete,
      settings.confirmThreadUnpin,
      settings.composerCollapseOnScroll,
      settings.addProjectBaseDirectory,
      settings.defaultThreadEnvMode,
      settings.newWorktreesStartFromOrigin,
      settings.diffIgnoreWhitespace,
      settings.diffLayout,
      settings.proactivePanelsEnabled,
      settings.environmentIdentificationMode,
      settings.contextWindowMeterEnabled,
      settings.fontFamilyCode,
      settings.fontFamilyComposer,
      settings.fontFamilySans,
      settings.fontFamilyTerminal,
      settings.fontSizeCode,
      settings.fontSizeInterface,
      settings.fontSizePrompt,
      settings.fontSizeTerminal,
      settings.glassOpacity,
      settings.autoOpenPlanSidebar,
      settings.dictationMicrophoneDeviceId,
      settings.dictationStartKeybinds,
      settings.dictationEndKeybinds,
      settings.enableLegacyTokenStreaming,
      settings.enableProviderUpdateChecks,
      settings.continuousImprovement,
      settings.pullRequestRollup,
      settings.repositoryReview,
      settings.sidebarAutoSettleAfterDays,
      settings.sidebarAutoSettleOnMerge,
      settings.sidebarProjectGroupingMode,
      settings.sidebarThreadPreviewCount,
      settings.showSkillsInSlashMenu,
      settings.timestampFormat,
      settings.wordWrap,
      followSystem,
      theme,
      themeHalves,
    ],
  );

  const restoreDefaults = useCallback(async () => {
    if (changedSettingLabels.length === 0) return;
    const api = readLocalApi();
    const confirmed = await (api ?? ensureLocalApi()).dialogs.confirm(
      ["Restore default settings?", `This will reset: ${changedSettingLabels.join(", ")}.`].join(
        "\n",
      ),
      { variant: "destructive" },
    );
    if (!confirmed) return;

    // Only touch the theme keys that are actually dirty, so a theme-storage
    // failure cannot block restoring unrelated settings. Preferences are
    // re-read after the confirmation dialog: they may have changed (another
    // tab, an OS flip) while it was open, and rollback must restore the live
    // values rather than the ones captured at render time.
    let previousTheme = theme;
    try {
      previousTheme = readThemePreference();
    } catch {
      // Storage is unreadable; the render-time value is the best rollback.
    }
    // The mix may have changed while the confirmation dialog was open; both
    // the dirty check and the rollback must see the live value.
    const liveHalves = readThemeHalves();
    const needsThemeReset = previousTheme !== "system";
    const needsMixReset = liveHalves !== null;
    // Same for the appearance mode: trusting the render-time value would skip
    // the reset and report success while a non-system mode stayed in storage.
    const needsFollowSystemReset = readAppearanceModePreference(previousTheme) !== "system";
    const notifyThemeRestoreFailure = () => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Couldn’t restore theme settings",
          description: "Try again.",
        }),
      );
    };
    // Rollback restores the base preference first (which clears any mix) and
    // then re-applies the captured mix on top, so no failure path can leave
    // the pair of keys half-restored.
    const previousHalves = liveHalves;
    const rollbackThemeState = () => {
      if (needsThemeReset) setTheme(previousTheme);
      if (previousHalves?.light) setThemeHalf("light", previousHalves.light);
      if (previousHalves?.dark) setThemeHalf("dark", previousHalves.dark);
    };
    if (needsThemeReset && !setTheme("system")) {
      notifyThemeRestoreFailure();
      return;
    }
    if (needsMixReset && !clearThemeHalves()) {
      rollbackThemeState();
      notifyThemeRestoreFailure();
      return;
    }
    if (needsFollowSystemReset && !setFollowSystem(true)) {
      rollbackThemeState();
      notifyThemeRestoreFailure();
      return;
    }
    updateSettings({
      appearanceContrast: DEFAULT_UNIFIED_SETTINGS.appearanceContrast,
      diffColorScheme: DEFAULT_UNIFIED_SETTINGS.diffColorScheme,
      timestampFormat: DEFAULT_UNIFIED_SETTINGS.timestampFormat,
      wordWrap: DEFAULT_UNIFIED_SETTINGS.wordWrap,
      diffIgnoreWhitespace: DEFAULT_UNIFIED_SETTINGS.diffIgnoreWhitespace,
      diffLayout: DEFAULT_UNIFIED_SETTINGS.diffLayout,
      proactivePanelsEnabled: DEFAULT_UNIFIED_SETTINGS.proactivePanelsEnabled,
      showSkillsInSlashMenu: DEFAULT_UNIFIED_SETTINGS.showSkillsInSlashMenu,
      composerCollapseOnScroll: DEFAULT_UNIFIED_SETTINGS.composerCollapseOnScroll,
      contextWindowMeterEnabled: DEFAULT_UNIFIED_SETTINGS.contextWindowMeterEnabled,
      environmentIdentificationMode: DEFAULT_UNIFIED_SETTINGS.environmentIdentificationMode,
      glassOpacity: DEFAULT_UNIFIED_SETTINGS.glassOpacity,
      panelAnimationDurationMs: DEFAULT_UNIFIED_SETTINGS.panelAnimationDurationMs,
      sidebarThreadPreviewCount: DEFAULT_UNIFIED_SETTINGS.sidebarThreadPreviewCount,
      sidebarProjectGroupingMode: DEFAULT_UNIFIED_SETTINGS.sidebarProjectGroupingMode,
      sidebarAutoSettleAfterDays: DEFAULT_UNIFIED_SETTINGS.sidebarAutoSettleAfterDays,
      sidebarAutoSettleOnMerge: DEFAULT_UNIFIED_SETTINGS.sidebarAutoSettleOnMerge,
      dictationMicrophoneDeviceId: DEFAULT_UNIFIED_SETTINGS.dictationMicrophoneDeviceId,
      dictationStartKeybinds: DEFAULT_UNIFIED_SETTINGS.dictationStartKeybinds,
      dictationEndKeybinds: DEFAULT_UNIFIED_SETTINGS.dictationEndKeybinds,
      autoOpenPlanSidebar: DEFAULT_UNIFIED_SETTINGS.autoOpenPlanSidebar,
      enableLegacyTokenStreaming: DEFAULT_UNIFIED_SETTINGS.enableLegacyTokenStreaming,
      enableProviderUpdateChecks: DEFAULT_UNIFIED_SETTINGS.enableProviderUpdateChecks,
      continuousImprovement: DEFAULT_UNIFIED_SETTINGS.continuousImprovement,
      pullRequestRollup: DEFAULT_UNIFIED_SETTINGS.pullRequestRollup,
      repositoryReview: DEFAULT_UNIFIED_SETTINGS.repositoryReview,
      backgroundActivity: DEFAULT_UNIFIED_SETTINGS.backgroundActivity,
      backgroundActivityProfile: DEFAULT_UNIFIED_SETTINGS.backgroundActivityProfile,
      automaticGitFetchInterval: DEFAULT_UNIFIED_SETTINGS.automaticGitFetchInterval,
      providerHealthRefreshInterval: DEFAULT_UNIFIED_SETTINGS.providerHealthRefreshInterval,
      defaultThreadEnvMode: DEFAULT_UNIFIED_SETTINGS.defaultThreadEnvMode,
      newWorktreesStartFromOrigin: DEFAULT_UNIFIED_SETTINGS.newWorktreesStartFromOrigin,
      addProjectBaseDirectory: DEFAULT_UNIFIED_SETTINGS.addProjectBaseDirectory,
      confirmThreadArchive: DEFAULT_UNIFIED_SETTINGS.confirmThreadArchive,
      confirmThreadDelete: DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete,
      confirmThreadUnpin: DEFAULT_UNIFIED_SETTINGS.confirmThreadUnpin,
      confirmQuit: DEFAULT_UNIFIED_SETTINGS.confirmQuit,
      textGenerationModelSelection: DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection,
      fontFamilySans: DEFAULT_UNIFIED_SETTINGS.fontFamilySans,
      fontFamilyComposer: DEFAULT_UNIFIED_SETTINGS.fontFamilyComposer,
      fontFamilyCode: DEFAULT_UNIFIED_SETTINGS.fontFamilyCode,
      fontFamilyTerminal: DEFAULT_UNIFIED_SETTINGS.fontFamilyTerminal,
      fontSizeInterface: DEFAULT_UNIFIED_SETTINGS.fontSizeInterface,
      fontSizePrompt: DEFAULT_UNIFIED_SETTINGS.fontSizePrompt,
      fontSizeCode: DEFAULT_UNIFIED_SETTINGS.fontSizeCode,
      fontSizeTerminal: DEFAULT_UNIFIED_SETTINGS.fontSizeTerminal,
      browserDefaultViewport: DEFAULT_UNIFIED_SETTINGS.browserDefaultViewport,
      browserDefaultZoomFactor: DEFAULT_UNIFIED_SETTINGS.browserDefaultZoomFactor,
      browserDefaultAppearance: DEFAULT_UNIFIED_SETTINGS.browserDefaultAppearance,
      browserRecordingFrameRate: DEFAULT_UNIFIED_SETTINGS.browserRecordingFrameRate,
      browserLinkTarget: DEFAULT_UNIFIED_SETTINGS.browserLinkTarget,
      browserAutoShowFloatingPreview: DEFAULT_UNIFIED_SETTINGS.browserAutoShowFloatingPreview,
      // Re-granted like any other default. The confirmation dialog lists it by
      // name, so a user restoring defaults is told the agent regains access
      // rather than discovering it later.
      enableAgentBrowserAccess: DEFAULT_UNIFIED_SETTINGS.enableAgentBrowserAccess,
    });
    onRestored?.();
  }, [
    changedSettingLabels,
    clearThemeHalves,
    onRestored,
    setFollowSystem,
    setTheme,
    setThemeHalf,
    theme,
    themeHalves,
    updateSettings,
  ]);

  return {
    changedSettingLabels,
    restoreDefaults,
  };
}

function BackgroundActivityAdvancedDialog({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const resolvedBackgroundActivity = resolveServerBackgroundActivitySettings(settings);
  const activeProfile = resolvedBackgroundActivity.profile;
  const automaticGitFetchIntervalSeconds = durationToSeconds(
    resolvedBackgroundActivity.automaticGitFetchInterval,
  );
  const providerHealthRefreshIntervalSeconds = durationToSeconds(
    resolvedBackgroundActivity.providerHealthRefreshInterval,
  );
  const hostPowerMonitorActiveIntervalSeconds = durationToSeconds(
    resolvedBackgroundActivity.hostPowerMonitorActiveInterval,
  );
  const hostPowerMonitorIdleIntervalSeconds = durationToSeconds(
    resolvedBackgroundActivity.hostPowerMonitorIdleInterval,
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Background Activity</DialogTitle>
          <DialogDescription>
            Tune the shared power policy and the background intervals that feed it.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-0 px-6 pb-5">
          <div className="overflow-hidden rounded-xl border bg-card text-card-foreground">
            <div className="flex flex-col gap-3 border-b px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 space-y-1">
                <div className="text-sm font-medium">Shared policy</div>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Controls whether background work may run after a subscribed interval fires.
                </p>
              </div>
              <Select
                value={activeProfile}
                onValueChange={(value) => {
                  if (
                    value === "balanced" ||
                    value === "performance" ||
                    value === "battery-saver"
                  ) {
                    updateSettings({
                      backgroundActivity: backgroundActivitySharedPolicySettings(settings, value),
                    });
                  }
                }}
              >
                <SelectTrigger
                  size="sm"
                  className="w-full sm:w-40"
                  aria-label="Shared background policy"
                >
                  <SelectValue>{BACKGROUND_ACTIVITY_PROFILE_LABELS[activeProfile]}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem hideIndicator value="balanced">
                    {BACKGROUND_ACTIVITY_PROFILE_LABELS.balanced}
                  </SelectItem>
                  <SelectItem hideIndicator value="performance">
                    {BACKGROUND_ACTIVITY_PROFILE_LABELS.performance}
                  </SelectItem>
                  <SelectItem hideIndicator value="battery-saver">
                    {BACKGROUND_ACTIVITY_PROFILE_LABELS["battery-saver"]}
                  </SelectItem>
                </SelectPopup>
              </Select>
            </div>

            <div className="flex flex-col gap-3 border-b px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 space-y-1">
                <div className="text-sm font-medium">
                  {searchableSetting("git-fetch-interval").title}
                </div>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Refresh remote branch status in the background.
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <NumberField
                  value={automaticGitFetchIntervalSeconds}
                  min={0}
                  step={5}
                  size="sm"
                  className="w-32"
                  onValueChange={(value) =>
                    updateSettings(
                      backgroundActivityOverrideSettings(
                        settings.backgroundActivity,
                        resolvedBackgroundActivity,
                        {
                          automaticGitFetchInterval: Duration.seconds(
                            normalizeIntervalSeconds(value),
                          ),
                        },
                      ),
                    )
                  }
                >
                  <NumberFieldGroup>
                    <NumberFieldDecrement aria-label="Decrease Git fetch interval" />
                    <NumberFieldInput aria-label="Git fetch interval in seconds" />
                    <NumberFieldIncrement aria-label="Increase Git fetch interval" />
                  </NumberFieldGroup>
                </NumberField>
                <span className="text-xs text-muted-foreground">seconds</span>
              </div>
            </div>

            <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 space-y-1">
                <div className="text-sm font-medium">Provider health interval</div>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Refresh provider availability, versions, auth state, and model metadata.
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <NumberField
                  value={providerHealthRefreshIntervalSeconds}
                  min={0}
                  step={PROVIDER_HEALTH_INTERVAL_STEP_SECONDS}
                  size="sm"
                  className="w-32"
                  onValueChange={(value) =>
                    updateSettings(
                      backgroundActivityOverrideSettings(
                        settings.backgroundActivity,
                        resolvedBackgroundActivity,
                        {
                          providerHealthRefreshInterval: Duration.seconds(
                            normalizeIntervalSeconds(value),
                          ),
                        },
                      ),
                    )
                  }
                >
                  <NumberFieldGroup>
                    <NumberFieldDecrement aria-label="Decrease provider health interval" />
                    <NumberFieldInput aria-label="Provider health interval in seconds" />
                    <NumberFieldIncrement aria-label="Increase provider health interval" />
                  </NumberFieldGroup>
                </NumberField>
                <span className="text-xs text-muted-foreground">seconds</span>
              </div>
            </div>

            <div className="flex flex-col gap-3 border-t px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 space-y-1">
                <div className="text-sm font-medium">Host power monitor</div>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Poll host power state while clients are active.
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <NumberField
                  value={hostPowerMonitorActiveIntervalSeconds}
                  min={5}
                  step={5}
                  size="sm"
                  className="w-32"
                  onValueChange={(value) =>
                    updateSettings(
                      backgroundActivityOverrideSettings(
                        settings.backgroundActivity,
                        resolvedBackgroundActivity,
                        {
                          hostPowerMonitorActiveInterval: Duration.seconds(
                            normalizeIntervalSeconds(value, 5),
                          ),
                        },
                      ),
                    )
                  }
                >
                  <NumberFieldGroup>
                    <NumberFieldDecrement aria-label="Decrease active host power interval" />
                    <NumberFieldInput aria-label="Active host power interval in seconds" />
                    <NumberFieldIncrement aria-label="Increase active host power interval" />
                  </NumberFieldGroup>
                </NumberField>
                <span className="text-xs text-muted-foreground">seconds</span>
              </div>
            </div>

            <div className="flex flex-col gap-3 border-t px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 space-y-1">
                <div className="text-sm font-medium">Idle host monitor</div>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Poll host power state when no foreground client is active.
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <NumberField
                  value={hostPowerMonitorIdleIntervalSeconds}
                  min={5}
                  step={30}
                  size="sm"
                  className="w-32"
                  onValueChange={(value) =>
                    updateSettings(
                      backgroundActivityOverrideSettings(
                        settings.backgroundActivity,
                        resolvedBackgroundActivity,
                        {
                          hostPowerMonitorIdleInterval: Duration.seconds(
                            normalizeIntervalSeconds(value, 5),
                          ),
                        },
                      ),
                    )
                  }
                >
                  <NumberFieldGroup>
                    <NumberFieldDecrement aria-label="Decrease idle host power interval" />
                    <NumberFieldInput aria-label="Idle host power interval in seconds" />
                    <NumberFieldIncrement aria-label="Increase idle host power interval" />
                  </NumberFieldGroup>
                </NumberField>
                <span className="text-xs text-muted-foreground">seconds</span>
              </div>
            </div>

            <div className="grid gap-0 border-t sm:grid-cols-2">
              {BACKGROUND_ACTIVITY_BOOLEAN_OVERRIDES.map(({ key, label }) => (
                <label
                  key={key}
                  className="flex items-center justify-between gap-3 border-b px-4 py-3 last:border-b-0 sm:border-r sm:even:border-r-0"
                >
                  <span className="text-sm font-medium">{label}</span>
                  <Switch
                    checked={resolvedBackgroundActivity[key]}
                    onCheckedChange={(checked) =>
                      updateSettings(
                        backgroundActivityOverrideSettings(
                          settings.backgroundActivity,
                          resolvedBackgroundActivity,
                          {
                            [key]: Boolean(checked),
                          },
                        ),
                      )
                    }
                    aria-label={label}
                  />
                </label>
              ))}
            </div>
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => updateSettings(resetBackgroundActivitySettings())}
          >
            Reset all
          </Button>
          <Button onClick={() => onOpenChange(false)}>Done</Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function PwaAppUpdateSettings() {
  const [clearing, setClearing] = useState(false);
  if (typeof window === "undefined" || isElectron) return null;
  return (
    <SettingsSection title="App updates">
      <SettingsRow
        title="Reload the app from the server"
        description="Discards this device's cached app files and fetches the current build. Pairing, environments and settings are untouched."
        control={
          <Button
            variant="outline"
            size="sm"
            disabled={clearing}
            onClick={() => {
              setClearing(true);
              void clearPwaCachesAndReload();
            }}
          >
            {clearing ? "Reloading…" : "Reload from server"}
          </Button>
        }
      />
    </SettingsSection>
  );
}

const AGENT_NOTIFICATION_SOUND_ROWS: readonly {
  readonly kind: AgentNotificationKind;
  readonly title: string;
}[] = [
  { kind: "agent_completed", title: "Agent finished sound" },
  { kind: "plan_ready", title: "Plan ready sound" },
  { kind: "input_required", title: "Needs input sound" },
  { kind: "agent_failed", title: "Agent failed sound" },
];

function PwaNotificationSettings() {
  const primaryEnvironment = usePrimaryEnvironment();
  const notificationPreferences = useClientSettings((value) => value.agentNotifications);
  const updateClientSettings = useUpdateClientSettings();
  const [status, setStatus] = useState<BrowserNotificationStatus>(() =>
    getBrowserNotificationStatus(),
  );
  const [vapidPublicKey, setVapidPublicKey] = useState<string | null>(null);
  const [isConfigLoading, setIsConfigLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const subscriptionIdRef = useRef<string | null>(
    typeof window === "undefined"
      ? null
      : window.localStorage.getItem("t3code.webPushSubscriptionId"),
  );

  const refreshStatus = useCallback(() => {
    setStatus(getBrowserNotificationStatus());
  }, []);

  useEffect(() => {
    window.addEventListener("focus", refreshStatus);
    document.addEventListener("visibilitychange", refreshStatus);
    return () => {
      window.removeEventListener("focus", refreshStatus);
      document.removeEventListener("visibilitychange", refreshStatus);
    };
  }, [refreshStatus]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const applicationServerKey = await getPwaPushConfig();
        if (!cancelled) setVapidPublicKey(applicationServerKey);
      } catch {
        // The relay may not be configured for a local-only installation yet.
      } finally {
        if (!cancelled) setIsConfigLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const updatePreferences = useCallback(
    (patch: Partial<typeof notificationPreferences>) => {
      updateClientSettings({
        agentNotifications: { ...notificationPreferences, ...patch },
      });
    },
    [notificationPreferences, updateClientSettings],
  );

  const persistRemoteSubscription = useCallback(
    async (subscription: PushSubscription, preferences: typeof notificationPreferences) => {
      if (!primaryEnvironment) throw new Error("Connect this PWA to a T3 Code server first.");
      const subscriptionId = await registerPwaPushSubscription({
        environmentId: primaryEnvironment.environmentId,
        subscription,
        preferences,
      });
      subscriptionIdRef.current = subscriptionId;
      window.localStorage.setItem("t3code.webPushSubscriptionId", subscriptionId);
    },
    [primaryEnvironment],
  );

  const enableNotifications = useCallback(async () => {
    if (!vapidPublicKey) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Remote notifications are unavailable",
          description: isConfigLoading
            ? "The relay configuration is still loading. Try again in a moment."
            : "This PWA could not reach its Web Push service. Check this device's T3 Code connection and try again.",
        }),
      );
      return;
    }
    setIsSaving(true);
    try {
      // This is intentionally the first awaited browser operation in the click handler:
      // iOS only permits PushManager.subscribe while the direct user gesture is still valid.
      const result = await subscribeBrowserPush({ applicationServerKey: vapidPublicKey });
      if (result.state !== "subscribed" || result.subscription === null) {
        setStatus(
          result.state === "permission-blocked" ? "permission-blocked" : "permission-needed",
        );
        throw new Error(
          result.state === "not-installed"
            ? "Install T3 Code on your Home Screen before enabling push notifications."
            : result.state === "worker-failed"
              ? "The PWA service worker could not start. Reload the installed app and try again."
              : result.state === "permission-granted"
                ? "Permission is granted. Tap Enable notifications once more to subscribe this installation."
                : "Allow notifications for T3 Code, then try again.",
        );
      }
      const preferences = { ...notificationPreferences, enabled: true };
      await persistRemoteSubscription(result.subscription, preferences);
      updateClientSettings({ agentNotifications: preferences });
      setStatus("ready");
      toastManager.add(
        stackedThreadToast({ type: "success", title: "Remote notifications enabled" }),
      );
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not enable notifications",
          description:
            error instanceof Error ? error.message : "Try again after reloading the PWA.",
        }),
      );
    } finally {
      setIsSaving(false);
    }
  }, [
    isConfigLoading,
    notificationPreferences,
    persistRemoteSubscription,
    updateClientSettings,
    vapidPublicKey,
  ]);

  useEffect(() => {
    if (!notificationPreferences.enabled || subscriptionIdRef.current === null) return;
    void getExistingBrowserPushSubscription()
      .then((subscription) => {
        if (subscription) return persistRemoteSubscription(subscription, notificationPreferences);
      })
      .catch(() => {
        // A later enable interaction will repair a browser subscription that disappeared.
      });
  }, [notificationPreferences, persistRemoteSubscription]);

  const disableNotifications = useCallback(() => {
    void unsubscribeBrowserPush();
    const subscriptionId = subscriptionIdRef.current;
    subscriptionIdRef.current = null;
    window.localStorage.removeItem("t3code.webPushSubscriptionId");
    updatePreferences({ enabled: false });
    if (subscriptionId) {
      void removePwaPushSubscription(subscriptionId).catch(() => {
        // Local unsubscription already prevents delivery for this installation.
      });
    }
  }, [updatePreferences]);

  const remoteTest = useCallback(() => {
    const subscriptionId = subscriptionIdRef.current;
    if (!subscriptionId) return;
    void (async () => {
      try {
        await testPwaPushSubscription(subscriptionId);
        toastManager.add(stackedThreadToast({ type: "success", title: "Remote test queued" }));
      } catch (error) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not queue remote test",
            description:
              error instanceof Error ? error.message : "Try enabling notifications again.",
          }),
        );
      }
    })();
  }, []);

  const previewNotification = useCallback(() => {
    void showBrowserNotificationPreview()
      .then((nextStatus) => {
        setStatus(nextStatus);
        if (nextStatus === "ready") {
          toastManager.add(
            stackedThreadToast({
              type: "success",
              title: "Preview notification sent",
              description: "Check this device's notification center if no banner appears.",
            }),
          );
          return;
        }
        throw new Error("Browser notifications are not ready.");
      })
      .catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not send preview notification",
            description:
              error instanceof Error ? error.message : "Try enabling notifications again.",
          }),
        );
      });
  }, []);

  const statusDescription: Record<BrowserNotificationStatus, string> = {
    unsupported: "Notifications are not supported by this browser or device.",
    "permission-needed": "Allow notifications to enable alerts on this browser or PWA.",
    "permission-blocked": "Notifications are blocked by your browser or system settings.",
    ready: notificationPreferences.enabled
      ? "Notifications are on for this browser or PWA."
      : "Notifications are available on this browser or PWA.",
  };
  const canManagePreferences = status === "ready" && notificationPreferences.enabled;

  return (
    <SettingsSection {...searchableSetting("notifications")}>
      <SettingsRow
        title="Notifications on this device"
        description={statusDescription[status]}
        control={
          <Switch
            checked={notificationPreferences.enabled}
            disabled={status === "unsupported" || isSaving}
            onCheckedChange={(checked) => {
              if (checked) {
                void enableNotifications();
              } else {
                disableNotifications();
              }
            }}
            aria-label="Enable notifications on this device"
          />
        }
      />

      {canManagePreferences ? (
        <>
          <SettingsRow
            title="Preview notification"
            description="Sends a local browser notification on this installation."
            control={
              <Button size="xs" variant="outline" onClick={previewNotification}>
                Send preview
              </Button>
            }
          />
          <SettingsRow
            title="Remote test"
            description="Queues a remote notification for this anonymous PWA installation."
            control={
              <Button
                size="xs"
                variant="outline"
                disabled={subscriptionIdRef.current === null || isSaving}
                onClick={remoteTest}
              >
                Send remote test
              </Button>
            }
          />
          <SettingsRow
            title="Agent finished"
            description="Notify when agent work completes."
            control={
              <Switch
                checked={notificationPreferences.notifyOnCompletion}
                onCheckedChange={(checked) =>
                  updatePreferences({ notifyOnCompletion: Boolean(checked) })
                }
                aria-label="Notify when an agent finishes"
              />
            }
          />
          <SettingsRow
            title="Plan ready"
            description="Notify when an agent proposes a plan for review."
            control={
              <Switch
                checked={notificationPreferences.notifyOnPlanReady}
                onCheckedChange={(checked) =>
                  updatePreferences({ notifyOnPlanReady: Boolean(checked) })
                }
                aria-label="Notify when a plan is ready"
              />
            }
          />
          <SettingsRow
            title="Input needed"
            description="Notify when an agent needs approval or a response."
            control={
              <Switch
                checked={notificationPreferences.notifyOnInput}
                onCheckedChange={(checked) =>
                  updatePreferences({ notifyOnInput: Boolean(checked) })
                }
                aria-label="Notify when agent input is needed"
              />
            }
          />
          <SettingsRow
            title="Agent failed"
            description="Notify when an agent run ends with an error."
            control={
              <Switch
                checked={notificationPreferences.notifyOnFailure}
                onCheckedChange={(checked) =>
                  updatePreferences({ notifyOnFailure: Boolean(checked) })
                }
                aria-label="Notify when an agent fails"
              />
            }
          />
          <SettingsRow
            title="Show project and thread names"
            description="Turn this off to hide work names in notifications and on your lock screen."
            control={
              <Switch
                checked={notificationPreferences.showProjectAndThreadNames}
                onCheckedChange={(checked) =>
                  updatePreferences({ showProjectAndThreadNames: Boolean(checked) })
                }
                aria-label="Show project and thread names in notifications"
              />
            }
          />
          <SettingsRow
            title="Disable notifications"
            description="Turns off notifications for this browser or PWA installation."
            control={
              <Button size="xs" variant="outline" onClick={disableNotifications}>
                Disable
              </Button>
            }
          />
        </>
      ) : null}
      <p className="px-4 pb-2 text-xs text-muted-foreground">
        These settings apply only to this browser or PWA installation, not to your desktop app or
        other devices.
      </p>
    </SettingsSection>
  );
}

function AgentNotificationSoundRow({
  kind,
  title,
  sounds,
  onChange,
}: {
  readonly kind: AgentNotificationKind;
  readonly title: string;
  readonly sounds: AgentNotificationSounds;
  readonly onChange: (kind: AgentNotificationKind, soundId: AgentNotificationSoundId) => void;
}) {
  const selected = sounds[kind];
  return (
    <SettingsRow
      title={title}
      description="Pick the sound this notification plays, or turn it off with None."
      control={
        <div className="flex w-full items-center gap-2 sm:w-56">
          <Select
            value={selected}
            onValueChange={(value) => onChange(kind, value as AgentNotificationSoundId)}
          >
            <SelectTrigger className="w-full" aria-label={title}>
              <SelectValue>{agentNotificationSoundLabel(selected)}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {AGENT_NOTIFICATION_SOUND_IDS.map((soundId) => (
                <SelectItem hideIndicator key={soundId} value={soundId}>
                  {agentNotificationSoundLabel(soundId)}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          <Button
            size="xs"
            variant="outline"
            className="shrink-0"
            disabled={selected === "none"}
            onClick={() => playAgentNotificationSoundId(selected)}
            aria-label={`Preview ${title}`}
          >
            <PlayIcon className="size-3.5" />
          </Button>
        </div>
      }
    />
  );
}

export function AppearanceSettingsPanel() {
  const {
    appearanceMode,
    refreshTheme,
    resolvedTheme,
    setAppearanceMode,
    setTheme,
    setThemeHalf,
    theme,
    themeHalves,
  } = useTheme();
  const customThemes = useCustomThemes();
  const [isImportThemeOpen, setIsImportThemeOpen] = useState(false);
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const environmentStageLabel = useEnvironmentStageLabel();
  const showEnvironmentIdentification =
    resolveEnvironmentIdentificationPillLabel(environmentStageLabel) !== null;
  const glassOpacityRatio =
    (settings.glassOpacity - MIN_GLASS_OPACITY) / (MAX_GLASS_OPACITY - MIN_GLASS_OPACITY);
  const glassOpacitySliderStyle = {
    "--settings-slider-progress": `${glassOpacityRatio * 100}%`,
    "--settings-slider-fill-offset": `${0.5 - glassOpacityRatio}rem`,
  } as CSSProperties;
  const appearanceContrastRatio =
    (settings.appearanceContrast - MIN_APPEARANCE_CONTRAST) /
    (MAX_APPEARANCE_CONTRAST - MIN_APPEARANCE_CONTRAST);
  const appearanceContrastSliderStyle = {
    "--settings-slider-progress": `${appearanceContrastRatio * 100}%`,
    "--settings-slider-fill-offset": `${0.5 - appearanceContrastRatio}rem`,
  } as CSSProperties;
  const panelAnimationDurationRatio =
    (settings.panelAnimationDurationMs - MIN_PANEL_ANIMATION_DURATION_MS) /
    (MAX_PANEL_ANIMATION_DURATION_MS - MIN_PANEL_ANIMATION_DURATION_MS);
  const panelAnimationDurationSliderStyle = {
    "--settings-slider-progress": `${panelAnimationDurationRatio * 100}%`,
    "--settings-slider-fill-offset": `${0.5 - panelAnimationDurationRatio}rem`,
  } as CSSProperties;

  return (
    <SettingsPageContainer>
      <SettingsSection id="appearance" title="Colors & themes" variant="plain" hideTitle>
        <div id={searchableSetting("theme").id}>
          <ThemeLibrary
            appearanceMode={appearanceMode}
            customThemes={customThemes}
            initialAppearance={resolvedTheme}
            refreshTheme={refreshTheme}
            isImportOpen={isImportThemeOpen}
            setAppearanceMode={setAppearanceMode}
            setTheme={setTheme}
            setThemeHalf={setThemeHalf}
            theme={theme}
            themeHalves={themeHalves}
            onImportOpenChange={setIsImportThemeOpen}
          />
        </div>
      </SettingsSection>

      <SettingsSection id="appearance-interface" title="Interface">
        <SettingsRow
          {...searchableSetting("setting-appearance-contrast")}
          description="Adjust the contrast of colors and borders across the interface."
          resetAction={
            settings.appearanceContrast !== DEFAULT_UNIFIED_SETTINGS.appearanceContrast ? (
              <SettingResetButton
                label="contrast"
                onClick={() =>
                  updateSettings({
                    appearanceContrast: DEFAULT_UNIFIED_SETTINGS.appearanceContrast,
                  })
                }
              />
            ) : null
          }
          control={
            <div className="flex w-full items-center gap-3 sm:w-52">
              <output
                className="min-w-12 rounded-md bg-muted px-2 py-1 text-center font-mono text-xs font-medium tabular-nums text-foreground"
                htmlFor="appearance-contrast"
              >
                {settings.appearanceContrast}%
              </output>
              <input
                aria-label="Contrast"
                className="settings-slider min-w-0 flex-1"
                id="appearance-contrast"
                max={MAX_APPEARANCE_CONTRAST}
                min={MIN_APPEARANCE_CONTRAST}
                onChange={(event) => {
                  const appearanceContrast = Number(event.currentTarget.value);
                  if (
                    Number.isInteger(appearanceContrast) &&
                    appearanceContrast >= MIN_APPEARANCE_CONTRAST &&
                    appearanceContrast <= MAX_APPEARANCE_CONTRAST
                  ) {
                    updateSettings({ appearanceContrast });
                  }
                }}
                step={5}
                style={appearanceContrastSliderStyle}
                type="range"
                value={settings.appearanceContrast}
              />
            </div>
          }
        />

        <SettingsRow
          {...searchableSetting("setting-glass-opacity")}
          description="Higher values make menus, dialogs, and the composer more solid."
          resetAction={
            settings.glassOpacity !== DEFAULT_UNIFIED_SETTINGS.glassOpacity ? (
              <SettingResetButton
                label="glass opacity"
                onClick={() =>
                  updateSettings({ glassOpacity: DEFAULT_UNIFIED_SETTINGS.glassOpacity })
                }
              />
            ) : null
          }
          control={
            <div className="flex w-full items-center gap-3 sm:w-52">
              <output
                className="min-w-12 rounded-md bg-muted px-2 py-1 text-center font-mono text-xs font-medium tabular-nums text-foreground"
                htmlFor="glass-opacity"
              >
                {settings.glassOpacity}%
              </output>
              <input
                aria-label="Glass opacity"
                className="settings-slider min-w-0 flex-1"
                id="glass-opacity"
                max={MAX_GLASS_OPACITY}
                min={MIN_GLASS_OPACITY}
                onChange={(event) => {
                  const glassOpacity = Number(event.currentTarget.value);
                  if (
                    Number.isInteger(glassOpacity) &&
                    glassOpacity >= MIN_GLASS_OPACITY &&
                    glassOpacity <= MAX_GLASS_OPACITY
                  ) {
                    updateSettings({ glassOpacity });
                  }
                }}
                step={5}
                style={glassOpacitySliderStyle}
                type="range"
                value={settings.glassOpacity}
              />
            </div>
          }
        />

        {showEnvironmentIdentification ? (
          <SettingsRow
            {...searchableSetting("environment-identification")}
            description="Choose how Dev and Nightly environments are identified."
            resetAction={
              settings.environmentIdentificationMode !== DEFAULT_ENVIRONMENT_IDENTIFICATION_MODE ? (
                <SettingResetButton
                  label="environment identification"
                  onClick={() =>
                    updateSettings({
                      environmentIdentificationMode: DEFAULT_ENVIRONMENT_IDENTIFICATION_MODE,
                    })
                  }
                />
              ) : null
            }
            control={
              <Select
                value={settings.environmentIdentificationMode}
                onValueChange={(value) => {
                  if (value === "artwork" || value === "pill" || value === "none") {
                    updateSettings({ environmentIdentificationMode: value });
                  }
                }}
              >
                <SelectTrigger
                  size="sm"
                  className="w-full sm:w-40"
                  aria-label="Environment identification"
                >
                  <SelectValue>
                    {ENVIRONMENT_IDENTIFICATION_LABELS[settings.environmentIdentificationMode]}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {Object.entries(ENVIRONMENT_IDENTIFICATION_LABELS).map(([value, label]) => (
                    <SelectItem hideIndicator key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />
        ) : null}
        <SettingsRow
          {...searchableSetting("diff-color-scheme")}
          description="Choose colors for additions and deletions, including change counts."
          resetAction={
            settings.diffColorScheme !== DEFAULT_UNIFIED_SETTINGS.diffColorScheme ? (
              <SettingResetButton
                label="diff colors"
                onClick={() =>
                  updateSettings({ diffColorScheme: DEFAULT_UNIFIED_SETTINGS.diffColorScheme })
                }
              />
            ) : null
          }
          control={
            <div className="w-full sm:w-40">
              <Select
                value={settings.diffColorScheme}
                onValueChange={(value) => {
                  if (value === "red-green" || value === "blue-orange")
                    updateSettings({ diffColorScheme: value });
                }}
              >
                <SelectTrigger size="sm" className="w-full min-w-0" aria-label="Diff colors">
                  <span
                    aria-hidden="true"
                    className={
                      settings.diffColorScheme === "blue-orange"
                        ? "flex shrink-0 flex-row-reverse gap-1"
                        : "flex shrink-0 gap-1"
                    }
                  >
                    <span className="size-2 rounded-full bg-[var(--diff-deletion)]" />
                    <span className="size-2 rounded-full bg-[var(--diff-addition)]" />
                  </span>
                  <SelectValue>
                    {settings.diffColorScheme === "blue-orange" ? "Blue & orange" : "Red & green"}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem value="red-green">Red & green (default)</SelectItem>
                  <SelectItem value="blue-orange">Blue & orange</SelectItem>
                </SelectPopup>
              </Select>
            </div>
          }
        />
      </SettingsSection>

      <SettingsSection id="motion" title="Motion">
        <SettingsRow
          {...searchableSetting("panel-animations")}
          description="Set how fast panels open and close."
          control={
            <div className="grid w-full grid-cols-[5rem_minmax(0,1fr)] items-center gap-3 sm:w-auto sm:grid-cols-[7rem_13rem] sm:gap-4">
              <PanelAnimationsPreview durationMs={settings.panelAnimationDurationMs} />
              <div className="flex w-full items-center gap-3">
                <output
                  className="min-w-16 rounded-md bg-muted px-2 py-1 text-center font-mono text-xs font-medium tabular-nums text-foreground"
                  htmlFor="panel-animation-duration"
                >
                  {settings.panelAnimationDurationMs} ms
                </output>
                <input
                  aria-label="Panel animation duration"
                  className="settings-slider min-w-0 flex-1"
                  id="panel-animation-duration"
                  max={MAX_PANEL_ANIMATION_DURATION_MS}
                  min={MIN_PANEL_ANIMATION_DURATION_MS}
                  onChange={(event) => {
                    const panelAnimationDurationMs = Number(event.currentTarget.value);
                    if (
                      Number.isInteger(panelAnimationDurationMs) &&
                      panelAnimationDurationMs >= MIN_PANEL_ANIMATION_DURATION_MS &&
                      panelAnimationDurationMs <= MAX_PANEL_ANIMATION_DURATION_MS
                    ) {
                      updateSettings({ panelAnimationDurationMs });
                    }
                  }}
                  step={25}
                  style={panelAnimationDurationSliderStyle}
                  type="range"
                  value={settings.panelAnimationDurationMs}
                />
              </div>
            </div>
          }
          resetAction={
            settings.panelAnimationDurationMs !==
            DEFAULT_UNIFIED_SETTINGS.panelAnimationDurationMs ? (
              <SettingResetButton
                label="panel animations"
                onClick={() =>
                  updateSettings({
                    panelAnimationDurationMs: DEFAULT_UNIFIED_SETTINGS.panelAnimationDurationMs,
                  })
                }
              />
            ) : null
          }
        />
      </SettingsSection>

      <TypographySection />
    </SettingsPageContainer>
  );
}

function useFontDefaultFamilies() {
  const settings = useScopedSettings();
  // An unset preference shows the font it resolves to on this machine; the
  // default stacks are the platform's own faces, so the name is probed, not
  // hardcoded.
  const defaults = useMemo(
    () => ({
      sans: resolveDefaultFamilyLabel(DEFAULT_SANS_FONT_STACK) ?? "System default",
      code: resolveDefaultFamilyLabel(DEFAULT_CODE_FONT_STACK) ?? "System monospace",
    }),
    [],
  );
  return {
    sans: defaults.sans,
    code: defaults.code,
    // The composer inherits whatever the interface preference resolves to.
    interfaceFamily: settings.fontFamilySans.trim() || defaults.sans,
  };
}

function InterfaceFontRow({ preview }: { preview?: ReactNode }) {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const defaults = useFontDefaultFamilies();
  return (
    <FontFamilySettingsRow
      {...searchableSetting("interface-font")}
      description="Everything outside code blocks and the terminal."
      defaultFamily={defaults.sans}
      defaultValue={DEFAULT_UNIFIED_SETTINGS.fontFamilySans}
      value={settings.fontFamilySans}
      onValueChange={(fontFamilySans) => updateSettings({ fontFamilySans })}
      onReset={() =>
        updateSettings({
          fontFamilySans: DEFAULT_UNIFIED_SETTINGS.fontFamilySans,
          fontSizeInterface: DEFAULT_UNIFIED_SETTINGS.fontSizeInterface,
        })
      }
      size={{
        label: "Interface font size",
        min: MIN_INTERFACE_FONT_SIZE,
        max: MAX_INTERFACE_FONT_SIZE,
        value: settings.fontSizeInterface,
        defaultValue: DEFAULT_UNIFIED_SETTINGS.fontSizeInterface,
        onChange: (fontSizeInterface) => updateSettings({ fontSizeInterface }),
      }}
      {...(preview !== undefined ? { preview } : {})}
    />
  );
}

function PromptFontRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const defaults = useFontDefaultFamilies();
  return (
    <FontFamilySettingsRow
      {...searchableSetting("prompt-font")}
      description="Only the box you write prompts in. Mono works well here."
      defaultFamily={defaults.interfaceFamily}
      defaultValue={DEFAULT_UNIFIED_SETTINGS.fontFamilyComposer}
      value={settings.fontFamilyComposer}
      onValueChange={(fontFamilyComposer) => updateSettings({ fontFamilyComposer })}
      onReset={() =>
        updateSettings({
          fontFamilyComposer: DEFAULT_UNIFIED_SETTINGS.fontFamilyComposer,
          fontSizePrompt: DEFAULT_UNIFIED_SETTINGS.fontSizePrompt,
        })
      }
      size={{
        label: "Prompt font size",
        min: MIN_PROMPT_FONT_SIZE,
        max: MAX_PROMPT_FONT_SIZE,
        value: settings.fontSizePrompt,
        defaultValue: DEFAULT_UNIFIED_SETTINGS.fontSizePrompt,
        onChange: (fontSizePrompt) => updateSettings({ fontSizePrompt }),
      }}
      preview={<PromptFontPreview />}
    />
  );
}

function CodeFontRow({
  title,
  description = "Code blocks, diffs, and file previews.",
  preview,
}: {
  title?: string;
  description?: string;
  preview?: ReactNode;
}) {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const defaults = useFontDefaultFamilies();
  return (
    <FontFamilySettingsRow
      {...searchableSetting("code-font")}
      {...(title !== undefined ? { title } : {})}
      description={description}
      defaultFamily={defaults.code}
      defaultValue={DEFAULT_UNIFIED_SETTINGS.fontFamilyCode}
      value={settings.fontFamilyCode}
      onValueChange={(fontFamilyCode) => updateSettings({ fontFamilyCode })}
      onReset={() =>
        updateSettings({
          fontFamilyCode: DEFAULT_UNIFIED_SETTINGS.fontFamilyCode,
          fontSizeCode: DEFAULT_UNIFIED_SETTINGS.fontSizeCode,
        })
      }
      requireMonospace
      size={{
        label: "Code font size",
        min: MIN_CODE_FONT_SIZE,
        max: MAX_CODE_FONT_SIZE,
        value: settings.fontSizeCode,
        defaultValue: DEFAULT_UNIFIED_SETTINGS.fontSizeCode,
        onChange: (fontSizeCode) => updateSettings({ fontSizeCode }),
      }}
      preview={preview ?? <CodeFontPreview />}
    />
  );
}

function TerminalFontRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const defaults = useFontDefaultFamilies();
  return (
    <FontFamilySettingsRow
      {...searchableSetting("terminal-font")}
      description="Terminal output, independent from code blocks and diffs."
      defaultFamily={defaults.code}
      defaultValue={DEFAULT_UNIFIED_SETTINGS.fontFamilyTerminal}
      value={settings.fontFamilyTerminal}
      onValueChange={(fontFamilyTerminal) => updateSettings({ fontFamilyTerminal })}
      onReset={() =>
        updateSettings({
          fontFamilyTerminal: DEFAULT_UNIFIED_SETTINGS.fontFamilyTerminal,
          fontSizeTerminal: DEFAULT_UNIFIED_SETTINGS.fontSizeTerminal,
        })
      }
      requireMonospace
      size={{
        label: "Terminal font size",
        min: MIN_TERMINAL_FONT_SIZE,
        max: MAX_TERMINAL_FONT_SIZE,
        value: settings.fontSizeTerminal,
        defaultValue: DEFAULT_UNIFIED_SETTINGS.fontSizeTerminal,
        onChange: (fontSizeTerminal) => updateSettings({ fontSizeTerminal }),
      }}
      preview={
        <TerminalFontPreview
          family={resolveTerminalFontPreference({
            advanced: true,
            code: settings.fontFamilyCode,
            terminal: settings.fontFamilyTerminal,
          })}
          size={settings.fontSizeTerminal}
        />
      }
    />
  );
}

function FontSmoothingRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  if (!isMacPlatform(navigator.platform)) return null;
  return (
    <SettingsRow
      {...searchableSetting("font-smoothing")}
      description="Use thinner grayscale text smoothing instead of the macOS default."
      resetAction={
        settings.fontSmoothing !== DEFAULT_UNIFIED_SETTINGS.fontSmoothing ? (
          <SettingResetButton
            label="font smoothing"
            onClick={() =>
              updateSettings({ fontSmoothing: DEFAULT_UNIFIED_SETTINGS.fontSmoothing })
            }
          />
        ) : null
      }
      control={
        <Switch
          checked={settings.fontSmoothing}
          onCheckedChange={(checked) => updateSettings({ fontSmoothing: Boolean(checked) })}
          aria-label="Font smoothing"
        />
      }
    />
  );
}

function WordWrapRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      {...searchableSetting("word-wrap")}
      description="Wrap long lines in code blocks, tables, diffs, and file previews by default."
      resetAction={
        settings.wordWrap !== DEFAULT_UNIFIED_SETTINGS.wordWrap ? (
          <SettingResetButton
            label="word wrapping"
            onClick={() => updateSettings({ wordWrap: DEFAULT_UNIFIED_SETTINGS.wordWrap })}
          />
        ) : null
      }
      control={
        <Switch
          checked={settings.wordWrap}
          onCheckedChange={(checked) => updateSettings({ wordWrap: Boolean(checked) })}
          aria-label="Wrap code, tables, diffs, and file previews by default"
        />
      }
    />
  );
}

function FontSettingsGroup() {
  return (
    <>
      <InterfaceFontRow />
      <PromptFontRow />
      <CodeFontRow />
      <TerminalFontRow />
      <FontSmoothingRow />
    </>
  );
}

/**
 * The two-font view: one sans, one monospace. The prompt follows the
 * interface font and the terminal follows the monospace font, so the demos
 * under each row show every surface the choice reaches.
 */
function SimpleFontRows() {
  const settings = useScopedSettings();
  return (
    <>
      <InterfaceFontRow preview={<PromptFontPreview />} />
      <CodeFontRow
        title="Monospace font"
        description="Code blocks, diffs, file previews, and the terminal."
        preview={
          <>
            <CodeFontPreview />
            <TerminalFontPreview
              family={resolveTerminalFontPreference({
                advanced: false,
                code: settings.fontFamilyCode,
                terminal: settings.fontFamilyTerminal,
              })}
              size={resolveTerminalFontSizePreference({
                advanced: false,
                code: settings.fontSizeCode,
                terminal: settings.fontSizeTerminal,
              })}
            />
          </>
        }
      />
    </>
  );
}

// Font smoothing only renders on macOS, so a search jump to it elsewhere
// must not flip the section - the target would never mount to be scrolled to.
const ADVANCED_TYPOGRAPHY_TARGET_IDS: ReadonlySet<string> = new Set([
  "prompt-font",
  "terminal-font",
  ...(typeof navigator !== "undefined" && isMacPlatform(navigator.platform)
    ? ["font-smoothing"]
    : []),
]);

/**
 * The two-font view by default - one sans, one monospace, each cascading to
 * every surface it reaches - with an Advanced switch in the section header
 * that reveals the per-surface override rows. The choice persists locally,
 * and a settings-search jump to an override row flips Advanced on so the
 * target exists to scroll to.
 */
function TypographySection() {
  const [advanced, setAdvanced] = useLocalStorage(
    TYPOGRAPHY_ADVANCED_STORAGE_KEY,
    false,
    Schema.Boolean,
  );
  const searchTargetId = useSettingsSearchTargetId();
  // Flip Advanced on once per search jump so the hidden target can mount and
  // scroll; tracking the handled id lets the user turn it back off without
  // the still-set target immediately re-expanding the section.
  const lastExpandedTargetRef = useRef<string | null>(null);
  useEffect(() => {
    if (searchTargetId === null || !ADVANCED_TYPOGRAPHY_TARGET_IDS.has(searchTargetId)) return;
    if (lastExpandedTargetRef.current === searchTargetId) return;
    lastExpandedTargetRef.current = searchTargetId;
    setAdvanced(true);
  }, [searchTargetId, setAdvanced]);
  return (
    <SettingsSection
      id="typography"
      title="Typography"
      headerAction={
        <label className="flex cursor-pointer items-center gap-2 text-xs font-medium text-muted-foreground">
          Advanced
          <Switch
            checked={advanced}
            onCheckedChange={(checked) => setAdvanced(Boolean(checked))}
            aria-label="Show advanced typography settings"
          />
        </label>
      }
    >
      {advanced ? <FontSettingsGroup /> : <SimpleFontRows />}
      <WordWrapRow />
    </SettingsSection>
  );
}

function FontFamilySettingsRow({
  id,
  title,
  description,
  defaultFamily,
  defaultValue,
  preview,
  value,
  onValueChange,
  onReset,
  requireMonospace = false,
  size,
}: {
  id?: string;
  title: string;
  description: string;
  /** What an unset preference renders as, e.g. "Menlo". */
  defaultFamily: string;
  /** The persisted family value supplied by the unified settings defaults. */
  defaultValue: string;
  preview?: ReactNode;
  value: string;
  onValueChange: (value: string) => void;
  onReset: () => void;
  requireMonospace?: boolean;
  size: {
    label: string;
    min: number;
    max: number;
    value: number;
    defaultValue: number;
    onChange: (v: number) => void;
  };
}) {
  const trimmed = value.trim();
  // The fallback input edits a draft; the preference only commits once typing
  // pauses and the text probes as an available font (or is an explicit
  // clear), so the current font holds and nothing reflows mid-word.
  const [draft, setDraft] = useState(value);
  const [draftSettled, setDraftSettled] = useState(true);
  const commitTimerRef = useRef<number | null>(null);
  const lastValueRef = useRef(value);
  if (lastValueRef.current !== value) {
    // The committed value changed externally (hydration, reset, picker
    // selection); adopt it and drop any pending commit of a stale draft.
    lastValueRef.current = value;
    if (commitTimerRef.current !== null) {
      window.clearTimeout(commitTimerRef.current);
      commitTimerRef.current = null;
    }
    setDraft(value);
    setDraftSettled(true);
  }
  useEffect(
    () => () => {
      if (commitTimerRef.current !== null) window.clearTimeout(commitTimerRef.current);
    },
    [],
  );
  const acceptsFamily = (candidate: string) =>
    isFontFamilyAvailable(candidate) && (!requireMonospace || isMonospaceFamily(candidate));
  const commitDraft = (next: string) => {
    setDraftSettled(true);
    // A rejected name stays in the field, flagged: the terminal would silently
    // fall back to its default, so the row must not claim it took the value.
    if (next.trim().length === 0 || acceptsFamily(next)) {
      onValueChange(next);
    }
  };
  const flushDraft = () => {
    if (commitTimerRef.current === null) return;
    window.clearTimeout(commitTimerRef.current);
    commitTimerRef.current = null;
    commitDraft(draft);
  };
  const draftTrimmed = draft.trim();
  // Flag an unknown name only once typing pauses, and never for an empty
  // field - that is the starting state, not a rejected entry.
  const draftPending = draftSettled && draftTrimmed.length > 0 && draftTrimmed !== trimmed;
  const resetToDefault = () => {
    if (commitTimerRef.current !== null) {
      window.clearTimeout(commitTimerRef.current);
      commitTimerRef.current = null;
    }
    setDraft(defaultValue);
    setDraftSettled(true);
    onReset();
  };
  const resetAction =
    value !== defaultValue || size.value !== size.defaultValue ? (
      <SettingResetButton label={title.toLowerCase()} onClick={resetToDefault} />
    ) : null;
  const fontEnumeration = useFontEnumeration();
  // Everyone starts on the plain input; focusing it is the user gesture that
  // runs font discovery. Where the engine can enumerate, the control then
  // upgrades to the picker - popped open when the swap happens under focus,
  // so the interaction continues without a second click.
  const inputFocusedRef = useRef(false);
  const familyControl =
    fontEnumeration.status === "granted" ? (
      <FontFamilyPicker
        ariaLabel={`${title} family`}
        defaultFamily={defaultFamily}
        selectedFamily={trimmed}
        requireMonospace={requireMonospace}
        initialOpen={inputFocusedRef.current}
        onSelect={onValueChange}
      />
    ) : (
      <Input
        size="sm"
        aria-label={`${title} family`}
        aria-invalid={draftPending || undefined}
        autoCapitalize="off"
        autoComplete="off"
        className="min-w-0 flex-1"
        maxLength={200}
        onFocus={() => {
          inputFocusedRef.current = true;
          discoverInstalledFonts();
        }}
        onBlur={() => {
          inputFocusedRef.current = false;
          flushDraft();
        }}
        onChange={(event) => {
          const next = event.currentTarget.value;
          setDraft(next);
          setDraftSettled(false);
          if (commitTimerRef.current !== null) {
            window.clearTimeout(commitTimerRef.current);
          }
          commitTimerRef.current = window.setTimeout(() => {
            commitTimerRef.current = null;
            commitDraft(next);
          }, 400);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") flushDraft();
          if (event.key === "Escape") {
            // Discard uncommitted typing without closing the settings page,
            // which is what an unhandled Escape does.
            event.preventDefault();
            event.stopPropagation();
            if (commitTimerRef.current !== null) {
              window.clearTimeout(commitTimerRef.current);
              commitTimerRef.current = null;
            }
            setDraft(value);
            setDraftSettled(true);
          }
        }}
        placeholder={defaultFamily}
        spellCheck={false}
        value={draft}
      />
    );
  const control = (
    <div className="flex w-full items-center gap-2 sm:w-auto">
      <div className="min-w-0 flex-1 sm:w-44 sm:flex-none">{familyControl}</div>
      <Select
        value={String(size.value)}
        onValueChange={(next) => {
          if (typeof next !== "string") return;
          const parsed = Number(next);
          if (Number.isInteger(parsed) && parsed >= size.min && parsed <= size.max) {
            size.onChange(parsed);
          }
        }}
      >
        <SelectTrigger size="sm" className="w-22 shrink-0" aria-label={size.label}>
          <SelectValue>{size.value} px</SelectValue>
        </SelectTrigger>
        <SelectPopup align="end" alignItemWithTrigger={false}>
          {Array.from({ length: size.max - size.min + 1 }, (_, index) => size.min + index).map(
            (px) => (
              <SelectItem hideIndicator key={px} value={String(px)}>
                {px} px
              </SelectItem>
            ),
          )}
        </SelectPopup>
      </Select>
    </div>
  );
  return (
    <SettingsRow
      {...(id !== undefined ? { id } : {})}
      title={title}
      description={description}
      resetAction={resetAction}
      control={control}
    >
      {preview}
    </SettingsRow>
  );
}

const AUTO_SETTLE_DEFAULT_DAYS = DEFAULT_UNIFIED_SETTINGS.sidebarAutoSettleAfterDays ?? 3;

function AutoSettleDaysInput({
  value,
  onCommit,
}: {
  value: number;
  onCommit: (days: number) => void;
}) {
  // Local draft so the field can be emptied mid-edit; the setting only moves
  // on valid input and snaps back to the persisted value on blur.
  const [draft, setDraft] = useState(String(value));
  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  return (
    <Input
      size="sm"
      type="number"
      min={MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS}
      max={MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS}
      className="w-full sm:w-24"
      value={draft}
      onChange={(event) => {
        setDraft(event.target.value);
        // Number(), not parseInt: "3.5" must be rejected (not truncated to a
        // committed 3 while the field shows 3.5) — commit only when the
        // persisted value matches the displayed one.
        const parsed = Number(event.target.value);
        if (
          Number.isInteger(parsed) &&
          parsed >= MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS &&
          parsed <= MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS
        ) {
          onCommit(parsed);
        }
      }}
      onBlur={() => setDraft(String(value))}
      aria-label="Days of inactivity before auto-settle"
    />
  );
}

// The legacy rows sit behind the fold, so a settings-search jump has to
// expand the section before its target can mount and scroll.
const LEGACY_FEATURE_TARGET_IDS: ReadonlySet<string> = new Set([
  "legacy-plan-mode",
  "legacy-context-window-indicator",
  "legacy-token-streaming",
  "legacy-sidebar",
]);

/**
 * Retired features kept only for users who still depend on them. Collapsed by
 * default so they stay out of the everyday settings path; a settings-search
 * jump to one of the rows unfolds the section.
 */
function LegacyFeaturesSection() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const [open, setOpen] = useState(false);
  const searchTargetId = useSettingsSearchTargetId();
  const targetRef = useSettingsSearchTarget<HTMLElement>("legacy-features");
  // Unfold once per search jump; tracking the handled id lets the user fold
  // the section back up without the still-set target immediately reopening it.
  const lastExpandedTargetRef = useRef<string | null>(null);
  useEffect(() => {
    if (searchTargetId === null) {
      // A handled jump clears the target; forgetting it here lets a later
      // jump to the same row expand the section again.
      lastExpandedTargetRef.current = null;
      return;
    }
    if (!LEGACY_FEATURE_TARGET_IDS.has(searchTargetId)) return;
    if (lastExpandedTargetRef.current === searchTargetId) return;
    lastExpandedTargetRef.current = searchTargetId;
    setOpen(true);
  }, [searchTargetId]);

  return (
    <section id="legacy-features" ref={targetRef} tabIndex={-1} className="space-y-2.5">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger className="group flex min-h-8 w-full items-center gap-2 px-3 sm:px-4">
          <h2 className="text-sm font-normal tracking-[-0.005em] text-foreground/70 transition-colors group-hover:text-foreground">
            Legacy features
          </h2>
          <ChevronRightIcon className="size-4 text-muted-foreground transition-transform duration-200 group-data-panel-open:rotate-90" />
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <div className="relative overflow-visible rounded-xl border border-border/60 bg-card/40 text-foreground shadow-xs/5 [&>*+*]:border-t [&>*+*]:border-border/50 [&>[data-slot=settings-row]]:rounded-none">
            <SettingsRow
              {...searchableSetting("legacy-plan-mode")}
              description="Restore Build/Plan, /plan, /default, and Shift+Tab. Off uses build mode."
              control={
                <Switch
                  checked={settings.planModeEnabled}
                  onCheckedChange={(checked) => {
                    updateSettings({ planModeEnabled: Boolean(checked) });
                  }}
                  aria-label="Plan mode (legacy)"
                />
              }
            />
            <SettingsRow
              {...searchableSetting("legacy-context-window-indicator")}
              description="Shows context window usage as a circular indicator in the composer."
              control={
                <Switch
                  checked={settings.contextWindowMeterEnabled}
                  onCheckedChange={(checked) =>
                    updateSettings({ contextWindowMeterEnabled: Boolean(checked) })
                  }
                  aria-label="Context window indicator (legacy)"
                />
              }
            />
            <SettingsRow
              serverScoped
              settingKeys={["enableLegacyTokenStreaming"]}
              {...searchableSetting("legacy-token-streaming")}
              description="Stream output token by token. This legacy mode is slower and harder to follow."
              control={
                <ScopedSwitch
                  settingKeys={["enableLegacyTokenStreaming"]}
                  checked={settings.enableLegacyTokenStreaming}
                  onCheckedChange={(checked) => {
                    if (!checked) {
                      updateSettings({ enableLegacyTokenStreaming: false });
                      return;
                    }
                    void (async () => {
                      const api = readLocalApi();
                      const confirmed = await (api ?? ensureLocalApi()).dialogs.confirm(
                        [
                          "Turn on token-by-token output?",
                          "It is significantly slower than the default buffered output and hurts the reading experience. This switch exists only for backwards compatibility.",
                        ].join("\n"),
                      );
                      if (confirmed) updateSettings({ enableLegacyTokenStreaming: true });
                    })();
                  }}
                  aria-label="Stream token by token (legacy)"
                />
              }
            />
            <SettingsRow
              {...searchableSetting("legacy-sidebar")}
              description="Restore per-project thread trees instead of the default flat sidebar."
              control={
                <Switch
                  checked={settings.legacySidebarEnabled}
                  onCheckedChange={(checked) =>
                    updateSettings({ legacySidebarEnabled: Boolean(checked) })
                  }
                  aria-label="Sidebar (legacy)"
                />
              }
            />
          </div>
        </CollapsiblePanel>
      </Collapsible>
    </section>
  );
}

function AutomationModelControl({
  selection,
  ariaLabel,
  onChange,
}: {
  readonly selection: ModelSelection;
  readonly ariaLabel: string;
  readonly onChange: (selection: ModelSelection) => void;
}) {
  const settings = usePrimarySettings();
  const serverProviders = useAtomValue(primaryServerProvidersAtom);
  const instanceEntries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(serverProviders), settings),
  );
  const instanceEntry = instanceEntries.find((entry) => entry.instanceId === selection.instanceId);
  const provider = instanceEntry?.driverKind ?? DEFAULT_DRIVER_KIND;
  const modelOptionsByInstance = getCustomModelOptionsByInstance(
    settings,
    serverProviders,
    selection.instanceId,
    selection.model,
  );

  return (
    <div className="flex w-full min-w-0 flex-wrap items-center justify-end gap-1.5 sm:w-auto">
      <ProviderModelPicker
        activeInstanceId={selection.instanceId}
        model={selection.model}
        lockedProvider={null}
        instanceEntries={instanceEntries}
        modelOptionsByInstance={modelOptionsByInstance}
        triggerVariant="outline"
        triggerClassName="min-w-0 max-w-full shrink-0 text-foreground/90 hover:text-foreground"
        triggerAriaLabel={`${ariaLabel} provider account and model`}
        onInstanceModelChange={(instanceId, model) => {
          const options =
            instanceId === selection.instanceId && model === selection.model
              ? selection.options
              : undefined;
          onChange(createModelSelection(instanceId, model, options));
        }}
      />
      <TraitsPicker
        provider={provider}
        models={instanceEntry?.models ?? []}
        model={selection.model}
        prompt=""
        onPromptChange={() => {}}
        modelOptions={selection.options}
        allowPromptInjectedEffort={false}
        planModeEnabled={settings.planModeEnabled}
        triggerVariant="outline"
        triggerClassName="min-w-0 max-w-full shrink-0 text-foreground/90 hover:text-foreground"
        onModelOptionsChange={(options) =>
          onChange(createModelSelection(selection.instanceId, selection.model, options))
        }
      />
    </div>
  );
}

function AutomationIntegerControl({
  value,
  min,
  max,
  label,
  unit,
  onChange,
}: {
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly label: string;
  readonly unit: string;
  readonly onChange: (value: number) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <NumberField
        value={value}
        min={min}
        max={max}
        step={1}
        size="sm"
        className="w-28"
        onValueChange={(next) => {
          if (next === null || !Number.isInteger(next) || next < min || next > max) return;
          onChange(next);
        }}
      >
        <NumberFieldGroup>
          <NumberFieldDecrement aria-label={`Decrease ${label}`} />
          <NumberFieldInput aria-label={label} />
          <NumberFieldIncrement aria-label={`Increase ${label}`} />
        </NumberFieldGroup>
      </NumberField>
      <span className="text-xs text-muted-foreground">{unit}</span>
    </div>
  );
}

export function AutomationSettingsPanel() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const [backgroundActivityDialogOpen, setBackgroundActivityDialogOpen] = useState(false);
  const resolvedBackgroundActivity = resolveServerBackgroundActivitySettings(settings);
  const activeBackgroundActivityProfile = resolvedBackgroundActivity.profile;
  const backgroundActivityProfileOption = resolveBackgroundActivityProfileOption(settings);
  const backgroundActivityDescription =
    backgroundActivityProfileOption === "advanced"
      ? `${ADVANCED_BACKGROUND_ACTIVITY_DESCRIPTION} Current shared policy: ${
          BACKGROUND_ACTIVITY_PROFILE_LABELS[activeBackgroundActivityProfile]
        }.`
      : BACKGROUND_ACTIVITY_PROFILE_DESCRIPTIONS[resolvedBackgroundActivity.profile];
  const canResetBackgroundActivity = !Equal.equals(
    settings.backgroundActivity,
    DEFAULT_UNIFIED_SETTINGS.backgroundActivity,
  );
  const continuousModelDirty = !Equal.equals(
    settings.continuousImprovement.modelSelection,
    DEFAULT_UNIFIED_SETTINGS.continuousImprovement.modelSelection,
  );
  const repositoryReviewModelDirty = !Equal.equals(
    settings.repositoryReview.modelSelection,
    DEFAULT_UNIFIED_SETTINGS.repositoryReview.modelSelection,
  );
  const decisionFollowUpModelDirty = !Equal.equals(
    settings.decisionFollowUp.modelSelection,
    DEFAULT_UNIFIED_SETTINGS.decisionFollowUp.modelSelection,
  );
  const continuousRiskDirty =
    settings.continuousImprovement.maxRiskTier !==
    DEFAULT_UNIFIED_SETTINGS.continuousImprovement.maxRiskTier;
  const continuousConfidenceDirty =
    settings.continuousImprovement.minimumConfidence !==
    DEFAULT_UNIFIED_SETTINGS.continuousImprovement.minimumConfidence;
  const continuousConsolidatePullRequestsDirty =
    settings.continuousImprovement.consolidatePullRequests !==
    DEFAULT_UNIFIED_SETTINGS.continuousImprovement.consolidatePullRequests;
  const continuousRemoveCompletedWorktreesDirty =
    settings.continuousImprovement.removeCompletedWorktrees !==
    DEFAULT_UNIFIED_SETTINGS.continuousImprovement.removeCompletedWorktrees;
  const pullRequestRollupModelDirty = !Equal.equals(
    settings.pullRequestRollup.modelSelection,
    DEFAULT_UNIFIED_SETTINGS.pullRequestRollup.modelSelection,
  );
  const inactiveWorktreeCleanupEnabledDirty =
    settings.inactiveWorktreeCleanup.enabled !==
    DEFAULT_UNIFIED_SETTINGS.inactiveWorktreeCleanup.enabled;
  const inactiveWorktreeCleanupIntervalDirty =
    settings.inactiveWorktreeCleanup.intervalDays !==
    DEFAULT_UNIFIED_SETTINGS.inactiveWorktreeCleanup.intervalDays;
  const inactiveWorktreeCleanupAgeDirty =
    settings.inactiveWorktreeCleanup.minimumInactiveDays !==
    DEFAULT_UNIFIED_SETTINGS.inactiveWorktreeCleanup.minimumInactiveDays;
  const repositoryReviewEnabledDirty =
    settings.repositoryReview.enabled !== DEFAULT_UNIFIED_SETTINGS.repositoryReview.enabled;
  const repositoryReviewIntervalDirty =
    settings.repositoryReview.intervalMinutes !==
    DEFAULT_UNIFIED_SETTINGS.repositoryReview.intervalMinutes;

  return (
    <SettingsPageContainer>
      <SettingsSection title="Agent automations">
        <SettingsRow
          {...searchableSetting("continuous-improvement")}
          description="Continuously starts one implementation agent at a time for open, ready-to-act findings. Each run works in an isolated branch and must deliver through a draft pull request. T3 never merges it automatically."
          resetAction={
            settings.continuousImprovement.enabled !==
            DEFAULT_UNIFIED_SETTINGS.continuousImprovement.enabled ? (
              <SettingResetButton
                label="continuous improvement"
                onClick={() =>
                  updateSettings({
                    continuousImprovement: {
                      ...settings.continuousImprovement,
                      enabled: DEFAULT_UNIFIED_SETTINGS.continuousImprovement.enabled,
                    },
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.continuousImprovement.enabled}
              onCheckedChange={(checked) =>
                updateSettings({
                  continuousImprovement: {
                    ...settings.continuousImprovement,
                    enabled: Boolean(checked),
                  },
                })
              }
              aria-label="Continuous Improvement Mode"
            />
          }
        />

        <SettingsRow
          {...searchableSetting("continuous-improvement-consolidate-prs")}
          className="bg-muted/20 sm:pl-9"
          description="Before starting work, asks the implementation agent to inspect open pull requests and extend one when its goal and affected code are coherently related. Otherwise the agent opens a new draft pull request."
          resetAction={
            continuousConsolidatePullRequestsDirty ? (
              <SettingResetButton
                label="consolidate pull requests"
                onClick={() =>
                  updateSettings({
                    continuousImprovement: {
                      ...settings.continuousImprovement,
                      consolidatePullRequests:
                        DEFAULT_UNIFIED_SETTINGS.continuousImprovement.consolidatePullRequests,
                    },
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.continuousImprovement.consolidatePullRequests}
              onCheckedChange={(checked) =>
                updateSettings({
                  continuousImprovement: {
                    ...settings.continuousImprovement,
                    consolidatePullRequests: Boolean(checked),
                  },
                })
              }
              aria-label="Consolidate pull requests"
            />
          }
        />

        <SettingsRow
          {...searchableSetting("continuous-improvement-remove-worktrees")}
          className="bg-muted/20 sm:pl-9"
          description="Safely removes an automation worktree after its draft pull request is delivered or its finding is confirmed stale. Worktrees with uncommitted changes are retained."
          resetAction={
            continuousRemoveCompletedWorktreesDirty ? (
              <SettingResetButton
                label="remove completed worktrees"
                onClick={() =>
                  updateSettings({
                    continuousImprovement: {
                      ...settings.continuousImprovement,
                      removeCompletedWorktrees:
                        DEFAULT_UNIFIED_SETTINGS.continuousImprovement.removeCompletedWorktrees,
                    },
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.continuousImprovement.removeCompletedWorktrees}
              onCheckedChange={(checked) =>
                updateSettings({
                  continuousImprovement: {
                    ...settings.continuousImprovement,
                    removeCompletedWorktrees: Boolean(checked),
                  },
                })
              }
              aria-label="Remove completed worktrees"
            />
          }
        />

        <SettingsRow
          {...searchableSetting("continuous-improvement-model")}
          className="bg-muted/20 sm:pl-9"
          description="Provider account, model, and effort used when Continuous Improvement starts an implementation agent."
          resetAction={
            continuousModelDirty ? (
              <SettingResetButton
                label="implementation agent model"
                onClick={() =>
                  updateSettings({
                    continuousImprovement: {
                      ...settings.continuousImprovement,
                      modelSelection: DEFAULT_UNIFIED_SETTINGS.continuousImprovement.modelSelection,
                    },
                  })
                }
              />
            ) : null
          }
          control={
            <AutomationModelControl
              selection={settings.continuousImprovement.modelSelection}
              ariaLabel="Implementation agent"
              onChange={(modelSelection) =>
                updateSettings({
                  continuousImprovement: {
                    ...settings.continuousImprovement,
                    modelSelection,
                  },
                })
              }
            />
          }
        />

        <SettingsRow
          {...searchableSetting("continuous-improvement-max-risk")}
          className="bg-muted/20 sm:pl-9"
          description="Highest qualified risk tier that Continuous Improvement may start without approval."
          resetAction={
            continuousRiskDirty ? (
              <SettingResetButton
                label="maximum automation risk"
                onClick={() =>
                  updateSettings({
                    continuousImprovement: {
                      ...settings.continuousImprovement,
                      maxRiskTier: DEFAULT_UNIFIED_SETTINGS.continuousImprovement.maxRiskTier,
                    },
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={settings.continuousImprovement.maxRiskTier}
              onValueChange={(value) => {
                if (
                  value !== "low" &&
                  value !== "medium" &&
                  value !== "high" &&
                  value !== "critical"
                ) {
                  return;
                }
                updateSettings({
                  continuousImprovement: {
                    ...settings.continuousImprovement,
                    maxRiskTier: value,
                  },
                });
              }}
            >
              <SelectTrigger aria-label="Maximum automation risk" className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup alignItemWithTrigger={false}>
                <SelectItem value="low">Low</SelectItem>
                <SelectItem value="medium">Medium</SelectItem>
                <SelectItem value="high">High</SelectItem>
                <SelectItem value="critical">Critical</SelectItem>
              </SelectPopup>
            </Select>
          }
        />

        <SettingsRow
          {...searchableSetting("continuous-improvement-confidence")}
          className="bg-muted/20 sm:pl-9"
          description="Minimum evidence confidence required before Continuous Improvement may start work."
          resetAction={
            continuousConfidenceDirty ? (
              <SettingResetButton
                label="minimum automation confidence"
                onClick={() =>
                  updateSettings({
                    continuousImprovement: {
                      ...settings.continuousImprovement,
                      minimumConfidence:
                        DEFAULT_UNIFIED_SETTINGS.continuousImprovement.minimumConfidence,
                    },
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={settings.continuousImprovement.minimumConfidence}
              onValueChange={(value) => {
                if (value !== "low" && value !== "medium" && value !== "high") return;
                updateSettings({
                  continuousImprovement: {
                    ...settings.continuousImprovement,
                    minimumConfidence: value,
                  },
                });
              }}
            >
              <SelectTrigger aria-label="Minimum automation confidence" className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup alignItemWithTrigger={false}>
                <SelectItem value="low">Low</SelectItem>
                <SelectItem value="medium">Medium</SelectItem>
                <SelectItem value="high">High</SelectItem>
              </SelectPopup>
            </Select>
          }
        />

        <SettingsRow
          {...searchableSetting("inactive-worktree-cleanup")}
          description="Periodically removes inactive T3 worktrees only when they are settled, clean, and their current commit is confirmed on the branch's configured remote after a fetch. Local and remote branches are retained."
          resetAction={
            inactiveWorktreeCleanupEnabledDirty ? (
              <SettingResetButton
                label="inactive worktree cleanup"
                onClick={() =>
                  updateSettings({
                    inactiveWorktreeCleanup: {
                      ...settings.inactiveWorktreeCleanup,
                      enabled: DEFAULT_UNIFIED_SETTINGS.inactiveWorktreeCleanup.enabled,
                    },
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.inactiveWorktreeCleanup.enabled}
              onCheckedChange={(checked) =>
                updateSettings({
                  inactiveWorktreeCleanup: {
                    ...settings.inactiveWorktreeCleanup,
                    enabled: Boolean(checked),
                  },
                })
              }
              aria-label="Inactive worktree cleanup"
            />
          }
        />

        <SettingsRow
          {...searchableSetting("inactive-worktree-cleanup-interval")}
          className="bg-muted/20 sm:pl-9"
          description="Number of days between cleanup scans. Turning the automation on makes its first scan due immediately."
          resetAction={
            inactiveWorktreeCleanupIntervalDirty ? (
              <SettingResetButton
                label="inactive worktree cleanup interval"
                onClick={() =>
                  updateSettings({
                    inactiveWorktreeCleanup: {
                      ...settings.inactiveWorktreeCleanup,
                      intervalDays: DEFAULT_UNIFIED_SETTINGS.inactiveWorktreeCleanup.intervalDays,
                    },
                  })
                }
              />
            ) : null
          }
          control={
            <AutomationIntegerControl
              value={settings.inactiveWorktreeCleanup.intervalDays}
              min={MIN_INACTIVE_WORKTREE_CLEANUP_INTERVAL_DAYS}
              max={MAX_INACTIVE_WORKTREE_CLEANUP_INTERVAL_DAYS}
              label="Inactive worktree cleanup interval in days"
              unit="days"
              onChange={(intervalDays) =>
                updateSettings({
                  inactiveWorktreeCleanup: {
                    ...settings.inactiveWorktreeCleanup,
                    intervalDays,
                  },
                })
              }
            />
          }
        />

        <SettingsRow
          {...searchableSetting("inactive-worktree-cleanup-age")}
          className="bg-muted/20 sm:pl-9"
          description="Minimum age of both the worktree's latest T3 activity and its current commit before removal is allowed."
          resetAction={
            inactiveWorktreeCleanupAgeDirty ? (
              <SettingResetButton
                label="minimum inactive worktree age"
                onClick={() =>
                  updateSettings({
                    inactiveWorktreeCleanup: {
                      ...settings.inactiveWorktreeCleanup,
                      minimumInactiveDays:
                        DEFAULT_UNIFIED_SETTINGS.inactiveWorktreeCleanup.minimumInactiveDays,
                    },
                  })
                }
              />
            ) : null
          }
          control={
            <AutomationIntegerControl
              value={settings.inactiveWorktreeCleanup.minimumInactiveDays}
              min={MIN_INACTIVE_WORKTREE_AGE_DAYS}
              max={MAX_INACTIVE_WORKTREE_AGE_DAYS}
              label="Minimum inactive worktree age in days"
              unit="days"
              onChange={(minimumInactiveDays) =>
                updateSettings({
                  inactiveWorktreeCleanup: {
                    ...settings.inactiveWorktreeCleanup,
                    minimumInactiveDays,
                  },
                })
              }
            />
          }
        />

        <SettingsRow
          {...searchableSetting("pull-request-rollup")}
          description="On an N-day interval, starts an isolated agent for each GitHub repository with eligible open pull requests. The agent reviews the combined changes, repairs allowed problems, and opens one pre-release pull request. It never merges the source or rollup pull requests. Turning this off prevents future scans but does not cancel active work sessions."
          resetAction={
            settings.pullRequestRollup.enabled !==
            DEFAULT_UNIFIED_SETTINGS.pullRequestRollup.enabled ? (
              <SettingResetButton
                label="pull request rollup"
                onClick={() =>
                  updateSettings({
                    pullRequestRollup: {
                      ...settings.pullRequestRollup,
                      enabled: DEFAULT_UNIFIED_SETTINGS.pullRequestRollup.enabled,
                    },
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.pullRequestRollup.enabled}
              onCheckedChange={(checked) =>
                updateSettings({
                  pullRequestRollup: {
                    ...settings.pullRequestRollup,
                    enabled: Boolean(checked),
                  },
                })
              }
              aria-label="Pull request rollup"
            />
          }
        />

        <SettingsRow
          {...searchableSetting("pull-request-rollup-interval")}
          className="bg-muted/20 sm:pl-9"
          description="Number of days between portfolio-wide pull request scans. Turning the automation on makes the first scan due immediately."
          resetAction={
            settings.pullRequestRollup.intervalDays !==
            DEFAULT_UNIFIED_SETTINGS.pullRequestRollup.intervalDays ? (
              <SettingResetButton
                label="pull request rollup interval"
                onClick={() =>
                  updateSettings({
                    pullRequestRollup: {
                      ...settings.pullRequestRollup,
                      intervalDays: DEFAULT_UNIFIED_SETTINGS.pullRequestRollup.intervalDays,
                    },
                  })
                }
              />
            ) : null
          }
          control={
            <AutomationIntegerControl
              value={settings.pullRequestRollup.intervalDays}
              min={MIN_PULL_REQUEST_ROLLUP_INTERVAL_DAYS}
              max={MAX_PULL_REQUEST_ROLLUP_INTERVAL_DAYS}
              label="Pull request rollup interval in days"
              unit="days"
              onChange={(intervalDays) =>
                updateSettings({
                  pullRequestRollup: { ...settings.pullRequestRollup, intervalDays },
                })
              }
            />
          }
        />

        <SettingsRow
          {...searchableSetting("pull-request-rollup-drafts")}
          className="bg-muted/20 sm:pl-9"
          description="Include draft pull requests in the review and rollup pass."
          control={
            <Switch
              checked={settings.pullRequestRollup.includeDrafts}
              onCheckedChange={(checked) =>
                updateSettings({
                  pullRequestRollup: {
                    ...settings.pullRequestRollup,
                    includeDrafts: Boolean(checked),
                  },
                })
              }
              aria-label="Include draft pull requests"
            />
          }
        />

        <SettingsRow
          {...searchableSetting("pull-request-rollup-ready")}
          className="bg-muted/20 sm:pl-9"
          description="Include pull requests that are ready for review."
          control={
            <Switch
              checked={settings.pullRequestRollup.includeReady}
              onCheckedChange={(checked) =>
                updateSettings({
                  pullRequestRollup: {
                    ...settings.pullRequestRollup,
                    includeReady: Boolean(checked),
                  },
                })
              }
              aria-label="Include ready pull requests"
            />
          }
        />

        <SettingsRow
          {...searchableSetting("pull-request-rollup-idle-days")}
          className="bg-muted/20 sm:pl-9"
          description="Only include pull requests that have not changed for this many days. Use 0 to include newly updated work."
          control={
            <AutomationIntegerControl
              value={settings.pullRequestRollup.minimumIdleDays}
              min={MIN_PULL_REQUEST_ROLLUP_IDLE_DAYS}
              max={MAX_PULL_REQUEST_ROLLUP_IDLE_DAYS}
              label="Minimum pull request inactivity in days"
              unit="days"
              onChange={(minimumIdleDays) =>
                updateSettings({
                  pullRequestRollup: { ...settings.pullRequestRollup, minimumIdleDays },
                })
              }
            />
          }
        />

        <SettingsRow
          {...searchableSetting("pull-request-rollup-limit")}
          className="bg-muted/20 sm:pl-9"
          description="Maximum number of pull requests handled per repository in one rollup. The oldest eligible updates are handled first."
          control={
            <AutomationIntegerControl
              value={settings.pullRequestRollup.maximumPullRequests}
              min={MIN_PULL_REQUEST_ROLLUP_LIMIT}
              max={MAX_PULL_REQUEST_ROLLUP_LIMIT}
              label="Maximum pull requests per rollup"
              unit="PRs"
              onChange={(maximumPullRequests) =>
                updateSettings({
                  pullRequestRollup: { ...settings.pullRequestRollup, maximumPullRequests },
                })
              }
            />
          }
        />

        <SettingsRow
          {...searchableSetting("pull-request-rollup-failing-checks")}
          className="bg-muted/20 sm:pl-9"
          description="Allow the agent to diagnose failing checks and push safe repairs to a source pull request branch. Otherwise failing pull requests are excluded."
          control={
            <Switch
              checked={settings.pullRequestRollup.fixFailingChecks}
              onCheckedChange={(checked) =>
                updateSettings({
                  pullRequestRollup: {
                    ...settings.pullRequestRollup,
                    fixFailingChecks: Boolean(checked),
                  },
                })
              }
              aria-label="Repair failing pull request checks"
            />
          }
        />

        <SettingsRow
          {...searchableSetting("pull-request-rollup-conflicts")}
          className="bg-muted/20 sm:pl-9"
          description="Allow the agent to resolve source pull request conflicts on the isolated rollup branch. Otherwise conflicting pull requests are excluded."
          control={
            <Switch
              checked={settings.pullRequestRollup.fixMergeConflicts}
              onCheckedChange={(checked) =>
                updateSettings({
                  pullRequestRollup: {
                    ...settings.pullRequestRollup,
                    fixMergeConflicts: Boolean(checked),
                  },
                })
              }
              aria-label="Resolve pull request conflicts"
            />
          }
        />

        <SettingsRow
          {...searchableSetting("pull-request-rollup-repair-attempts")}
          className="bg-muted/20 sm:pl-9"
          description="Maximum focused repair attempts for each failing or conflicting source pull request. Use 0 to inspect and exclude without repair."
          control={
            <AutomationIntegerControl
              value={settings.pullRequestRollup.repairAttempts}
              min={MIN_PULL_REQUEST_ROLLUP_REPAIR_ATTEMPTS}
              max={MAX_PULL_REQUEST_ROLLUP_REPAIR_ATTEMPTS}
              label="Repair attempts per pull request"
              unit="attempts"
              onChange={(repairAttempts) =>
                updateSettings({
                  pullRequestRollup: { ...settings.pullRequestRollup, repairAttempts },
                })
              }
            />
          }
        />

        <SettingsRow
          {...searchableSetting("pull-request-rollup-target")}
          className="bg-muted/20 sm:pl-9"
          description="Base branch for eligible source pull requests and the pre-release pull request. Leave empty to use each repository's default branch."
          control={
            <DraftInput
              className="w-full sm:w-56"
              value={settings.pullRequestRollup.targetBranch}
              onCommit={(targetBranch) =>
                updateSettings({
                  pullRequestRollup: { ...settings.pullRequestRollup, targetBranch },
                })
              }
              placeholder="Default branch"
              spellCheck={false}
              aria-label="Pull request rollup target branch"
            />
          }
        />

        <SettingsRow
          {...searchableSetting("pull-request-rollup-branch-prefix")}
          className="bg-muted/20 sm:pl-9"
          description="Prefix used for isolated pre-release rollup branches. T3 appends the date and a unique identifier."
          control={
            <DraftInput
              className="w-full sm:w-56"
              value={settings.pullRequestRollup.branchPrefix}
              maxLength={48}
              onCommit={(branchPrefix) => {
                if (branchPrefix.trim().length === 0) return;
                updateSettings({
                  pullRequestRollup: { ...settings.pullRequestRollup, branchPrefix },
                });
              }}
              spellCheck={false}
              aria-label="Pull request rollup branch prefix"
            />
          }
        />

        <SettingsRow
          {...searchableSetting("pull-request-rollup-title")}
          className="bg-muted/20 sm:pl-9"
          description="Title used for the generated pre-release pull request."
          control={
            <DraftInput
              className="w-full sm:w-72"
              value={settings.pullRequestRollup.pullRequestTitle}
              maxLength={120}
              onCommit={(pullRequestTitle) => {
                if (pullRequestTitle.trim().length === 0) return;
                updateSettings({
                  pullRequestRollup: { ...settings.pullRequestRollup, pullRequestTitle },
                });
              }}
              aria-label="Pre-release pull request title"
            />
          }
        />

        <SettingsRow
          {...searchableSetting("pull-request-rollup-draft-output")}
          className="bg-muted/20 sm:pl-9"
          description="Keep the generated pre-release pull request in draft until a user explicitly marks it ready."
          control={
            <Switch
              checked={settings.pullRequestRollup.openAsDraft}
              onCheckedChange={(checked) =>
                updateSettings({
                  pullRequestRollup: {
                    ...settings.pullRequestRollup,
                    openAsDraft: Boolean(checked),
                  },
                })
              }
              aria-label="Open pre-release pull request as draft"
            />
          }
        />

        <SettingsRow
          {...searchableSetting("pull-request-rollup-remove-worktrees")}
          className="bg-muted/20 sm:pl-9"
          description="Safely remove a clean rollup worktree after T3 verifies the generated pull request."
          control={
            <Switch
              checked={settings.pullRequestRollup.removeCompletedWorktrees}
              onCheckedChange={(checked) =>
                updateSettings({
                  pullRequestRollup: {
                    ...settings.pullRequestRollup,
                    removeCompletedWorktrees: Boolean(checked),
                  },
                })
              }
              aria-label="Remove completed rollup worktrees"
            />
          }
        />

        <SettingsRow
          {...searchableSetting("pull-request-rollup-instructions")}
          className="bg-muted/20 sm:pl-9"
          description="Optional repository-agnostic instructions added to every rollup agent, such as release-note or validation requirements."
          control={
            <DraftInput
              className="w-full sm:w-80"
              value={settings.pullRequestRollup.customInstructions}
              maxLength={4000}
              onCommit={(customInstructions) =>
                updateSettings({
                  pullRequestRollup: { ...settings.pullRequestRollup, customInstructions },
                })
              }
              placeholder="No additional instructions"
              aria-label="Pull request rollup instructions"
            />
          }
        />

        <SettingsRow
          {...searchableSetting("pull-request-rollup-model")}
          className="bg-muted/20 sm:pl-9"
          description="Provider account, model, and effort used to review, repair, and roll up pull requests."
          resetAction={
            pullRequestRollupModelDirty ? (
              <SettingResetButton
                label="pull request rollup model"
                onClick={() =>
                  updateSettings({
                    pullRequestRollup: {
                      ...settings.pullRequestRollup,
                      modelSelection: DEFAULT_UNIFIED_SETTINGS.pullRequestRollup.modelSelection,
                    },
                  })
                }
              />
            ) : null
          }
          control={
            <AutomationModelControl
              selection={settings.pullRequestRollup.modelSelection}
              ariaLabel="Pull request rollup"
              onChange={(modelSelection) =>
                updateSettings({
                  pullRequestRollup: { ...settings.pullRequestRollup, modelSelection },
                })
              }
            />
          }
        />

        <SettingsRow
          {...searchableSetting("product-opportunity-discovery")}
          description="Adds a dedicated scout-and-critic pass for evidence-backed UX, workflow, and system capability improvements. Each project needs confirmed product context."
          control={
            <Switch
              checked={settings.productOpportunityDiscovery.enabled}
              onCheckedChange={(checked) =>
                updateSettings({
                  productOpportunityDiscovery: {
                    ...settings.productOpportunityDiscovery,
                    enabled: Boolean(checked),
                  },
                })
              }
              aria-label="Product opportunity discovery"
            />
          }
        />

        <SettingsRow
          {...searchableSetting("product-opportunity-limit")}
          className="bg-muted/20 sm:pl-9"
          description="Maximum validated product opportunities returned during each repository review. Zero-output reviews remain valid."
          control={
            <AutomationIntegerControl
              value={settings.productOpportunityDiscovery.maximumCandidates}
              min={MIN_PRODUCT_OPPORTUNITY_CANDIDATES}
              max={MAX_PRODUCT_OPPORTUNITY_CANDIDATES}
              label="Maximum product opportunities per review"
              unit="opportunities"
              onChange={(maximumCandidates) =>
                updateSettings({
                  productOpportunityDiscovery: {
                    ...settings.productOpportunityDiscovery,
                    maximumCandidates,
                  },
                })
              }
            />
          }
        />

        <SettingsRow
          {...searchableSetting("decision-follow-up")}
          description="Starts read-only conversations for findings that need product judgment, more research, or exceed the unattended implementation risk limit."
          control={
            <Switch
              checked={settings.decisionFollowUp.enabled}
              onCheckedChange={(checked) =>
                updateSettings({
                  decisionFollowUp: {
                    ...settings.decisionFollowUp,
                    enabled: Boolean(checked),
                  },
                })
              }
              aria-label="Decision follow-up"
            />
          }
        />

        <SettingsRow
          {...searchableSetting("decision-follow-up-interval")}
          className="bg-muted/20 sm:pl-9"
          description="How often T3 checks for findings that need a user decision."
          control={
            <Select
              value={String(settings.decisionFollowUp.intervalMinutes)}
              onValueChange={(value) => {
                const intervalMinutes = Number(value);
                if (!Number.isInteger(intervalMinutes)) return;
                updateSettings({
                  decisionFollowUp: { ...settings.decisionFollowUp, intervalMinutes },
                });
              }}
            >
              <SelectTrigger aria-label="Decision follow-up interval" className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup alignItemWithTrigger={false}>
                <SelectItem value="15">Every 15 minutes</SelectItem>
                <SelectItem value="30">Every 30 minutes</SelectItem>
                <SelectItem value="60">Every hour</SelectItem>
                <SelectItem value="360">Every 6 hours</SelectItem>
                <SelectItem value="720">Every 12 hours</SelectItem>
                <SelectItem value="1440">Every day</SelectItem>
              </SelectPopup>
            </Select>
          }
        />

        <SettingsRow
          {...searchableSetting("decision-follow-up-reminders")}
          className="bg-muted/20 sm:pl-9"
          description="Minimum time before T3 may start another conversation about the same unresolved finding."
          control={
            <AutomationIntegerControl
              value={settings.decisionFollowUp.reminderDays}
              min={MIN_DECISION_FOLLOW_UP_REMINDER_DAYS}
              max={MAX_DECISION_FOLLOW_UP_REMINDER_DAYS}
              label="Decision reminder interval in days"
              unit="days"
              onChange={(reminderDays) =>
                updateSettings({
                  decisionFollowUp: { ...settings.decisionFollowUp, reminderDays },
                })
              }
            />
          }
        />

        <SettingsRow
          {...searchableSetting("decision-follow-up-limit")}
          className="bg-muted/20 sm:pl-9"
          description="Maximum new decision conversations started during one scheduled scan."
          control={
            <AutomationIntegerControl
              value={settings.decisionFollowUp.maximumConversationsPerRun}
              min={MIN_DECISION_FOLLOW_UP_LIMIT}
              max={MAX_DECISION_FOLLOW_UP_LIMIT}
              label="Maximum decision conversations per scan"
              unit="conversations"
              onChange={(maximumConversationsPerRun) =>
                updateSettings({
                  decisionFollowUp: {
                    ...settings.decisionFollowUp,
                    maximumConversationsPerRun,
                  },
                })
              }
            />
          }
        />

        <SettingsRow
          {...searchableSetting("decision-follow-up-severity")}
          className="bg-muted/20 sm:pl-9"
          description="Minimum severity for ordinary findings. Product opportunities are eligible regardless of severity."
          control={
            <Select
              value={settings.decisionFollowUp.minimumSeverity}
              onValueChange={(minimumSeverity) => {
                if (
                  minimumSeverity !== "info" &&
                  minimumSeverity !== "low" &&
                  minimumSeverity !== "medium" &&
                  minimumSeverity !== "high" &&
                  minimumSeverity !== "critical"
                ) {
                  return;
                }
                updateSettings({
                  decisionFollowUp: { ...settings.decisionFollowUp, minimumSeverity },
                });
              }}
            >
              <SelectTrigger aria-label="Decision follow-up minimum severity" className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup alignItemWithTrigger={false}>
                <SelectItem value="info">Info and above</SelectItem>
                <SelectItem value="low">Low and above</SelectItem>
                <SelectItem value="medium">Medium and above</SelectItem>
                <SelectItem value="high">High and above</SelectItem>
                <SelectItem value="critical">Critical only</SelectItem>
              </SelectPopup>
            </Select>
          }
        />

        <SettingsRow
          {...searchableSetting("decision-follow-up-research")}
          className="bg-muted/20 sm:pl-9"
          description="Include findings whose next step still needs product context, external facts, or human judgment."
          control={
            <Switch
              checked={settings.decisionFollowUp.includeNeedsResearch}
              onCheckedChange={(checked) =>
                updateSettings({
                  decisionFollowUp: {
                    ...settings.decisionFollowUp,
                    includeNeedsResearch: Boolean(checked),
                  },
                })
              }
              aria-label="Include findings that need research"
            />
          }
        />

        <SettingsRow
          {...searchableSetting("decision-follow-up-risk")}
          className="bg-muted/20 sm:pl-9"
          description="Include ready findings whose technical risk exceeds the Continuous Improvement limit. User approval does not lower that risk."
          control={
            <Switch
              checked={settings.decisionFollowUp.includeAboveRisk}
              onCheckedChange={(checked) =>
                updateSettings({
                  decisionFollowUp: {
                    ...settings.decisionFollowUp,
                    includeAboveRisk: Boolean(checked),
                  },
                })
              }
              aria-label="Include findings above the automation risk limit"
            />
          }
        />

        <SettingsRow
          {...searchableSetting("decision-follow-up-model")}
          className="bg-muted/20 sm:pl-9"
          description="Provider account, model, and effort used to prepare and begin decision conversations."
          resetAction={
            decisionFollowUpModelDirty ? (
              <SettingResetButton
                label="decision follow-up model"
                onClick={() =>
                  updateSettings({
                    decisionFollowUp: {
                      ...settings.decisionFollowUp,
                      modelSelection: DEFAULT_UNIFIED_SETTINGS.decisionFollowUp.modelSelection,
                    },
                  })
                }
              />
            ) : null
          }
          control={
            <AutomationModelControl
              selection={settings.decisionFollowUp.modelSelection}
              ariaLabel="Decision follow-up"
              onChange={(modelSelection) =>
                updateSettings({
                  decisionFollowUp: { ...settings.decisionFollowUp, modelSelection },
                })
              }
            />
          }
        />

        <SettingsRow
          {...searchableSetting("repository-review")}
          description="Periodically inspects repositories and qualifies new or changed findings into implementation-ready work."
          resetAction={
            repositoryReviewEnabledDirty ? (
              <SettingResetButton
                label="scheduled qualification"
                onClick={() =>
                  updateSettings({
                    repositoryReview: {
                      ...settings.repositoryReview,
                      enabled: DEFAULT_UNIFIED_SETTINGS.repositoryReview.enabled,
                    },
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.repositoryReview.enabled}
              onCheckedChange={(checked) =>
                updateSettings({
                  repositoryReview: {
                    ...settings.repositoryReview,
                    enabled: Boolean(checked),
                  },
                })
              }
              aria-label="Scheduled discovery and qualification"
            />
          }
        />

        <SettingsRow
          {...searchableSetting("repository-review-interval")}
          className="bg-muted/20 sm:pl-9"
          description="How often T3 runs the read-only discovery and qualification pass while the app is open."
          resetAction={
            repositoryReviewIntervalDirty ? (
              <SettingResetButton
                label="qualification cadence"
                onClick={() =>
                  updateSettings({
                    repositoryReview: {
                      ...settings.repositoryReview,
                      intervalMinutes: DEFAULT_UNIFIED_SETTINGS.repositoryReview.intervalMinutes,
                    },
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={String(settings.repositoryReview.intervalMinutes)}
              onValueChange={(value) => {
                const intervalMinutes = Number(value);
                if (!Number.isInteger(intervalMinutes)) return;
                updateSettings({
                  repositoryReview: {
                    ...settings.repositoryReview,
                    intervalMinutes,
                  },
                });
              }}
            >
              <SelectTrigger aria-label="Qualification cadence" className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup alignItemWithTrigger={false}>
                <SelectItem value="15">Every 15 minutes</SelectItem>
                <SelectItem value="30">Every 30 minutes</SelectItem>
                <SelectItem value="60">Every hour</SelectItem>
                <SelectItem value="120">Every 2 hours</SelectItem>
                <SelectItem value="360">Every 6 hours</SelectItem>
                <SelectItem value="720">Every 12 hours</SelectItem>
                <SelectItem value="1440">Every day</SelectItem>
              </SelectPopup>
            </Select>
          }
        />

        <SettingsRow
          {...searchableSetting("repository-review-model")}
          className="bg-muted/20 sm:pl-9"
          description="Provider account, model, and effort used for discovery and qualification."
          resetAction={
            repositoryReviewModelDirty ? (
              <SettingResetButton
                label="repository review model"
                onClick={() =>
                  updateSettings({
                    repositoryReview: {
                      ...settings.repositoryReview,
                      modelSelection: DEFAULT_UNIFIED_SETTINGS.repositoryReview.modelSelection,
                    },
                  })
                }
              />
            ) : null
          }
          control={
            <AutomationModelControl
              selection={settings.repositoryReview.modelSelection}
              ariaLabel="Discovery and qualification"
              onChange={(modelSelection) =>
                updateSettings({
                  repositoryReview: { ...settings.repositoryReview, modelSelection },
                })
              }
            />
          }
        />
      </SettingsSection>

      <SettingsSection title="Background services">
        <SettingsRow
          {...searchableSetting("provider-update-checks")}
          description="Check installed provider CLIs for newer available versions."
          resetAction={
            settings.enableProviderUpdateChecks !==
            DEFAULT_UNIFIED_SETTINGS.enableProviderUpdateChecks ? (
              <SettingResetButton
                label="provider update checks"
                onClick={() =>
                  updateSettings({
                    enableProviderUpdateChecks: DEFAULT_UNIFIED_SETTINGS.enableProviderUpdateChecks,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.enableProviderUpdateChecks}
              onCheckedChange={(checked) =>
                updateSettings({ enableProviderUpdateChecks: Boolean(checked) })
              }
              aria-label="Check provider versions"
            />
          }
        />

        <SettingsRow
          {...searchableSetting("background-activity")}
          title={
            <span className="inline-flex items-center gap-1.5">
              Background activity
              <PolicyTooltip>
                This shared policy gates background work such as Git refreshes and provider health
                probes after their individual intervals elapse.
              </PolicyTooltip>
            </span>
          }
          description={backgroundActivityDescription}
          resetAction={
            canResetBackgroundActivity ? (
              <SettingResetButton
                label="background activity"
                onClick={() => updateSettings(resetBackgroundActivitySettings())}
              />
            ) : null
          }
          control={
            <>
              <Select
                value={backgroundActivityProfileOption}
                onValueChange={(value) => {
                  if (value === "advanced") {
                    setBackgroundActivityDialogOpen(true);
                    return;
                  }
                  if (
                    value === "balanced" ||
                    value === "performance" ||
                    value === "battery-saver"
                  ) {
                    updateSettings(backgroundActivityProfileSettings(value));
                  }
                }}
              >
                <SelectTrigger className="w-full sm:w-40" aria-label="Background activity profile">
                  <SelectValue>
                    {BACKGROUND_ACTIVITY_PROFILE_OPTION_LABELS[backgroundActivityProfileOption]}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem hideIndicator value="balanced">
                    {BACKGROUND_ACTIVITY_PROFILE_LABELS.balanced}
                  </SelectItem>
                  <SelectItem hideIndicator value="performance">
                    {BACKGROUND_ACTIVITY_PROFILE_LABELS.performance}
                  </SelectItem>
                  <SelectItem hideIndicator value="battery-saver">
                    {BACKGROUND_ACTIVITY_PROFILE_LABELS["battery-saver"]}
                  </SelectItem>
                  <SelectItem hideIndicator value="advanced">
                    {BACKGROUND_ACTIVITY_PROFILE_OPTION_LABELS.advanced}
                  </SelectItem>
                </SelectPopup>
              </Select>
              {backgroundActivityProfileOption === "advanced" ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        size="icon-sm"
                        variant="outline"
                        aria-label="Configure advanced background activity"
                        onClick={() => setBackgroundActivityDialogOpen(true)}
                      >
                        <SettingsIcon className="size-4" />
                      </Button>
                    }
                  />
                  <TooltipPopup side="top">Configure background activity</TooltipPopup>
                </Tooltip>
              ) : null}
              <BackgroundActivityAdvancedDialog
                open={backgroundActivityDialogOpen}
                onOpenChange={setBackgroundActivityDialogOpen}
              />
            </>
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}

export function GeneralSettingsPanel() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const navigate = useNavigate();
  const { scope, environment, connectedEnvironments } = useSettingsScope();
  // The representative environment supplies the provider list for pickers;
  // a fanned-out model choice is validated against every target before it
  // is written. Per-machine tuning (background activity overrides) still
  // needs exactly one environment.
  const environmentId = environment?.environmentId ?? null;
  const isEnvironmentScope = scope.environmentIds.length === 1 && environmentId !== null;
  const hasServerTargets = connectedEnvironments.length > 0;
  const [backgroundActivityDialogOpen, setBackgroundActivityDialogOpen] = useState(false);
  const notificationPreferences = useClientSettings((value) => value.agentNotifications);
  const updateClientSettings = useUpdateClientSettings();
  const sendNotificationTest = useCallback(() => {
    const bridge = window.desktopBridge;
    if (!bridge || typeof bridge.showAgentNotification !== "function") return;

    const event: AgentNotificationEvent = {
      eventId: `desktop-notification-test:${Date.now()}` as AgentNotificationEvent["eventId"],
      environmentId: "desktop-notification-test" as AgentNotificationEvent["environmentId"],
      threadId: "desktop-notification-test" as AgentNotificationEvent["threadId"],
      kind: "agent_completed",
      occurredAt: new Date().toISOString(),
      deepLink:
        "/threads/desktop-notification-test/desktop-notification-test" as AgentNotificationEvent["deepLink"],
      threadTitle: "T3 Code notification test",
    };

    void bridge.showAgentNotification(event).then((outcome) => {
      if (outcome === "attempted") {
        if (notificationPreferences.playSound) {
          playAgentNotificationSound("agent_completed", notificationPreferences.sounds);
        }
        toastManager.add(
          stackedThreadToast({
            type: "success",
            title: "Test notification sent",
            description: "Check your system notification center if no banner appears.",
          }),
        );
      } else {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not send test notification",
            description: `Notification result: ${outcome}.`,
          }),
        );
      }
    });
  }, [notificationPreferences.playSound, notificationPreferences.sounds]);
  const setNotificationSound = useCallback(
    (kind: AgentNotificationKind, soundId: AgentNotificationSoundId) => {
      updateClientSettings({
        agentNotifications: {
          ...notificationPreferences,
          sounds: { ...notificationPreferences.sounds, [kind]: soundId },
        },
      });
      // Play the new choice immediately: picking a sound you cannot hear is
      // guesswork, and this is the only place it is auditioned in context.
      playAgentNotificationSoundId(soundId);
    },
    [notificationPreferences, updateClientSettings],
  );
  const lastEnabledProjectGroupingMode = useRef<SidebarProjectGroupingMode>(
    readLastEnabledProjectGroupingMode(),
  );
  const serverProviders = environment?.serverConfig?.providers ?? EMPTY_SERVER_PROVIDERS;
  const supportsAutoSettlement =
    connectedEnvironments.length > 0 &&
    connectedEnvironments.every(
      (target) => target.serverConfig?.environment.capabilities.threadAutoSettlement === true,
    );
  const supportsRestartContinuation =
    connectedEnvironments.length > 0 &&
    connectedEnvironments.every(
      (target) => target.serverConfig?.environment.capabilities.threadRestartContinuation === true,
    );

  const textGenerationProviders = serverProviders.filter(
    (provider) => provider.supportsTextGeneration !== false,
  );
  const textGenerationModelSelection = resolveAppModelSelectionState(
    settings,
    textGenerationProviders,
  );
  const textGenInstanceId = textGenerationModelSelection.instanceId;
  const textGenModel = textGenerationModelSelection.model;
  const textGenModelOptions = textGenerationModelSelection.options;
  const textGenerationModelInstanceEntries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(textGenerationProviders), settings),
  );
  const hasTextGenerationProvider = textGenerationModelInstanceEntries.some(
    (entry) => entry.enabled && entry.isAvailable,
  );
  const textGenInstanceEntry = textGenerationModelInstanceEntries.find(
    (entry) => entry.instanceId === textGenInstanceId,
  );
  const textGenProvider: ProviderDriverKind =
    textGenInstanceEntry?.driverKind ?? DEFAULT_DRIVER_KIND;
  const textGenerationModelOptionsByInstance = getCustomModelOptionsByInstance(
    settings,
    textGenerationProviders,
    textGenInstanceId,
    textGenModel,
  );
  const isTextGenerationModelDirty = !Equal.equals(
    settings.textGenerationModelSelection ?? null,
    DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection ?? null,
  );
  const textGenerationModelDisabledReason = useScopedModelDisabledReason(
    settings,
    textGenerationModelInstanceEntries,
  );
  const resolvedBackgroundActivity = resolveServerBackgroundActivitySettings(settings);
  const activeBackgroundActivityProfile = resolvedBackgroundActivity.profile;
  const backgroundActivityProfileOption = resolveBackgroundActivityProfileOption(settings);
  const mixedBackgroundActivity = useScopedSettingsMixed(["backgroundActivity"]);
  const mixedAddProjectBaseDirectory = useScopedSettingsMixed(["addProjectBaseDirectory"]);
  const mixedTextGenerationModel = useScopedSettingsMixed(["textGenerationModelSelection"]);
  const backgroundActivityDescription =
    backgroundActivityProfileOption === "advanced"
      ? `${ADVANCED_BACKGROUND_ACTIVITY_DESCRIPTION} Shared policy: ${
          BACKGROUND_ACTIVITY_PROFILE_LABELS[activeBackgroundActivityProfile]
        }.`
      : BACKGROUND_ACTIVITY_PROFILE_DESCRIPTIONS[resolvedBackgroundActivity.profile];
  const canResetBackgroundActivity = !Equal.equals(
    settings.backgroundActivity,
    DEFAULT_UNIFIED_SETTINGS.backgroundActivity,
  );

  return (
    <SettingsPageContainer>
      <ProjectDefaultsSettings category="general" />
      <SettingsSection id="organization" title="Organization">
        <SettingsRow
          {...searchableSetting("dictation-microphone")}
          description="Choose the microphone used for voice dictation. Detect requests access so T3 can display specific device names."
          resetAction={
            settings.dictationMicrophoneDeviceId !==
            DEFAULT_UNIFIED_SETTINGS.dictationMicrophoneDeviceId ? (
              <SettingResetButton
                label="dictation microphone"
                onClick={() =>
                  updateSettings({
                    dictationMicrophoneDeviceId:
                      DEFAULT_UNIFIED_SETTINGS.dictationMicrophoneDeviceId,
                  })
                }
              />
            ) : null
          }
          control={
            <div className="flex w-full min-w-0 flex-col items-stretch gap-2 sm:w-80 sm:items-end">
              <DictationMicrophonePicker
                value={settings.dictationMicrophoneDeviceId}
                onValueChange={(dictationMicrophoneDeviceId) =>
                  updateSettings({ dictationMicrophoneDeviceId })
                }
              />
              <DictationSetupAgentButton />
            </div>
          }
        />
        <SettingsRow
          {...searchableSetting("dictation-keybinds")}
          title="Dictation keybinds"
          description="Record the shortcuts sent to the focused desktop app when dictation starts and ends."
          resetAction={
            settings.dictationStartKeybinds.length > 0 ||
            settings.dictationEndKeybinds.length > 0 ? (
              <SettingResetButton
                label="dictation keybinds"
                onClick={() =>
                  updateSettings({
                    dictationStartKeybinds: DEFAULT_UNIFIED_SETTINGS.dictationStartKeybinds,
                    dictationEndKeybinds: DEFAULT_UNIFIED_SETTINGS.dictationEndKeybinds,
                  })
                }
              />
            ) : null
          }
          control={
            <div className="flex w-full min-w-0 flex-col gap-2 sm:w-72">
              <DictationKeybindRecorder
                label="Start"
                value={settings.dictationStartKeybinds}
                onValueChange={(dictationStartKeybinds) =>
                  updateSettings({ dictationStartKeybinds })
                }
              />
              <DictationKeybindRecorder
                label="End"
                value={settings.dictationEndKeybinds}
                onValueChange={(dictationEndKeybinds) => updateSettings({ dictationEndKeybinds })}
              />
            </div>
          }
        />

        <SettingsRow
          {...searchableSetting("project-grouping")}
          description="Combine matching repositories across environments."
          resetAction={
            settings.sidebarProjectGroupingMode !==
            DEFAULT_UNIFIED_SETTINGS.sidebarProjectGroupingMode ? (
              <SettingResetButton
                label="project grouping"
                onClick={() =>
                  updateSettings({
                    sidebarProjectGroupingMode: DEFAULT_UNIFIED_SETTINGS.sidebarProjectGroupingMode,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={isProjectGroupingEnabled(settings.sidebarProjectGroupingMode)}
              onCheckedChange={(checked) => {
                if (!checked && settings.sidebarProjectGroupingMode !== "separate") {
                  lastEnabledProjectGroupingMode.current = settings.sidebarProjectGroupingMode;
                  rememberEnabledProjectGroupingMode(settings.sidebarProjectGroupingMode);
                }
                updateSettings({
                  sidebarProjectGroupingMode: projectGroupingModeFromToggle(
                    checked,
                    lastEnabledProjectGroupingMode.current,
                  ),
                });
              }}
              aria-label="Project grouping"
            />
          }
        />

        {supportsAutoSettlement ? (
          <>
            <SettingsRow
              serverScoped
              settingKeys={["sidebarAutoSettleOnMerge"]}
              {...searchableSetting("auto-settle-merged-threads")}
              description="Settle a thread when its pull request merges. Closed pull requests still settle automatically."
              resetAction={
                settings.sidebarAutoSettleOnMerge !==
                DEFAULT_UNIFIED_SETTINGS.sidebarAutoSettleOnMerge ? (
                  <SettingResetButton
                    label="auto-settle on merge"
                    onClick={() =>
                      updateSettings({
                        sidebarAutoSettleOnMerge: DEFAULT_UNIFIED_SETTINGS.sidebarAutoSettleOnMerge,
                      })
                    }
                  />
                ) : null
              }
              control={
                <ScopedSwitch
                  settingKeys={["sidebarAutoSettleOnMerge"]}
                  checked={settings.sidebarAutoSettleOnMerge}
                  onCheckedChange={(checked) =>
                    updateSettings({ sidebarAutoSettleOnMerge: Boolean(checked) })
                  }
                  aria-label="Auto-settle merged threads"
                />
              }
            />

            <SettingsRow
              serverScoped
              settingKeys={["sidebarAutoSettleAfterDays"]}
              {...searchableSetting("auto-settle-inactive-threads")}
              description="Sidebar threads with no activity for this long settle automatically."
              resetAction={
                settings.sidebarAutoSettleAfterDays !==
                DEFAULT_UNIFIED_SETTINGS.sidebarAutoSettleAfterDays ? (
                  <SettingResetButton
                    label="auto-settle"
                    onClick={() =>
                      updateSettings({
                        sidebarAutoSettleAfterDays:
                          DEFAULT_UNIFIED_SETTINGS.sidebarAutoSettleAfterDays,
                      })
                    }
                  />
                ) : null
              }
              control={
                <ScopedSwitch
                  settingKeys={["sidebarAutoSettleAfterDays"]}
                  checked={settings.sidebarAutoSettleAfterDays !== null}
                  onCheckedChange={(checked) =>
                    updateSettings({
                      sidebarAutoSettleAfterDays: checked ? AUTO_SETTLE_DEFAULT_DAYS : null,
                    })
                  }
                  aria-label="Auto-settle inactive threads"
                />
              }
            />
            {settings.sidebarAutoSettleAfterDays !== null ? (
              <SettingsRow
                serverScoped
                settingKeys={["sidebarAutoSettleAfterDays"]}
                title={searchableSetting("days-before-auto-settle").title}
                description="Any new activity un-settles a thread automatically."
                control={
                  <AutoSettleDaysInput
                    value={settings.sidebarAutoSettleAfterDays}
                    onCommit={(days) => updateSettings({ sidebarAutoSettleAfterDays: days })}
                  />
                }
              />
            ) : null}
          </>
        ) : null}
      </SettingsSection>

      <SettingsSection id="behavior" title="Behavior">
        <SettingsRow
          {...searchableSetting("time-format")}
          description="System default follows your browser or OS clock preference."
          resetAction={
            settings.timestampFormat !== DEFAULT_UNIFIED_SETTINGS.timestampFormat ? (
              <SettingResetButton
                label="time format"
                onClick={() =>
                  updateSettings({
                    timestampFormat: DEFAULT_UNIFIED_SETTINGS.timestampFormat,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={settings.timestampFormat}
              onValueChange={(value) => {
                if (value === "locale" || value === "12-hour" || value === "24-hour") {
                  updateSettings({ timestampFormat: value });
                }
              }}
            >
              <SelectTrigger size="sm" className="w-full sm:w-40" aria-label="Timestamp format">
                <SelectValue>{TIMESTAMP_FORMAT_LABELS[settings.timestampFormat]}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="locale">
                  {TIMESTAMP_FORMAT_LABELS.locale}
                </SelectItem>
                <SelectItem hideIndicator value="12-hour">
                  {TIMESTAMP_FORMAT_LABELS["12-hour"]}
                </SelectItem>
                <SelectItem hideIndicator value="24-hour">
                  {TIMESTAMP_FORMAT_LABELS["24-hour"]}
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          {...searchableSetting("hide-whitespace-changes")}
          description="Set whether the diff panel ignores whitespace-only edits by default."
          resetAction={
            settings.diffIgnoreWhitespace !== DEFAULT_UNIFIED_SETTINGS.diffIgnoreWhitespace ? (
              <SettingResetButton
                label="diff whitespace changes"
                onClick={() =>
                  updateSettings({
                    diffIgnoreWhitespace: DEFAULT_UNIFIED_SETTINGS.diffIgnoreWhitespace,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.diffIgnoreWhitespace}
              onCheckedChange={(checked) =>
                updateSettings({ diffIgnoreWhitespace: Boolean(checked) })
              }
              aria-label="Hide whitespace changes by default"
            />
          }
        />
        <SettingsRow
          {...searchableSetting("diff-layout")}
          description="Show diffs stacked or side by side. The toggle in the diff toolbar changes this too."
          resetAction={
            settings.diffLayout !== DEFAULT_UNIFIED_SETTINGS.diffLayout ? (
              <SettingResetButton
                label="diff layout"
                onClick={() => updateSettings({ diffLayout: DEFAULT_UNIFIED_SETTINGS.diffLayout })}
              />
            ) : null
          }
          control={
            <Select
              value={settings.diffLayout}
              onValueChange={(value) => {
                if (value === "stacked" || value === "split") {
                  updateSettings({ diffLayout: value });
                }
              }}
            >
              <SelectTrigger size="sm" className="w-full sm:w-40" aria-label="Diff layout">
                <SelectValue>{DIFF_LAYOUT_LABELS[settings.diffLayout]}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="stacked">
                  {DIFF_LAYOUT_LABELS.stacked}
                </SelectItem>
                <SelectItem hideIndicator value="split">
                  {DIFF_LAYOUT_LABELS.split}
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />

        <SettingsRow
          {...searchableSetting("proactive-panels")}
          description="Open linked pull requests when found and turn diffs when work changes files."
          resetAction={
            settings.proactivePanelsEnabled !== DEFAULT_UNIFIED_SETTINGS.proactivePanelsEnabled ? (
              <SettingResetButton
                label="proactive panels"
                onClick={() =>
                  updateSettings({
                    proactivePanelsEnabled: DEFAULT_UNIFIED_SETTINGS.proactivePanelsEnabled,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.proactivePanelsEnabled}
              onCheckedChange={(checked) =>
                updateSettings({ proactivePanelsEnabled: Boolean(checked) })
              }
              aria-label="Proactive panels"
            />
          }
        />

        <SettingsRow
          {...searchableSetting("skills-in-slash-menu")}
          description="Also include skills in the / command menu. Skills always appear when you type $."
          resetAction={
            settings.showSkillsInSlashMenu !== DEFAULT_UNIFIED_SETTINGS.showSkillsInSlashMenu ? (
              <SettingResetButton
                label="skills in slash menu"
                onClick={() =>
                  updateSettings({
                    showSkillsInSlashMenu: DEFAULT_UNIFIED_SETTINGS.showSkillsInSlashMenu,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.showSkillsInSlashMenu}
              onCheckedChange={(checked) =>
                updateSettings({ showSkillsInSlashMenu: Boolean(checked) })
              }
              aria-label="Show skills in slash menu"
            />
          }
        />

        <SettingsRow
          {...searchableSetting("composer-collapse")}
          description="Rest the composer of an existing thread into a single line when you scroll the conversation. Focus the composer or start typing to expand it again."
          resetAction={
            settings.composerCollapseOnScroll !==
            DEFAULT_UNIFIED_SETTINGS.composerCollapseOnScroll ? (
              <SettingResetButton
                label="collapse composer on scroll"
                onClick={() =>
                  updateSettings({
                    composerCollapseOnScroll: DEFAULT_UNIFIED_SETTINGS.composerCollapseOnScroll,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.composerCollapseOnScroll}
              onCheckedChange={(checked) =>
                updateSettings({ composerCollapseOnScroll: Boolean(checked) })
              }
              aria-label="Collapse composer on scroll"
            />
          }
        />

        <SettingsRow
          serverScoped
          settingKeys={["enableProviderUpdateChecks"]}
          {...searchableSetting("provider-update-checks")}
          description="Check installed provider CLIs for newer available versions."
          resetAction={
            settings.enableProviderUpdateChecks !==
            DEFAULT_UNIFIED_SETTINGS.enableProviderUpdateChecks ? (
              <SettingResetButton
                label="provider update checks"
                onClick={() =>
                  updateSettings({
                    enableProviderUpdateChecks: DEFAULT_UNIFIED_SETTINGS.enableProviderUpdateChecks,
                  })
                }
              />
            ) : null
          }
          control={
            <ScopedSwitch
              settingKeys={["enableProviderUpdateChecks"]}
              checked={settings.enableProviderUpdateChecks}
              onCheckedChange={(checked) =>
                updateSettings({ enableProviderUpdateChecks: Boolean(checked) })
              }
              aria-label="Check provider versions"
            />
          }
        />

        <SettingsRow
          {...searchableSetting("continue-threads-after-server-update")}
          serverScoped
          settingKeys={["continueThreadsAfterServerUpdate"]}
          description="Automatically resume interrupted threads after an update, crash, or machine restart on the selected environments. Update older servers first."
          status={
            !supportsRestartContinuation
              ? "All selected connected environments must support restart continuation."
              : undefined
          }
          resetAction={
            supportsRestartContinuation &&
            settings.continueThreadsAfterServerUpdate !==
              DEFAULT_UNIFIED_SETTINGS.continueThreadsAfterServerUpdate ? (
              <SettingResetButton
                label="continue threads after restarts"
                onClick={() =>
                  updateSettings({
                    continueThreadsAfterServerUpdate:
                      DEFAULT_UNIFIED_SETTINGS.continueThreadsAfterServerUpdate,
                  })
                }
              />
            ) : null
          }
          control={
            <ScopedSwitch
              settingKeys={["continueThreadsAfterServerUpdate"]}
              checked={settings.continueThreadsAfterServerUpdate}
              disabled={!supportsRestartContinuation}
              onCheckedChange={(checked) =>
                updateSettings({ continueThreadsAfterServerUpdate: Boolean(checked) })
              }
              aria-label="Continue threads after restarts"
            />
          }
        />

        <SettingsRow
          serverScoped
          settingKeys={["backgroundActivity"]}
          id={searchableSetting("background-activity").id}
          title={
            <span className="inline-flex items-center gap-1.5">
              {searchableSetting("background-activity").title}
              <PolicyTooltip>
                This shared policy gates background work such as Git refreshes and provider health
                probes after their individual intervals elapse.
              </PolicyTooltip>
            </span>
          }
          description={backgroundActivityDescription}
          resetAction={
            canResetBackgroundActivity ? (
              <SettingResetButton
                label="background activity"
                onClick={() => updateSettings(resetBackgroundActivitySettings())}
              />
            ) : null
          }
          control={
            <>
              <Select
                value={mixedBackgroundActivity ? null : backgroundActivityProfileOption}
                onValueChange={(value) => {
                  if (value === "advanced") {
                    if (isEnvironmentScope) setBackgroundActivityDialogOpen(true);
                    return;
                  }
                  if (
                    value === "balanced" ||
                    value === "performance" ||
                    value === "battery-saver"
                  ) {
                    updateSettings(backgroundActivityProfileSettings(value));
                  }
                }}
              >
                <SelectTrigger
                  size="sm"
                  className="w-full sm:w-40"
                  aria-label="Background activity profile"
                >
                  <SelectValue>
                    {(value: BackgroundActivityProfileOption | null) =>
                      value === null ? "Mixed" : BACKGROUND_ACTIVITY_PROFILE_OPTION_LABELS[value]
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem hideIndicator value="balanced">
                    {BACKGROUND_ACTIVITY_PROFILE_LABELS.balanced}
                  </SelectItem>
                  <SelectItem hideIndicator value="performance">
                    {BACKGROUND_ACTIVITY_PROFILE_LABELS.performance}
                  </SelectItem>
                  <SelectItem hideIndicator value="battery-saver">
                    {BACKGROUND_ACTIVITY_PROFILE_LABELS["battery-saver"]}
                  </SelectItem>
                  <SelectItem hideIndicator value="advanced" disabled={!isEnvironmentScope}>
                    {isEnvironmentScope
                      ? BACKGROUND_ACTIVITY_PROFILE_OPTION_LABELS.advanced
                      : `${BACKGROUND_ACTIVITY_PROFILE_OPTION_LABELS.advanced} (one environment)`}
                  </SelectItem>
                </SelectPopup>
              </Select>
              {backgroundActivityProfileOption === "advanced" && isEnvironmentScope ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        size="icon-sm"
                        variant="outline"
                        aria-label="Configure advanced background activity"
                        onClick={() => setBackgroundActivityDialogOpen(true)}
                      >
                        <SettingsIcon className="size-4" />
                      </Button>
                    }
                  />
                  <TooltipPopup side="top">Configure background activity</TooltipPopup>
                </Tooltip>
              ) : null}
              <BackgroundActivityAdvancedDialog
                open={backgroundActivityDialogOpen && isEnvironmentScope}
                onOpenChange={setBackgroundActivityDialogOpen}
              />
            </>
          }
        />
      </SettingsSection>

      <SettingsSection id="projects-and-threads" title="Projects & threads">
        <SettingsRow
          serverScoped
          settingKeys={["newWorktreesStartFromOrigin"]}
          {...searchableSetting("start-from-origin")}
          description="Creates the worktree from the latest matching branch on origin instead of your local branch."
          resetAction={
            settings.newWorktreesStartFromOrigin !==
            DEFAULT_UNIFIED_SETTINGS.newWorktreesStartFromOrigin ? (
              <SettingResetButton
                label="new worktrees start from origin"
                onClick={() =>
                  updateSettings({
                    newWorktreesStartFromOrigin:
                      DEFAULT_UNIFIED_SETTINGS.newWorktreesStartFromOrigin,
                  })
                }
              />
            ) : null
          }
          control={
            <ScopedSwitch
              settingKeys={["newWorktreesStartFromOrigin"]}
              checked={settings.newWorktreesStartFromOrigin}
              onCheckedChange={(checked) =>
                updateSettings({ newWorktreesStartFromOrigin: Boolean(checked) })
              }
              aria-label="Start new worktrees from origin by default"
            />
          }
        />
        <SettingsRow
          serverScoped
          settingKeys={["addProjectBaseDirectory"]}
          {...searchableSetting("add-project-starts-in")}
          description='Leave empty to use "~/" when the Add Project browser opens.'
          resetAction={
            settings.addProjectBaseDirectory !==
            DEFAULT_UNIFIED_SETTINGS.addProjectBaseDirectory ? (
              <SettingResetButton
                label="add project base directory"
                onClick={() =>
                  updateSettings({
                    addProjectBaseDirectory: DEFAULT_UNIFIED_SETTINGS.addProjectBaseDirectory,
                  })
                }
              />
            ) : null
          }
          control={
            <DraftInput
              size="sm"
              className="w-full sm:w-72"
              value={mixedAddProjectBaseDirectory ? "" : settings.addProjectBaseDirectory}
              onCommit={(next) => updateSettings({ addProjectBaseDirectory: next })}
              placeholder={mixedAddProjectBaseDirectory ? "Mixed" : "~/"}
              spellCheck={false}
              aria-label="Add project base directory"
            />
          }
        />
      </SettingsSection>

      <SettingsSection id="confirmations" title="Confirmations">
        <SettingsRow
          {...searchableSetting("unpin-confirmation")}
          description="Ask before unpinning a thread from the pinned section."
          resetAction={
            settings.confirmThreadUnpin !== DEFAULT_UNIFIED_SETTINGS.confirmThreadUnpin ? (
              <SettingResetButton
                label="unpin confirmation"
                onClick={() =>
                  updateSettings({
                    confirmThreadUnpin: DEFAULT_UNIFIED_SETTINGS.confirmThreadUnpin,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.confirmThreadUnpin}
              onCheckedChange={(checked) =>
                updateSettings({ confirmThreadUnpin: Boolean(checked) })
              }
              aria-label="Confirm thread unpinning"
            />
          }
        />

        <SettingsRow
          {...searchableSetting("archive-confirmation")}
          description="Require a second click on the inline archive action before a thread is archived."
          resetAction={
            settings.confirmThreadArchive !== DEFAULT_UNIFIED_SETTINGS.confirmThreadArchive ? (
              <SettingResetButton
                label="archive confirmation"
                onClick={() =>
                  updateSettings({
                    confirmThreadArchive: DEFAULT_UNIFIED_SETTINGS.confirmThreadArchive,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.confirmThreadArchive}
              onCheckedChange={(checked) =>
                updateSettings({ confirmThreadArchive: Boolean(checked) })
              }
              aria-label="Confirm thread archiving"
            />
          }
        />

        <SettingsRow
          {...searchableSetting("delete-confirmation")}
          description="Ask before deleting a thread and its chat history."
          resetAction={
            settings.confirmThreadDelete !== DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete ? (
              <SettingResetButton
                label="delete confirmation"
                onClick={() =>
                  updateSettings({
                    confirmThreadDelete: DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.confirmThreadDelete}
              onCheckedChange={(checked) =>
                updateSettings({ confirmThreadDelete: Boolean(checked) })
              }
              aria-label="Confirm thread deletion"
            />
          }
        />

        {isElectron ? (
          <SettingsRow
            {...searchableSetting("quit-confirmation")}
            description="Hold mode also quits on two quick presses."
            resetAction={
              settings.confirmQuit !== DEFAULT_UNIFIED_SETTINGS.confirmQuit ? (
                <SettingResetButton
                  label="quit shortcut behavior"
                  onClick={() =>
                    updateSettings({ confirmQuit: DEFAULT_UNIFIED_SETTINGS.confirmQuit })
                  }
                />
              ) : null
            }
            control={
              <Select
                value={settings.confirmQuit}
                onValueChange={(value) => {
                  if (value === "direct" || value === "hold" || value === "double-click") {
                    updateSettings({ confirmQuit: value });
                  }
                }}
              >
                <SelectTrigger
                  size="sm"
                  className="w-full sm:w-40"
                  aria-label="Quit shortcut behavior"
                >
                  <SelectValue>{QUIT_CONFIRMATION_MODE_LABELS[settings.confirmQuit]}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {Object.entries(QUIT_CONFIRMATION_MODE_LABELS).map(([value, label]) => (
                    <SelectItem hideIndicator key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />
        ) : null}
      </SettingsSection>

      <SettingsSection id="text-generation" title="Text generation">
        <SettingsRow
          serverScoped
          settingKeys={["textGenerationModelSelection"]}
          {...searchableSetting("text-generation-model")}
          description="Used for thread titles and other generated text on connected devices with this provider. Source control can override it."
          resetAction={
            hasServerTargets && isTextGenerationModelDirty ? (
              <SettingResetButton
                label="text generation model"
                onClick={() =>
                  updateSettings({
                    textGenerationModelSelection:
                      DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection,
                  })
                }
              />
            ) : null
          }
          control={
            !hasServerTargets ? (
              <span className="text-sm text-muted-foreground">
                Connect an environment to choose its text generation model.
              </span>
            ) : !hasTextGenerationProvider ? (
              <span className="text-sm text-muted-foreground">
                No text generation providers available.
              </span>
            ) : (
              <div className="flex flex-wrap items-center justify-end gap-1.5">
                <ProviderModelPicker
                  activeInstanceId={textGenInstanceId}
                  model={textGenModel}
                  lockedProvider={null}
                  instanceEntries={textGenerationModelInstanceEntries}
                  modelOptionsByInstance={textGenerationModelOptionsByInstance}
                  triggerVariant="outline"
                  triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                  {...(mixedTextGenerationModel ? { triggerLabel: "Mixed" } : {})}
                  getModelDisabledReason={textGenerationModelDisabledReason}
                  {...(environmentId
                    ? {
                        onOpenProviderSetup: (instanceId: ProviderInstanceId) => {
                          void navigate({
                            to: "/settings/providers",
                            search: { environmentId, instanceId },
                          });
                        },
                      }
                    : {})}
                  onInstanceModelChange={(instanceId, model) => {
                    const reason = textGenerationModelDisabledReason(instanceId, model);
                    if (reason) {
                      toastManager.add({
                        type: "error",
                        title: "Text generation model not saved",
                        description: reason,
                      });
                      return;
                    }
                    updateSettings({
                      textGenerationModelSelection: resolveAppModelSelectionState(
                        {
                          ...settings,
                          textGenerationModelSelection: createModelSelection(instanceId, model),
                        },
                        textGenerationProviders,
                      ),
                    });
                  }}
                />
                {textGenInstanceEntry ? (
                  <TraitsPicker
                    provider={textGenProvider}
                    models={
                      // Use the exact instance's models (rather than the
                      // first-kind-match) so a custom text-gen instance like
                      // `codex_personal` gets its own model list, not the
                      // default Codex one.
                      textGenInstanceEntry?.models ?? []
                    }
                    model={textGenModel}
                    prompt=""
                    onPromptChange={() => {}}
                    modelOptions={textGenModelOptions}
                    allowPromptInjectedEffort={false}
                    planModeEnabled={settings.planModeEnabled}
                    triggerVariant="outline"
                    triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                    onModelOptionsChange={(nextOptions) => {
                      updateSettings({
                        textGenerationModelSelection: resolveAppModelSelectionState(
                          {
                            ...settings,
                            textGenerationModelSelection: createModelSelection(
                              textGenInstanceId,
                              textGenModel,
                              nextOptions,
                            ),
                          },
                          textGenerationProviders,
                        ),
                      });
                    }}
                  />
                ) : null}
              </div>
            )
          }
        />

        <SettingsRow
          {...searchableSetting("auto-open-task-panel")}
          description="Open the right-side plan and task panel automatically when steps appear."
          resetAction={
            settings.autoOpenPlanSidebar !== DEFAULT_UNIFIED_SETTINGS.autoOpenPlanSidebar ? (
              <SettingResetButton
                label="auto-open task panel"
                onClick={() =>
                  updateSettings({
                    autoOpenPlanSidebar: DEFAULT_UNIFIED_SETTINGS.autoOpenPlanSidebar,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.autoOpenPlanSidebar}
              onCheckedChange={(checked) =>
                updateSettings({ autoOpenPlanSidebar: Boolean(checked) })
              }
              aria-label="Open the task panel automatically"
            />
          }
        />
      </SettingsSection>

      {isElectron ? (
        <SettingsSection id={searchableSetting("notifications").id} title="Agent notifications">
          <SettingsRow
            title="Desktop notifications"
            description="Notify when an agent finishes, has a plan ready, needs input, or fails. Notifications are suppressed while T3 Code is focused."
            control={
              <Switch
                checked={notificationPreferences.enabled}
                onCheckedChange={(checked) =>
                  updateClientSettings({
                    agentNotifications: {
                      ...notificationPreferences,
                      enabled: Boolean(checked),
                    },
                  })
                }
                aria-label="Enable desktop agent notifications"
              />
            }
          />
          {notificationPreferences.enabled ? (
            <>
              <SettingsRow
                title="Test notification"
                description="Sends a native desktop notification now."
                control={
                  <Button size="xs" variant="outline" onClick={sendNotificationTest}>
                    Send test notification
                  </Button>
                }
              />
              <SettingsRow
                title="Play notification sounds"
                description="Play a sound alongside the system notification while T3 Code is running."
                control={
                  <Switch
                    checked={notificationPreferences.playSound}
                    onCheckedChange={(checked) =>
                      updateClientSettings({
                        agentNotifications: {
                          ...notificationPreferences,
                          playSound: Boolean(checked),
                        },
                      })
                    }
                    aria-label="Play agent notification sounds"
                  />
                }
              />
              {notificationPreferences.playSound
                ? AGENT_NOTIFICATION_SOUND_ROWS.map((row) => (
                    <AgentNotificationSoundRow
                      key={row.kind}
                      kind={row.kind}
                      title={row.title}
                      sounds={notificationPreferences.sounds}
                      onChange={setNotificationSound}
                    />
                  ))
                : null}
              <SettingsRow
                title="Agent finished"
                description="Notify when agent work completes."
                control={
                  <Switch
                    checked={notificationPreferences.notifyOnCompletion}
                    onCheckedChange={(checked) =>
                      updateClientSettings({
                        agentNotifications: {
                          ...notificationPreferences,
                          notifyOnCompletion: Boolean(checked),
                        },
                      })
                    }
                    aria-label="Notify when an agent finishes"
                  />
                }
              />
              <SettingsRow
                title="Plan ready"
                description="Notify when an agent proposes a plan for review."
                control={
                  <Switch
                    checked={notificationPreferences.notifyOnPlanReady}
                    onCheckedChange={(checked) =>
                      updateClientSettings({
                        agentNotifications: {
                          ...notificationPreferences,
                          notifyOnPlanReady: Boolean(checked),
                        },
                      })
                    }
                    aria-label="Notify when a plan is ready"
                  />
                }
              />
              <SettingsRow
                title="Input needed"
                description="Notify when an agent needs approval or a response."
                control={
                  <Switch
                    checked={notificationPreferences.notifyOnInput}
                    onCheckedChange={(checked) =>
                      updateClientSettings({
                        agentNotifications: {
                          ...notificationPreferences,
                          notifyOnInput: Boolean(checked),
                        },
                      })
                    }
                    aria-label="Notify when agent input is needed"
                  />
                }
              />
              <SettingsRow
                title="Agent failed"
                description="Notify when an agent run ends with an error."
                control={
                  <Switch
                    checked={notificationPreferences.notifyOnFailure}
                    onCheckedChange={(checked) =>
                      updateClientSettings({
                        agentNotifications: {
                          ...notificationPreferences,
                          notifyOnFailure: Boolean(checked),
                        },
                      })
                    }
                    aria-label="Notify when an agent fails"
                  />
                }
              />
              <SettingsRow
                title="Show project and thread names"
                description="Turn this off to keep notification content generic on your desktop."
                control={
                  <Switch
                    checked={notificationPreferences.showProjectAndThreadNames}
                    onCheckedChange={(checked) =>
                      updateClientSettings({
                        agentNotifications: {
                          ...notificationPreferences,
                          showProjectAndThreadNames: Boolean(checked),
                        },
                      })
                    }
                    aria-label="Show project and thread names in notifications"
                  />
                }
              />
            </>
          ) : null}
        </SettingsSection>
      ) : (
        <>
          <PwaNotificationSettings />
          <PwaAppUpdateSettings />
        </>
      )}

      <SettingsSection title="About">
        {isElectron || HOSTED_APP_CHANNEL ? (
          <AboutVersionSection />
        ) : (
          <SettingsRow
            title={<AboutVersionTitle />}
            description="Current version of the application."
          />
        )}
      </SettingsSection>
      <SettingsSection title="Diagnostics">
        <SettingsRow
          {...searchableSetting("diagnostics")}
          description={
            isEnvironmentScope
              ? "Inspect processes, resource use, and logs on this environment."
              : "Inspect processes, resource use, and logs on one environment at a time."
          }
          control={
            <Button
              render={
                <Link to="/settings/diagnostics" search={{ machine: environmentId ?? undefined }} />
              }
              size="sm"
              variant="outline"
            >
              View diagnostics
            </Button>
          }
        />
      </SettingsSection>

      <LegacyFeaturesSection />
    </SettingsPageContainer>
  );
}

export function ArchivedThreadsPanel() {
  const { scope } = useSettingsScope();
  const { unarchiveThread, confirmAndDeleteThread } = useThreadActions();
  const {
    snapshots: archivedSnapshots,
    error: archiveError,
    isLoading: isLoadingArchive,
    refresh: refreshArchivedThreads,
  } = useArchivedThreadSnapshots(scope.environmentIds);

  const archivedGroups = useMemo(() => {
    const selectedProjectKeys =
      scope.kind === "project" || scope.kind === "checkout"
        ? new Set(scope.members.map((member) => `${member.environmentId}:${member.id}`))
        : null;
    const projectsByEnvironmentAndId = new Map(
      archivedSnapshots.flatMap(({ environmentId, snapshot }) =>
        snapshot.projects
          .filter(
            (project) =>
              selectedProjectKeys === null ||
              selectedProjectKeys.has(`${environmentId}:${project.id}`),
          )
          .map(
            (project) => [`${environmentId}:${project.id}`, { ...project, environmentId }] as const,
          ),
      ),
    );
    const threads = archivedSnapshots.flatMap(({ environmentId, snapshot }) =>
      snapshot.threads.map((thread) => ({
        ...thread,
        environmentId,
      })),
    );

    const archivedProjects = Array.from(projectsByEnvironmentAndId.values());
    const groups: Array<{
      readonly project: (typeof archivedProjects)[number];
      readonly threads: Array<(typeof threads)[number]>;
    }> = [];
    for (const project of archivedProjects) {
      const projectThreads: Array<(typeof threads)[number]> = [];
      for (const thread of threads) {
        if (thread.projectId === project.id && thread.environmentId === project.environmentId) {
          projectThreads.push(thread);
        }
      }
      if (projectThreads.length > 0) {
        groups.push({
          project,
          threads: projectThreads.toSorted((left, right) => {
            const leftKey = left.archivedAt ?? left.createdAt;
            const rightKey = right.archivedAt ?? right.createdAt;
            return rightKey.localeCompare(leftKey) || right.id.localeCompare(left.id);
          }),
        });
      }
    }
    return groups;
  }, [archivedSnapshots, scope]);

  const handleArchivedThreadContextMenu = useCallback(
    async (threadRef: ScopedThreadRef, position: { x: number; y: number }) => {
      const api = readLocalApi();
      if (!api) return;
      const clicked = await api.contextMenu.show(
        [
          { id: "unarchive", label: "Unarchive" },
          { id: "delete", label: "Delete", destructive: true },
        ],
        position,
      );

      if (clicked === "unarchive") {
        const result = await unarchiveThread(threadRef);
        if (result._tag === "Success") {
          refreshArchivedThreads();
        } else if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to unarchive thread",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
        return;
      }

      if (clicked === "delete") {
        const result = await confirmAndDeleteThread(threadRef);
        if (result._tag === "Success") {
          refreshArchivedThreads();
        } else if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to delete thread",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
      }
    },
    [confirmAndDeleteThread, refreshArchivedThreads, unarchiveThread],
  );

  return (
    <SettingsPageContainer>
      {archivedGroups.length === 0 ? (
        <SettingsSection
          id={isLoadingArchive ? undefined : searchableSetting("archive").id}
          title={searchableSetting("archive").title}
        >
          <SettingsRow
            title={
              <span className="inline-flex items-center gap-2">
                {isLoadingArchive ? (
                  <Spinner className="size-3.5 text-muted-foreground" />
                ) : (
                  <ArchiveIcon className="size-3.5 text-muted-foreground" />
                )}
                {isLoadingArchive
                  ? "Loading archived threads"
                  : archiveError
                    ? "Could not load archived threads"
                    : "No archived threads"}
              </span>
            }
            description={
              isLoadingArchive
                ? "Checking connected environments."
                : (archiveError ?? "Archived threads will appear here.")
            }
          />
        </SettingsSection>
      ) : (
        archivedGroups.map(({ project, threads: projectThreads }, index) => (
          <SettingsSection
            key={`${project.environmentId}:${project.id}`}
            id={index === 0 ? searchableSetting("archive").id : undefined}
            title={project.title}
            icon={<ProjectFavicon project={project} />}
          >
            {projectThreads.map((thread) => (
              <SettingsRow
                key={thread.id}
                onContextMenu={(event) => {
                  event.preventDefault();
                  void (async () => {
                    const result = await settlePromise(() =>
                      handleArchivedThreadContextMenu(
                        scopeThreadRef(thread.environmentId, thread.id),
                        {
                          x: event.clientX,
                          y: event.clientY,
                        },
                      ),
                    );
                    if (result._tag === "Failure") {
                      const error = squashAtomCommandFailure(result);
                      toastManager.add(
                        stackedThreadToast({
                          type: "error",
                          title: "Archived thread action failed",
                          description:
                            error instanceof Error ? error.message : "An error occurred.",
                        }),
                      );
                    }
                  })();
                }}
                title={thread.title}
                description={
                  <>
                    Archived {formatRelativeTimeLabel(thread.archivedAt ?? thread.createdAt)}
                    {" \u00b7 Created "}
                    {formatRelativeTimeLabel(thread.createdAt)}
                  </>
                }
                control={
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    className="shrink-0"
                    onClick={() => {
                      void (async () => {
                        const result = await unarchiveThread(
                          scopeThreadRef(thread.environmentId, thread.id),
                        );
                        if (result._tag === "Success") {
                          refreshArchivedThreads();
                          return;
                        }
                        if (!isAtomCommandInterrupted(result)) {
                          const error = squashAtomCommandFailure(result);
                          toastManager.add(
                            stackedThreadToast({
                              type: "error",
                              title: "Failed to unarchive thread",
                              description:
                                error instanceof Error ? error.message : "An error occurred.",
                            }),
                          );
                        }
                      })();
                    }}
                  >
                    <ArchiveX className="size-3.5" />
                    <span>Unarchive</span>
                  </Button>
                }
              />
            ))}
          </SettingsSection>
        ))
      )}
    </SettingsPageContainer>
  );
}
