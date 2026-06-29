import {
  IconArchivebox as ArchiveIcon,
  IconArchivebox as ArchiveX,
  IconCircleLefthalfFilledRighthalfStripedHorizontalInverse as ContrastIcon,
  IconChevronDown as ChevronDownIcon,
  IconDisplay as DisplayIcon,
  IconInfoCircle as InfoIcon,
  IconMoonFill as MoonIcon,
  IconProgressIndicator as LoaderIcon,
  IconPlus as PlusIcon,
  IconArrowClockwise as RefreshCwIcon,
  IconSunMaxFill as SunIcon,
  IconXmark as XIcon,
} from "symbols-react";
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type DesktopUpdateChannel,
  type ScopedThreadRef,
  type ProviderKind,
  type ServerProvider,
  type ServerProviderModel,
} from "@forma/contracts";
import { scopeThreadRef } from "@forma/client-runtime";
import {
  DEFAULT_CODE_FONT_SIZE_PX,
  DEFAULT_APP_ICON_ID,
  DEFAULT_MAC_OS_FONT_SMOOTHING,
  DEFAULT_UI_FONT_SIZE_PX,
  DEFAULT_UNIFIED_SETTINGS,
  MAX_INTERFACE_FONT_SIZE_PX,
  MIN_INTERFACE_FONT_SIZE_PX,
  type ThreadCleanupInactiveDays,
  type AppIconId,
  type CodeFontSizePx,
  type UiFontSizePx,
} from "@forma/contracts/settings";
import { createModelSelection, normalizeModelSlug } from "@forma/shared/model";
import { Equal } from "effect";
import { APP_VERSION } from "../../branding";
import { APP_ICON_OPTIONS, resolveAppIconOption } from "../../appIcon";
import {
  canCheckForUpdate,
  getDesktopUpdateButtonTooltip,
  getDesktopUpdateInstallConfirmationMessage,
  isDesktopUpdateButtonDisabled,
  resolveDesktopUpdateButtonAction,
} from "../../components/desktopUpdate.logic";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { resolveAndPersistPreferredEditor } from "../../editorPreferences";
import { isElectron } from "../../env";
import { useTheme } from "../../hooks/useTheme";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { useThreadActions } from "../../hooks/useThreadActions";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import {
  setDesktopUpdateStateQueryData,
  useDesktopUpdateState,
} from "../../lib/desktopUpdateReactQuery";
import {
  MAX_CUSTOM_MODEL_LENGTH,
  getCustomModelOptionsByProvider,
  getProviderSettingsModelList,
  resolveAppModelSelectionState,
} from "../../modelSelection";
import { ensureLocalApi, readLocalApi } from "../../localApi";
import { useShallow } from "zustand/react/shallow";
import {
  selectProjectsAcrossEnvironments,
  selectThreadShellsAcrossEnvironments,
  useStore,
} from "../../store";
import { formatRelativeTime, formatRelativeTimeLabel } from "../../timestampFormat";
import { cn } from "../../lib/utils";
import { formatThreadCleanupWindowLabel } from "../../lib/threadCleanup";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Collapsible, CollapsibleContent } from "../ui/collapsible";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
  useRelativeTimeTick,
} from "./settingsLayout";
import type { SettingsRestoreScope } from "./settingsNavigation";
import { NotificationsSettingsIcon } from "../icons/custom";
import { ProjectFavicon } from "../ProjectFavicon";
import {
  useServerAvailableEditors,
  useServerConfig,
  useServerKeybindingsConfigPath,
  useServerObservability,
  useServerProviders,
} from "../../rpc/serverState";
import { ThemePreferenceSelector } from "./ThemePreferenceSelector";
import { DEFAULT_CUSTOM_THEME_SETTINGS, type ThemeMode } from "../../theme";
import { formatProviderKindLabel } from "../../providerModels";

const TIMESTAMP_FORMAT_LABELS = {
  locale: "System default",
  "12-hour": "12-hour",
  "24-hour": "24-hour",
} as const;

const THREAD_CLEANUP_DAY_OPTIONS: readonly ThreadCleanupInactiveDays[] = [1, 3, 7, 14, 30];
const THEME_MODE_LABELS = {
  system: "System",
  light: "Light",
  dark: "Dark",
  highContrast: "High Contrast",
} as const;

const THEME_MODE_ICONS = {
  system: DisplayIcon,
  light: SunIcon,
  dark: MoonIcon,
  highContrast: ContrastIcon,
} as const satisfies Record<ThemeMode, typeof DisplayIcon>;

function ThemeModeOptionLabel({ mode }: { mode: ThemeMode }) {
  const Icon = THEME_MODE_ICONS[mode];

  return (
    <span className="flex items-center gap-2">
      <Icon className="size-3.5 shrink-0 fill-current opacity-40" />
      <span className="truncate">{THEME_MODE_LABELS[mode]}</span>
    </span>
  );
}

function ThemeModeTriggerLabel({ mode }: { mode: ThemeMode }) {
  return <span className="truncate">{THEME_MODE_LABELS[mode]}</span>;
}

type InstallProviderSettings = {
  provider: ProviderKind;
  title: string;
  badgeLabel?: string;
  binaryPlaceholder: string;
  binaryDescription: ReactNode;
  serverUrlPlaceholder?: string;
  serverUrlDescription?: ReactNode;
  serverPasswordPlaceholder?: string;
  serverPasswordDescription?: ReactNode;
  homePathKey?: "codexHomePath";
  homePlaceholder?: string;
  homeDescription?: ReactNode;
};

const PROVIDER_SETTINGS: readonly InstallProviderSettings[] = [
  {
    provider: "codex",
    title: "Codex",
    binaryPlaceholder: "Codex binary path",
    binaryDescription: "Path to the Codex binary",
    homePathKey: "codexHomePath",
    homePlaceholder: "CODEX_HOME",
    homeDescription: "Optional custom Codex home and config directory.",
  },
  {
    provider: "claudeAgent",
    title: "Claude",
    binaryPlaceholder: "Claude binary path",
    binaryDescription: "Path to the Claude binary",
  },
  {
    provider: "cursor",
    title: "Cursor",
    badgeLabel: "Early Access",
    binaryPlaceholder: "Cursor agent binary path",
    binaryDescription: "Path to the Cursor agent binary",
  },
  {
    provider: "grok",
    title: "Grok",
    badgeLabel: "Early Access",
    binaryPlaceholder: "Grok binary path",
    binaryDescription: "Path to the Grok binary",
  },
  {
    provider: "opencode",
    title: "OpenCode",
    binaryPlaceholder: "OpenCode binary path",
    binaryDescription: "Path to the OpenCode binary",
    serverUrlPlaceholder: "http://127.0.0.1:4096",
    serverUrlDescription: "Leave blank to let Forma spawn the server when needed",
    serverPasswordPlaceholder: "Server password (optional)",
    serverPasswordDescription:
      "If your OpenCode server requires authentication, enter the password here. NOTE: Stored in plain text on disk",
  },
] as const;

const PROVIDER_STATUS_STYLES = {
  disabled: {
    dot: "bg-amber-400",
  },
  error: {
    dot: "bg-destructive",
  },
  ready: {
    dot: "bg-success",
  },
  warning: {
    dot: "bg-warning",
  },
} as const;

function parseFontSizeInput(value: string): number | null {
  if (value.trim() === "") {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return Math.max(MIN_INTERFACE_FONT_SIZE_PX, Math.min(MAX_INTERFACE_FONT_SIZE_PX, parsed));
}

function PixelSettingInput({
  ariaLabel,
  value,
  onCommit,
}: {
  ariaLabel: string;
  value: number;
  onCommit: (value: UiFontSizePx | CodeFontSizePx) => void;
}) {
  const [draftValue, setDraftValue] = useState(String(value));

  useEffect(() => {
    setDraftValue(String(value));
  }, [value]);

  const commitDraft = useCallback(() => {
    const parsed = parseFontSizeInput(draftValue);
    if (parsed === null) {
      setDraftValue(String(value));
      return;
    }
    setDraftValue(String(parsed));
    if (parsed !== value) {
      onCommit(parsed as UiFontSizePx | CodeFontSizePx);
    }
  }, [draftValue, onCommit, value]);

  return (
    <div className="flex w-full items-center justify-end gap-2 sm:w-auto">
      <Input
        aria-label={ariaLabel}
        className="w-full sm:w-24"
        max={MAX_INTERFACE_FONT_SIZE_PX}
        min={MIN_INTERFACE_FONT_SIZE_PX}
        nativeInput
        onBlur={commitDraft}
        onChange={(event) => setDraftValue(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.currentTarget.blur();
          }
        }}
        step={1}
        type="number"
        value={draftValue}
      />
      <span className="text-ui-xs text-muted-foreground">px</span>
    </div>
  );
}

function getProviderSummary(provider: ServerProvider | undefined) {
  if (!provider) {
    return {
      headline: "Checking provider status",
      detail: "Waiting for the server to report installation and authentication details.",
    };
  }
  if (!provider.enabled) {
    return {
      headline: "Disabled",
      detail:
        provider.message ?? "This provider is installed but disabled for new sessions in Forma.",
    };
  }
  if (!provider.installed) {
    return {
      headline: "Not found",
      detail: provider.message ?? "CLI not detected on PATH.",
    };
  }
  if (provider.auth.status === "authenticated") {
    const authLabel = provider.auth.label ?? provider.auth.type;
    return {
      headline: authLabel ? `Authenticated · ${authLabel}` : "Authenticated",
      detail: provider.message ?? null,
    };
  }
  if (provider.auth.status === "unauthenticated") {
    return {
      headline: "Not authenticated",
      detail: provider.message ?? null,
    };
  }
  if (provider.status === "warning") {
    return {
      headline: "Needs attention",
      detail:
        provider.message ?? "The provider is installed, but the server could not fully verify it.",
    };
  }
  if (provider.status === "error") {
    return {
      headline: "Unavailable",
      detail: provider.message ?? "The provider failed its startup checks.",
    };
  }
  return {
    headline: "Available",
    detail:
      provider.message ??
      "Installed and ready. This provider does not expose separate authentication details.",
  };
}

function getProviderVersionLabel(version: string | null | undefined) {
  if (!version) return null;
  return version.startsWith("v") ? version : `v${version}`;
}

function ProviderLastChecked({ lastCheckedAt }: { lastCheckedAt: string | null }) {
  useRelativeTimeTick();
  const lastCheckedRelative = lastCheckedAt ? formatRelativeTime(lastCheckedAt) : null;

  if (!lastCheckedRelative) {
    return null;
  }

  return (
    <span className="text-ui-xs text-muted-foreground/60">
      {lastCheckedRelative.suffix ? (
        <>
          Checked <span className="font-mono tabular-nums">{lastCheckedRelative.value}</span>{" "}
          {lastCheckedRelative.suffix}
        </>
      ) : (
        <>Checked {lastCheckedRelative.value}</>
      )}
    </span>
  );
}

function ProviderFreshnessLabel({ provider }: { provider: ServerProvider | undefined }) {
  const freshness = provider?.freshness;
  if (!freshness) return null;
  const label =
    freshness.source === "live" ? "Live" : freshness.source === "cache" ? "Cached" : "Fallback";
  return (
    <span
      className="text-ui-2xs rounded-sm border border-border/60 px-1.5 py-0.5 text-muted-foreground"
      title={freshness.detail}
    >
      {label}
      {freshness.stale ? " · stale" : ""}
    </span>
  );
}

function AboutVersionTitle() {
  return (
    <span className="inline-flex items-center gap-2">
      <span>Version</span>
      <code className="text-ui-xs font-medium text-muted-foreground">{APP_VERSION}</code>
    </span>
  );
}

function AboutVersionSection() {
  const queryClient = useQueryClient();
  const updateStateQuery = useDesktopUpdateState();
  const [isChangingUpdateChannel, setIsChangingUpdateChannel] = useState(false);

  const updateState = updateStateQuery.data ?? null;
  const hasDesktopBridge = typeof window !== "undefined" && Boolean(window.desktopBridge);
  const selectedUpdateChannel = updateState?.channel ?? "latest";

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
        .then((state) => {
          setDesktopUpdateStateQueryData(queryClient, state);
        })
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
    [queryClient, selectedUpdateChannel],
  );

  const handleButtonClick = useCallback(() => {
    const bridge = window.desktopBridge;
    if (!bridge) return;

    const action = updateState ? resolveDesktopUpdateButtonAction(updateState) : "none";

    if (action === "download") {
      void bridge
        .downloadUpdate()
        .then((result) => {
          setDesktopUpdateStateQueryData(queryClient, result.state);
        })
        .catch((error: unknown) => {
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
      const confirmed = window.confirm(
        getDesktopUpdateInstallConfirmationMessage(
          updateState ?? { availableVersion: null, downloadedVersion: null },
        ),
      );
      if (!confirmed) return;
      void bridge
        .installUpdate()
        .then((result) => {
          setDesktopUpdateStateQueryData(queryClient, result.state);
        })
        .catch((error: unknown) => {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not install update",
              description: error instanceof Error ? error.message : "Install failed.",
            }),
          );
        });
      return;
    }

    if (typeof bridge.checkForUpdate !== "function") return;
    void bridge
      .checkForUpdate()
      .then((result) => {
        setDesktopUpdateStateQueryData(queryClient, result.state);
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
  }, [queryClient, updateState]);

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
                  size="xs"
                  variant={action === "install" ? "default" : "outline"}
                  disabled={buttonDisabled}
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
      <SettingsRow
        title="Update track"
        description="Stable follows full releases. Nightly follows the nightly desktop channel and can switch back to stable immediately."
        control={
          <Select
            value={selectedUpdateChannel}
            onValueChange={(value) => {
              handleUpdateChannelChange(value as DesktopUpdateChannel);
            }}
          >
            <SelectTrigger
              className="w-full sm:w-40"
              aria-label="Update track"
              disabled={!hasDesktopBridge || isChangingUpdateChannel}
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
    </>
  );
}

function AppIconPreview({ id, src }: { id: AppIconId; src: string }) {
  const [failed, setFailed] = useState(false);
  const initials = id
    .replace("forma-", "")
    .split("-")
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("")
    .slice(0, 2);

  return (
    <span className="relative flex size-20">
      {!failed ? (
        <img
          src={src}
          alt=""
          className="size-full object-cover"
          draggable={false}
          onError={() => setFailed(true)}
        />
      ) : (
        <span className="text-ui-xs font-semibold text-muted-foreground">{initials}</span>
      )}
    </span>
  );
}

function AppIconPicker({
  value,
  onChange,
}: {
  value: AppIconId;
  onChange: (value: AppIconId) => void;
}) {
  return (
    <div className="grid grid-cols-5 gap-2 pt-4 pb-5">
      {APP_ICON_OPTIONS.map((option) => {
        const selected = option.id === value;
        return (
          <button
            key={option.id}
            type="button"
            aria-pressed={selected}
            className={cn(
              "group flex min-h-0 flex-col items-center justify-center gap-1.5 rounded-xl border px-1.5 py-2 text-center transition-colors",
              selected
                ? "border-foreground/55 bg-foreground/[0.04] text-foreground"
                : "border-border/70 bg-background/40 text-muted-foreground hover:border-foreground/25 hover:bg-muted/50 hover:text-foreground",
            )}
            onClick={() => onChange(option.id)}
          >
            <AppIconPreview id={option.id} src={option.previewSrc} />
            <span className="text-xs leading-tight font-medium">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function isTextGenerationModelDirty(settings: typeof DEFAULT_UNIFIED_SETTINGS) {
  return !Equal.equals(
    settings.textGenerationModelSelection ?? null,
    DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection ?? null,
  );
}

function hasProviderSettingsChanges(settings: typeof DEFAULT_UNIFIED_SETTINGS) {
  return PROVIDER_SETTINGS.some((providerSettings) => {
    const currentSettings = settings.providers[providerSettings.provider];
    const defaultSettings = DEFAULT_UNIFIED_SETTINGS.providers[providerSettings.provider];
    return !Equal.equals(currentSettings, defaultSettings);
  });
}

function hasDesktopBridgeSupport() {
  return typeof window !== "undefined" && Boolean(window.desktopBridge);
}

function DesktopNotificationSettingsSection() {
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();

  return (
    <SettingsSection title="Thread attention">
      <SettingsRow
        title="Approval requests"
        description="Notify when an agent needs permission to continue while Forma is not focused."
        resetAction={
          settings.desktopNotifyOnApprovalRequests !==
          DEFAULT_UNIFIED_SETTINGS.desktopNotifyOnApprovalRequests ? (
            <SettingResetButton
              label="approval request notifications"
              onClick={() =>
                updateSettings({
                  desktopNotifyOnApprovalRequests:
                    DEFAULT_UNIFIED_SETTINGS.desktopNotifyOnApprovalRequests,
                })
              }
            />
          ) : null
        }
        control={
          <Switch
            checked={settings.desktopNotifyOnApprovalRequests}
            onCheckedChange={(checked) =>
              updateSettings({ desktopNotifyOnApprovalRequests: Boolean(checked) })
            }
            aria-label="Approval request notifications"
          />
        }
      />

      <SettingsRow
        title="Question prompts"
        description="Notify when an agent asks you for input to continue while Forma is not focused."
        resetAction={
          settings.desktopNotifyOnUserInputRequests !==
          DEFAULT_UNIFIED_SETTINGS.desktopNotifyOnUserInputRequests ? (
            <SettingResetButton
              label="question prompt notifications"
              onClick={() =>
                updateSettings({
                  desktopNotifyOnUserInputRequests:
                    DEFAULT_UNIFIED_SETTINGS.desktopNotifyOnUserInputRequests,
                })
              }
            />
          ) : null
        }
        control={
          <Switch
            checked={settings.desktopNotifyOnUserInputRequests}
            onCheckedChange={(checked) =>
              updateSettings({ desktopNotifyOnUserInputRequests: Boolean(checked) })
            }
            aria-label="Question prompt notifications"
          />
        }
      />
    </SettingsSection>
  );
}

function NotificationsUnavailableSection() {
  return (
    <SettingsSection title="Thread attention">
      <Empty className="min-h-88">
        <EmptyMedia variant="icon">
          <NotificationsSettingsIcon className="size-4.5" />
        </EmptyMedia>
        <EmptyHeader>
          <EmptyTitle>Desktop notifications unavailable</EmptyTitle>
          <EmptyDescription>
            Open Forma in the desktop app to receive attention notifications for approval requests
            and question prompts.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    </SettingsSection>
  );
}

export function useSettingsRestore(scope: SettingsRestoreScope, onRestored?: () => void) {
  const { theme, setThemeHue, setThemeMode, setThemeSaturation } = useTheme();
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const hasDesktopBridge = hasDesktopBridgeSupport();

  const isGitWritingModelDirty = isTextGenerationModelDirty(settings);
  const areProviderSettingsDirty = hasProviderSettingsChanges(settings);

  const changedSettingLabels = useMemo(() => {
    switch (scope) {
      case "interface":
        return [
          ...(theme.mode !== DEFAULT_CUSTOM_THEME_SETTINGS.mode ? ["Theme mode"] : []),
          ...(theme.hue !== DEFAULT_CUSTOM_THEME_SETTINGS.hue ? ["Theme hue"] : []),
          ...(theme.saturation !== DEFAULT_CUSTOM_THEME_SETTINGS.saturation
            ? ["Theme saturation"]
            : []),
          ...(settings.appIcon !== DEFAULT_APP_ICON_ID ? ["App icon"] : []),
          ...(settings.uiFontScale !== DEFAULT_UI_FONT_SIZE_PX ? ["UI font size"] : []),
          ...(settings.codeFontScale !== DEFAULT_CODE_FONT_SIZE_PX ? ["Code font size"] : []),
          ...(settings.macOsFontSmoothing !== DEFAULT_MAC_OS_FONT_SMOOTHING
            ? ["Font smoothing"]
            : []),
          ...(settings.timestampFormat !== DEFAULT_UNIFIED_SETTINGS.timestampFormat
            ? ["Time format"]
            : []),
          ...(settings.diffWordWrap !== DEFAULT_UNIFIED_SETTINGS.diffWordWrap
            ? ["Diff line wrapping"]
            : []),
          ...(settings.enableAssistantStreaming !==
          DEFAULT_UNIFIED_SETTINGS.enableAssistantStreaming
            ? ["Assistant output"]
            : []),
        ];
      case "threads":
        return [
          ...(settings.defaultThreadEnvMode !== DEFAULT_UNIFIED_SETTINGS.defaultThreadEnvMode
            ? ["New thread mode"]
            : []),
          ...(settings.addProjectBaseDirectory !== DEFAULT_UNIFIED_SETTINGS.addProjectBaseDirectory
            ? ["Add project base directory"]
            : []),
          ...(settings.threadCleanupInactiveDays !==
          DEFAULT_UNIFIED_SETTINGS.threadCleanupInactiveDays
            ? ["Thread cleanup window"]
            : []),
          ...(settings.confirmThreadArchive !== DEFAULT_UNIFIED_SETTINGS.confirmThreadArchive
            ? ["Archive confirmation"]
            : []),
          ...(settings.confirmThreadDelete !== DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete
            ? ["Delete confirmation"]
            : []),
        ];
      case "notifications":
        if (!hasDesktopBridge) {
          return [];
        }
        return [
          ...(settings.desktopNotifyOnApprovalRequests !==
          DEFAULT_UNIFIED_SETTINGS.desktopNotifyOnApprovalRequests
            ? ["Approval request notifications"]
            : []),
          ...(settings.desktopNotifyOnUserInputRequests !==
          DEFAULT_UNIFIED_SETTINGS.desktopNotifyOnUserInputRequests
            ? ["Question prompt notifications"]
            : []),
        ];
      case "providers":
        return [
          ...(isGitWritingModelDirty ? ["Text generation model"] : []),
          ...(areProviderSettingsDirty ? ["Providers"] : []),
        ];
      case "safety":
        return [
          ...(settings.safety.protectedFilesystemPathsEnabled !==
          DEFAULT_UNIFIED_SETTINGS.safety.protectedFilesystemPathsEnabled
            ? ["Protected paths"]
            : []),
        ];
    }
  }, [
    areProviderSettingsDirty,
    hasDesktopBridge,
    isGitWritingModelDirty,
    scope,
    settings.addProjectBaseDirectory,
    settings.appIcon,
    settings.codeFontScale,
    settings.confirmThreadArchive,
    settings.confirmThreadDelete,
    settings.desktopNotifyOnApprovalRequests,
    settings.desktopNotifyOnUserInputRequests,
    settings.defaultThreadEnvMode,
    settings.diffWordWrap,
    settings.enableAssistantStreaming,
    settings.macOsFontSmoothing,
    settings.safety.protectedFilesystemPathsEnabled,
    settings.threadCleanupInactiveDays,
    settings.timestampFormat,
    settings.uiFontScale,
    theme.hue,
    theme.mode,
    theme.saturation,
  ]);

  const restoreDefaults = useCallback(async () => {
    if (changedSettingLabels.length === 0) return;

    const api = readLocalApi();
    const confirmed = await (api ?? ensureLocalApi()).dialogs.confirm(
      ["Restore default settings?", `This will reset: ${changedSettingLabels.join(", ")}.`].join(
        "\n",
      ),
    );
    if (!confirmed) return;

    switch (scope) {
      case "interface":
        setThemeMode(DEFAULT_CUSTOM_THEME_SETTINGS.mode);
        setThemeHue(DEFAULT_CUSTOM_THEME_SETTINGS.hue);
        setThemeSaturation(DEFAULT_CUSTOM_THEME_SETTINGS.saturation);
        updateSettings({
          uiFontScale: DEFAULT_UI_FONT_SIZE_PX,
          appIcon: DEFAULT_APP_ICON_ID,
          codeFontScale: DEFAULT_CODE_FONT_SIZE_PX,
          macOsFontSmoothing: DEFAULT_MAC_OS_FONT_SMOOTHING,
          timestampFormat: DEFAULT_UNIFIED_SETTINGS.timestampFormat,
          diffWordWrap: DEFAULT_UNIFIED_SETTINGS.diffWordWrap,
          enableAssistantStreaming: DEFAULT_UNIFIED_SETTINGS.enableAssistantStreaming,
        });
        break;
      case "threads":
        updateSettings({
          defaultThreadEnvMode: DEFAULT_UNIFIED_SETTINGS.defaultThreadEnvMode,
          addProjectBaseDirectory: DEFAULT_UNIFIED_SETTINGS.addProjectBaseDirectory,
          threadCleanupInactiveDays: DEFAULT_UNIFIED_SETTINGS.threadCleanupInactiveDays,
          confirmThreadArchive: DEFAULT_UNIFIED_SETTINGS.confirmThreadArchive,
          confirmThreadDelete: DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete,
        });
        break;
      case "notifications":
        if (!hasDesktopBridge) {
          return;
        }
        updateSettings({
          desktopNotifyOnApprovalRequests: DEFAULT_UNIFIED_SETTINGS.desktopNotifyOnApprovalRequests,
          desktopNotifyOnUserInputRequests:
            DEFAULT_UNIFIED_SETTINGS.desktopNotifyOnUserInputRequests,
        });
        break;
      case "providers":
        updateSettings({
          textGenerationModelSelection: DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection,
          providers: DEFAULT_UNIFIED_SETTINGS.providers,
        });
        break;
      case "safety":
        updateSettings({
          safety: DEFAULT_UNIFIED_SETTINGS.safety,
        });
        break;
    }

    onRestored?.();
  }, [
    changedSettingLabels,
    hasDesktopBridge,
    onRestored,
    scope,
    setThemeHue,
    setThemeMode,
    setThemeSaturation,
    updateSettings,
  ]);

  return {
    changedSettingLabels,
    restoreDefaults,
  };
}

export function SafetySettingsPanel() {
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const endpointPath = "/api/orchestration/events";
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    onCopy: () => {
      toastManager.add(
        stackedThreadToast({
          type: "success",
          title: "Event stream URL copied",
        }),
      );
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not copy event stream URL",
          description: error.message,
        }),
      );
    },
  });

  const protectedPathsEnabled = settings.safety.protectedFilesystemPathsEnabled;

  return (
    <SettingsPageContainer>
      <SettingsSection title="Filesystem">
        <SettingsRow
          title="Protected paths"
          description="Skip OS-sensitive folders during browse and workspace scans."
          resetAction={
            protectedPathsEnabled !==
            DEFAULT_UNIFIED_SETTINGS.safety.protectedFilesystemPathsEnabled ? (
              <SettingResetButton
                label="protected paths"
                onClick={() =>
                  updateSettings({
                    safety: {
                      protectedFilesystemPathsEnabled:
                        DEFAULT_UNIFIED_SETTINGS.safety.protectedFilesystemPathsEnabled,
                    },
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={protectedPathsEnabled}
              onCheckedChange={(checked) =>
                updateSettings({
                  safety: {
                    protectedFilesystemPathsEnabled: Boolean(checked),
                  },
                })
              }
              aria-label="Protected paths"
            />
          }
        />
      </SettingsSection>

      <SettingsSection title="Diagnostics">
        <SettingsRow
          title="Event stream"
          description="Authenticated read-only stream for debugging orchestration events."
          status={
            <span className="text-code-compact block break-all font-mono text-foreground">
              {endpointPath}
            </span>
          }
          control={
            <Button
              size="xs"
              variant="outline"
              onClick={() => copyToClipboard(endpointPath, undefined)}
            >
              {isCopied ? "Copied" : "Copy URL"}
            </Button>
          }
        />
      </SettingsSection>

      <SettingsSection title="Provider status">
        <SettingsRow
          title="Freshness"
          description="Provider status may be reported from a live check, cached startup data, or fallback defaults while checks are still warming."
          status={
            <span className="text-ui-xs text-muted-foreground">
              Live means current process verification succeeded. Cached and fallback states are
              informational and do not block provider use by themselves.
            </span>
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}

export function InterfaceSettingsPanel() {
  const { theme, setThemeHue, setThemeMode, setThemeSaturation, resolvedTheme } = useTheme();
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const serverConfig = useServerConfig();
  const isMacOs = serverConfig?.environment.platform.os === "darwin";

  return (
    <SettingsPageContainer>
      <SettingsSection title="Theme">
        <SettingsRow
          title="Theme"
          description="Build a theme from mode, hue, and saturation."
          resetAction={
            theme.mode !== DEFAULT_CUSTOM_THEME_SETTINGS.mode ||
            theme.hue !== DEFAULT_CUSTOM_THEME_SETTINGS.hue ||
            theme.saturation !== DEFAULT_CUSTOM_THEME_SETTINGS.saturation ? (
              <SettingResetButton
                label="theme"
                onClick={() => {
                  setThemeMode(DEFAULT_CUSTOM_THEME_SETTINGS.mode);
                  setThemeHue(DEFAULT_CUSTOM_THEME_SETTINGS.hue);
                  setThemeSaturation(DEFAULT_CUSTOM_THEME_SETTINGS.saturation);
                }}
              />
            ) : null
          }
          control={
            <Select
              value={theme.mode}
              onValueChange={(value) => setThemeMode(value as typeof theme.mode)}
            >
              <SelectTrigger className="w-full sm:w-44" aria-label="Theme mode">
                <SelectValue>
                  <ThemeModeTriggerLabel mode={theme.mode} />
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="system">
                  <ThemeModeOptionLabel mode="system" />
                </SelectItem>
                <SelectItem hideIndicator value="light">
                  <ThemeModeOptionLabel mode="light" />
                </SelectItem>
                <SelectItem hideIndicator value="dark">
                  <ThemeModeOptionLabel mode="dark" />
                </SelectItem>
                <SelectItem hideIndicator value="highContrast">
                  <ThemeModeOptionLabel mode="highContrast" />
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        >
          <ThemePreferenceSelector
            onHueChange={setThemeHue}
            onSaturationChange={setThemeSaturation}
            resolvedTheme={resolvedTheme}
            theme={theme}
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="Icons">
        <SettingsRow
          title="App icon"
          description="Choose the app artwork used for browser chrome and the desktop dock or window icon."
          resetAction={
            settings.appIcon !== DEFAULT_APP_ICON_ID ? (
              <SettingResetButton
                label="app icon"
                onClick={() =>
                  updateSettings({
                    appIcon: DEFAULT_APP_ICON_ID,
                  })
                }
              />
            ) : null
          }
        >
          <AppIconPicker
            value={settings.appIcon}
            onChange={(appIcon) => updateSettings({ appIcon })}
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="Typography">
        <SettingsRow
          title="UI font size"
          description="Applies directly to the app interface root size."
          resetAction={
            settings.uiFontScale !== DEFAULT_UI_FONT_SIZE_PX ? (
              <SettingResetButton
                label="UI font size"
                onClick={() =>
                  updateSettings({
                    uiFontScale: DEFAULT_UI_FONT_SIZE_PX,
                  })
                }
              />
            ) : null
          }
          control={
            <PixelSettingInput
              ariaLabel="UI font size"
              onCommit={(value) => updateSettings({ uiFontScale: value as UiFontSizePx })}
              value={settings.uiFontScale}
            />
          }
        />

        <SettingsRow
          title="Code font size"
          description="Applies to the diff editor, terminal, and read-only code surfaces."
          resetAction={
            settings.codeFontScale !== DEFAULT_CODE_FONT_SIZE_PX ? (
              <SettingResetButton
                label="code font size"
                onClick={() =>
                  updateSettings({
                    codeFontScale: DEFAULT_CODE_FONT_SIZE_PX,
                  })
                }
              />
            ) : null
          }
          control={
            <PixelSettingInput
              ariaLabel="Code font size"
              onCommit={(value) => updateSettings({ codeFontScale: value as CodeFontSizePx })}
              value={settings.codeFontScale}
            />
          }
        />

        {isMacOs ? (
          <SettingsRow
            title="Font smoothing"
            description="macOS only. Toggle grayscale text smoothing."
            resetAction={
              settings.macOsFontSmoothing !== DEFAULT_MAC_OS_FONT_SMOOTHING ? (
                <SettingResetButton
                  label="font smoothing"
                  onClick={() =>
                    updateSettings({
                      macOsFontSmoothing: DEFAULT_MAC_OS_FONT_SMOOTHING,
                    })
                  }
                />
              ) : null
            }
            control={
              <Switch
                aria-label="Font smoothing"
                checked={settings.macOsFontSmoothing === "grayscale"}
                onCheckedChange={(checked) =>
                  updateSettings({ macOsFontSmoothing: checked ? "grayscale" : "auto" })
                }
              />
            }
          />
        ) : null}
      </SettingsSection>

      <SettingsSection title="Display">
        <SettingsRow
          title="Time format"
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
              <SelectTrigger className="w-full sm:w-40" aria-label="Timestamp format">
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
          title="Diff line wrapping"
          description="Set the default wrap state when the diff panel opens."
          resetAction={
            settings.diffWordWrap !== DEFAULT_UNIFIED_SETTINGS.diffWordWrap ? (
              <SettingResetButton
                label="diff line wrapping"
                onClick={() =>
                  updateSettings({
                    diffWordWrap: DEFAULT_UNIFIED_SETTINGS.diffWordWrap,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.diffWordWrap}
              onCheckedChange={(checked) => updateSettings({ diffWordWrap: Boolean(checked) })}
              aria-label="Wrap diff lines by default"
            />
          }
        />

        <SettingsRow
          title="Assistant output"
          description="Show token-by-token output while a response is in progress."
          resetAction={
            settings.enableAssistantStreaming !==
            DEFAULT_UNIFIED_SETTINGS.enableAssistantStreaming ? (
              <SettingResetButton
                label="assistant output"
                onClick={() =>
                  updateSettings({
                    enableAssistantStreaming: DEFAULT_UNIFIED_SETTINGS.enableAssistantStreaming,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.enableAssistantStreaming}
              onCheckedChange={(checked) =>
                updateSettings({ enableAssistantStreaming: Boolean(checked) })
              }
              aria-label="Stream assistant messages"
            />
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}

function ArchivedThreadsSections() {
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const threads = useStore(useShallow(selectThreadShellsAcrossEnvironments));
  const { unarchiveThread, confirmAndDeleteThread } = useThreadActions();
  const archivedGroups = useMemo(() => {
    return projects
      .map((project) => ({
        project,
        threads: threads
          .filter((thread) => thread.projectId === project.id && thread.archivedAt !== null)
          .toSorted((left, right) => {
            const leftKey = left.archivedAt ?? left.createdAt;
            const rightKey = right.archivedAt ?? right.createdAt;
            return rightKey.localeCompare(leftKey) || right.id.localeCompare(left.id);
          }),
      }))
      .filter((group) => group.threads.length > 0);
  }, [projects, threads]);

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
        try {
          await unarchiveThread(threadRef);
        } catch (error) {
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
        await confirmAndDeleteThread(threadRef);
      }
    },
    [confirmAndDeleteThread, unarchiveThread],
  );

  if (archivedGroups.length === 0) {
    return (
      <SettingsSection title="Archived threads">
        <Empty className="min-h-88">
          <EmptyMedia variant="icon">
            <ArchiveIcon />
          </EmptyMedia>
          <EmptyHeader>
            <EmptyTitle>No archived threads</EmptyTitle>
            <EmptyDescription>Archived threads will appear here.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </SettingsSection>
    );
  }

  return (
    <>
      {archivedGroups.map(({ project, threads: projectThreads }) => (
        <SettingsSection
          key={project.id}
          title={project.name}
          icon={<ProjectFavicon environmentId={project.environmentId} cwd={project.cwd} />}
        >
          {projectThreads.map((thread) => (
            <div
              key={thread.id}
              className="flex items-center justify-between gap-3 border-t border-border px-4 py-3 first:border-t-0 sm:px-5"
              onContextMenu={(event) => {
                event.preventDefault();
                void handleArchivedThreadContextMenu(
                  scopeThreadRef(thread.environmentId, thread.id),
                  {
                    x: event.clientX,
                    y: event.clientY,
                  },
                );
              }}
            >
              <div className="min-w-0 flex-1">
                <h3 className="truncate text-sm font-medium text-foreground">{thread.title}</h3>
                <p className="text-xs text-muted-foreground">
                  Archived {formatRelativeTimeLabel(thread.archivedAt ?? thread.createdAt)}
                  {" \u00b7 Created "}
                  {formatRelativeTimeLabel(thread.createdAt)}
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 shrink-0 cursor-pointer gap-1.5 px-2.5"
                onClick={() =>
                  void unarchiveThread(scopeThreadRef(thread.environmentId, thread.id)).catch(
                    (error) => {
                      toastManager.add(
                        stackedThreadToast({
                          type: "error",
                          title: "Failed to unarchive thread",
                          description:
                            error instanceof Error ? error.message : "An error occurred.",
                        }),
                      );
                    },
                  )
                }
              >
                <ArchiveX className="size-3.5" />
                <span>Unarchive</span>
              </Button>
            </div>
          ))}
        </SettingsSection>
      ))}
    </>
  );
}

export function ThreadsSettingsPanel() {
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();

  return (
    <SettingsPageContainer>
      <SettingsSection title="Defaults">
        <SettingsRow
          title="New threads"
          description="Pick the default workspace mode for newly created draft threads."
          resetAction={
            settings.defaultThreadEnvMode !== DEFAULT_UNIFIED_SETTINGS.defaultThreadEnvMode ? (
              <SettingResetButton
                label="new threads"
                onClick={() =>
                  updateSettings({
                    defaultThreadEnvMode: DEFAULT_UNIFIED_SETTINGS.defaultThreadEnvMode,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={settings.defaultThreadEnvMode}
              onValueChange={(value) => {
                if (value === "local" || value === "worktree") {
                  updateSettings({ defaultThreadEnvMode: value });
                }
              }}
            >
              <SelectTrigger className="w-full sm:w-44" aria-label="Default thread mode">
                <SelectValue>
                  {settings.defaultThreadEnvMode === "worktree" ? "New worktree" : "Local"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="local">
                  Local
                </SelectItem>
                <SelectItem hideIndicator value="worktree">
                  New worktree
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />

        <SettingsRow
          title="Add project starts in"
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
            <Input
              className="w-full sm:w-72"
              value={settings.addProjectBaseDirectory}
              onChange={(event) => updateSettings({ addProjectBaseDirectory: event.target.value })}
              placeholder="~/"
              spellCheck={false}
              aria-label="Add project base directory"
            />
          }
        />
      </SettingsSection>

      <SettingsSection title="Safety & cleanup">
        <SettingsRow
          title="Thread cleanup window"
          description="Sidebar cleanup archives threads with no user message in this many days."
          resetAction={
            settings.threadCleanupInactiveDays !==
            DEFAULT_UNIFIED_SETTINGS.threadCleanupInactiveDays ? (
              <SettingResetButton
                label="thread cleanup window"
                onClick={() =>
                  updateSettings({
                    threadCleanupInactiveDays: DEFAULT_UNIFIED_SETTINGS.threadCleanupInactiveDays,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={String(settings.threadCleanupInactiveDays)}
              onValueChange={(value) => {
                const nextValue = Number(value);
                if (THREAD_CLEANUP_DAY_OPTIONS.includes(nextValue as ThreadCleanupInactiveDays)) {
                  updateSettings({
                    threadCleanupInactiveDays: nextValue as ThreadCleanupInactiveDays,
                  });
                }
              }}
            >
              <SelectTrigger className="w-full sm:w-40" aria-label="Thread cleanup window">
                <SelectValue>
                  {formatThreadCleanupWindowLabel(settings.threadCleanupInactiveDays)}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {THREAD_CLEANUP_DAY_OPTIONS.map((days) => (
                  <SelectItem key={days} hideIndicator value={String(days)}>
                    {formatThreadCleanupWindowLabel(days)}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />

        <SettingsRow
          title="Archive confirmation"
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
          title="Delete confirmation"
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
      </SettingsSection>

      <ArchivedThreadsSections />
    </SettingsPageContainer>
  );
}

export function NotificationsSettingsPanel() {
  return (
    <SettingsPageContainer>
      {hasDesktopBridgeSupport() ? (
        <DesktopNotificationSettingsSection />
      ) : (
        <NotificationsUnavailableSection />
      )}
    </SettingsPageContainer>
  );
}

export function ProvidersSettingsPanel() {
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const [openProviderDetails, setOpenProviderDetails] = useState<Record<ProviderKind, boolean>>({
    codex: Boolean(
      settings.providers.codex.binaryPath !== DEFAULT_UNIFIED_SETTINGS.providers.codex.binaryPath ||
      settings.providers.codex.homePath !== DEFAULT_UNIFIED_SETTINGS.providers.codex.homePath ||
      settings.providers.codex.customModels.length > 0,
    ),
    claudeAgent: Boolean(
      settings.providers.claudeAgent.binaryPath !==
        DEFAULT_UNIFIED_SETTINGS.providers.claudeAgent.binaryPath ||
      settings.providers.claudeAgent.customModels.length > 0 ||
      settings.providers.claudeAgent.launchArgs !== "",
    ),
    cursor: Boolean(
      settings.providers.cursor.binaryPath !==
        DEFAULT_UNIFIED_SETTINGS.providers.cursor.binaryPath ||
      settings.providers.cursor.customModels.length > 0,
    ),
    grok: Boolean(
      settings.providers.grok.binaryPath !== DEFAULT_UNIFIED_SETTINGS.providers.grok.binaryPath ||
      settings.providers.grok.customModels.length > 0,
    ),
    opencode: Boolean(
      settings.providers.opencode.binaryPath !==
        DEFAULT_UNIFIED_SETTINGS.providers.opencode.binaryPath ||
      settings.providers.opencode.serverUrl !==
        DEFAULT_UNIFIED_SETTINGS.providers.opencode.serverUrl ||
      settings.providers.opencode.serverPassword !==
        DEFAULT_UNIFIED_SETTINGS.providers.opencode.serverPassword ||
      settings.providers.opencode.customModels.length > 0,
    ),
  });
  const [customModelInputByProvider, setCustomModelInputByProvider] = useState<
    Record<ProviderKind, string>
  >({
    codex: "",
    claudeAgent: "",
    cursor: "",
    grok: "",
    opencode: "",
  });
  const [customModelErrorByProvider, setCustomModelErrorByProvider] = useState<
    Partial<Record<ProviderKind, string | null>>
  >({});
  const [isRefreshingProviders, setIsRefreshingProviders] = useState(false);
  const refreshingRef = useRef(false);
  const modelListRefs = useRef<Partial<Record<ProviderKind, HTMLDivElement | null>>>({});
  const serverProviders = useServerProviders();
  const visibleProviderSettings = PROVIDER_SETTINGS.filter(
    (providerSettings) =>
      providerSettings.provider !== "cursor" ||
      serverProviders.some((provider) => provider.provider === "cursor"),
  );
  const codexHomePath = settings.providers.codex.homePath;
  const refreshProviders = useCallback(() => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setIsRefreshingProviders(true);
    void ensureLocalApi()
      .server.refreshProviders()
      .catch((error: unknown) => {
        console.warn("Failed to refresh providers", error);
      })
      .finally(() => {
        refreshingRef.current = false;
        setIsRefreshingProviders(false);
      });
  }, []);

  const textGenerationModelSelection = resolveAppModelSelectionState(settings, serverProviders);
  const textGenProvider = textGenerationModelSelection.provider;
  const textGenModel = textGenerationModelSelection.model;
  const textGenModelOptions = textGenerationModelSelection.options;
  const gitModelOptionsByProvider = getCustomModelOptionsByProvider(
    settings,
    serverProviders,
    textGenProvider,
    textGenModel,
  );
  const isGitWritingModelDirty = isTextGenerationModelDirty(settings);

  const addCustomModel = useCallback(
    (provider: ProviderKind) => {
      const customModelInput = customModelInputByProvider[provider];
      const customModels = settings.providers[provider].customModels;
      const normalized = normalizeModelSlug(customModelInput, provider);
      if (!normalized) {
        setCustomModelErrorByProvider((existing) => ({
          ...existing,
          [provider]: "Enter a model slug.",
        }));
        return;
      }
      if (
        serverProviders
          .find((candidate) => candidate.provider === provider)
          ?.models.some((option) => !option.isCustom && option.slug === normalized)
      ) {
        setCustomModelErrorByProvider((existing) => ({
          ...existing,
          [provider]: "That model is already built in.",
        }));
        return;
      }
      if (normalized.length > MAX_CUSTOM_MODEL_LENGTH) {
        setCustomModelErrorByProvider((existing) => ({
          ...existing,
          [provider]: `Model slugs must be ${MAX_CUSTOM_MODEL_LENGTH} characters or less.`,
        }));
        return;
      }
      if (customModels.includes(normalized)) {
        setCustomModelErrorByProvider((existing) => ({
          ...existing,
          [provider]: "That custom model is already saved.",
        }));
        return;
      }

      updateSettings({
        providers: {
          ...settings.providers,
          [provider]: {
            ...settings.providers[provider],
            customModels: [...customModels, normalized],
          },
        },
      });
      setCustomModelInputByProvider((existing) => ({
        ...existing,
        [provider]: "",
      }));
      setCustomModelErrorByProvider((existing) => ({
        ...existing,
        [provider]: null,
      }));

      const el = modelListRefs.current[provider];
      if (!el) return;
      const scrollToEnd = () => el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
      requestAnimationFrame(scrollToEnd);
      const observer = new MutationObserver(() => {
        scrollToEnd();
        observer.disconnect();
      });
      observer.observe(el, { childList: true, subtree: true });
      setTimeout(() => observer.disconnect(), 2_000);
    },
    [customModelInputByProvider, serverProviders, settings, updateSettings],
  );

  const removeCustomModel = useCallback(
    (provider: ProviderKind, slug: string) => {
      updateSettings({
        providers: {
          ...settings.providers,
          [provider]: {
            ...settings.providers[provider],
            customModels: settings.providers[provider].customModels.filter(
              (model) => model !== slug,
            ),
          },
        },
      });
      setCustomModelErrorByProvider((existing) => ({
        ...existing,
        [provider]: null,
      }));
    },
    [settings, updateSettings],
  );

  const providerCards = visibleProviderSettings.map((providerSettings) => {
    const liveProvider = serverProviders.find(
      (candidate) => candidate.provider === providerSettings.provider,
    );
    const providerConfig = settings.providers[providerSettings.provider];
    const defaultProviderConfig = DEFAULT_UNIFIED_SETTINGS.providers[providerSettings.provider];
    const statusKey = liveProvider?.status ?? (providerConfig.enabled ? "warning" : "disabled");
    const summary = getProviderSummary(liveProvider);
    const models: ReadonlyArray<ServerProviderModel> = getProviderSettingsModelList(
      settings,
      serverProviders,
      providerSettings.provider,
    );

    return {
      provider: providerSettings.provider,
      title: providerSettings.title,
      badgeLabel: providerSettings.badgeLabel,
      binaryPlaceholder: providerSettings.binaryPlaceholder,
      binaryDescription: providerSettings.binaryDescription,
      serverUrlPlaceholder: providerSettings.serverUrlPlaceholder,
      serverUrlDescription: providerSettings.serverUrlDescription,
      serverPasswordPlaceholder: providerSettings.serverPasswordPlaceholder,
      serverPasswordDescription: providerSettings.serverPasswordDescription,
      homePathKey: providerSettings.homePathKey,
      homePlaceholder: providerSettings.homePlaceholder,
      homeDescription: providerSettings.homeDescription,
      binaryPathValue: providerConfig.binaryPath,
      serverUrlValue: "serverUrl" in providerConfig ? providerConfig.serverUrl : "",
      serverPasswordValue: "serverPassword" in providerConfig ? providerConfig.serverPassword : "",
      isDirty: !Equal.equals(providerConfig, defaultProviderConfig),
      liveProvider,
      models,
      providerConfig,
      statusStyle: PROVIDER_STATUS_STYLES[statusKey],
      summary,
      versionLabel: getProviderVersionLabel(liveProvider?.version),
    };
  });

  const lastCheckedAt =
    serverProviders.length > 0
      ? serverProviders.reduce(
          (latest, provider) => (provider.checkedAt > latest ? provider.checkedAt : latest),
          serverProviders[0]!.checkedAt,
        )
      : null;

  return (
    <SettingsPageContainer>
      <SettingsSection title="Text generation">
        <SettingsRow
          title="Text generation model"
          description="Configure the model used for generated commit messages, PR titles, and similar Git text."
          resetAction={
            isGitWritingModelDirty ? (
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
            <div className="flex flex-wrap items-center justify-end gap-1.5">
              <ProviderModelPicker
                provider={textGenProvider}
                model={textGenModel}
                lockedProvider={null}
                providers={serverProviders}
                modelOptionsByProvider={gitModelOptionsByProvider}
                triggerVariant="outline"
                triggerClassName="min-w-0 max-w-none shrink-0 text-foreground/90 hover:text-foreground"
                onProviderModelChange={(provider, model) => {
                  updateSettings({
                    textGenerationModelSelection: resolveAppModelSelectionState(
                      {
                        ...settings,
                        textGenerationModelSelection: createModelSelection(provider, model),
                      },
                      serverProviders,
                    ),
                  });
                }}
              />
              <TraitsPicker
                provider={textGenProvider}
                models={
                  serverProviders.find((provider) => provider.provider === textGenProvider)
                    ?.models ?? []
                }
                model={textGenModel}
                prompt=""
                onPromptChange={() => {}}
                modelOptions={textGenModelOptions}
                allowPromptInjectedEffort={false}
                triggerVariant="outline"
                triggerClassName="min-w-0 max-w-none shrink-0 text-foreground/90 hover:text-foreground"
                onModelOptionsChange={(nextOptions) => {
                  updateSettings({
                    textGenerationModelSelection: resolveAppModelSelectionState(
                      {
                        ...settings,
                        textGenerationModelSelection: createModelSelection(
                          textGenProvider,
                          textGenModel,
                          nextOptions,
                        ),
                      },
                      serverProviders,
                    ),
                  });
                }}
              />
            </div>
          }
        />
      </SettingsSection>

      <SettingsSection
        title="Providers"
        headerAction={
          <div className="flex items-center gap-1.5">
            <ProviderLastChecked lastCheckedAt={lastCheckedAt} />
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    className="size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground"
                    disabled={isRefreshingProviders}
                    onClick={() => void refreshProviders()}
                    aria-label="Refresh provider status"
                  >
                    {isRefreshingProviders ? (
                      <LoaderIcon className="size-3 animate-spin" />
                    ) : (
                      <RefreshCwIcon className="size-3" />
                    )}
                  </Button>
                }
              />
              <TooltipPopup side="top">Refresh provider status</TooltipPopup>
            </Tooltip>
          </div>
        }
      >
        {providerCards.map((providerCard) => {
          const customModelInput = customModelInputByProvider[providerCard.provider];
          const customModelError = customModelErrorByProvider[providerCard.provider] ?? null;
          const providerDisplayName =
            providerCard.liveProvider?.displayName?.trim() ||
            providerCard.title ||
            formatProviderKindLabel(providerCard.provider);

          return (
            <div key={providerCard.provider} className="border-t border-border first:border-t-0">
              <div className="px-4 py-4 sm:px-5">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex min-h-5 items-center gap-1.5">
                      <span
                        className={cn("size-2 shrink-0 rounded-full", providerCard.statusStyle.dot)}
                      />
                      <h3 className="text-sm font-medium text-foreground">{providerDisplayName}</h3>
                      {providerCard.badgeLabel ? (
                        <Badge variant="warning" size="sm" className="shrink-0">
                          {providerCard.badgeLabel}
                        </Badge>
                      ) : null}
                      {providerCard.versionLabel ? (
                        <code className="text-xs text-muted-foreground">
                          {providerCard.versionLabel}
                        </code>
                      ) : null}
                      <ProviderFreshnessLabel provider={providerCard.liveProvider} />
                      <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center">
                        {providerCard.isDirty ? (
                          <SettingResetButton
                            label={`${providerDisplayName} provider settings`}
                            onClick={() => {
                              updateSettings({
                                providers: {
                                  ...settings.providers,
                                  [providerCard.provider]:
                                    DEFAULT_UNIFIED_SETTINGS.providers[providerCard.provider],
                                },
                              });
                              setCustomModelErrorByProvider((existing) => ({
                                ...existing,
                                [providerCard.provider]: null,
                              }));
                            }}
                          />
                        ) : null}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {providerCard.summary.headline}
                      {providerCard.summary.detail ? ` - ${providerCard.summary.detail}` : null}
                    </p>
                  </div>
                  <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
                      onClick={() =>
                        setOpenProviderDetails((existing) => ({
                          ...existing,
                          [providerCard.provider]: !existing[providerCard.provider],
                        }))
                      }
                      aria-label={`Toggle ${providerDisplayName} details`}
                    >
                      <ChevronDownIcon
                        className={cn(
                          "size-2.5 transition-transform",
                          openProviderDetails[providerCard.provider] && "rotate-180",
                        )}
                      />
                    </Button>
                    <Switch
                      checked={providerCard.providerConfig.enabled}
                      onCheckedChange={(checked) => {
                        const isDisabling = !checked;
                        const shouldClearModelSelection =
                          isDisabling && textGenProvider === providerCard.provider;
                        updateSettings({
                          providers: {
                            ...settings.providers,
                            [providerCard.provider]: {
                              ...settings.providers[providerCard.provider],
                              enabled: Boolean(checked),
                            },
                          },
                          ...(shouldClearModelSelection
                            ? {
                                textGenerationModelSelection:
                                  DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection,
                              }
                            : {}),
                        });
                      }}
                      aria-label={`Enable ${providerDisplayName}`}
                    />
                  </div>
                </div>
              </div>

              <Collapsible
                open={openProviderDetails[providerCard.provider]}
                onOpenChange={(open) =>
                  setOpenProviderDetails((existing) => ({
                    ...existing,
                    [providerCard.provider]: open,
                  }))
                }
              >
                <CollapsibleContent>
                  <div className="space-y-0">
                    <div className="border-t border-border/60 px-4 py-3 sm:px-5">
                      <label
                        htmlFor={`provider-install-${providerCard.provider}-binary-path`}
                        className="block"
                      >
                        <span className="text-xs font-medium text-foreground">
                          {providerDisplayName} binary path
                        </span>
                        <Input
                          id={`provider-install-${providerCard.provider}-binary-path`}
                          className="mt-1.5"
                          value={providerCard.binaryPathValue}
                          onChange={(event) =>
                            updateSettings({
                              providers: {
                                ...settings.providers,
                                [providerCard.provider]: {
                                  ...settings.providers[providerCard.provider],
                                  binaryPath: event.target.value,
                                },
                              },
                            })
                          }
                          placeholder={providerCard.binaryPlaceholder}
                          spellCheck={false}
                        />
                        <span className="mt-1 block text-xs text-muted-foreground">
                          {providerCard.binaryDescription}
                        </span>
                      </label>
                    </div>

                    {providerCard.serverUrlPlaceholder ? (
                      <div className="border-t border-border/60 px-4 py-3 sm:px-5">
                        <label
                          htmlFor={`provider-install-${providerCard.provider}-server-url`}
                          className="block"
                        >
                          <span className="text-xs font-medium text-foreground">
                            {providerDisplayName} server URL
                          </span>
                          <Input
                            id={`provider-install-${providerCard.provider}-server-url`}
                            className="mt-1.5"
                            value={providerCard.serverUrlValue}
                            onChange={(event) =>
                              updateSettings({
                                providers: {
                                  ...settings.providers,
                                  [providerCard.provider]: {
                                    ...settings.providers[providerCard.provider],
                                    ...(providerCard.provider === "opencode"
                                      ? { serverUrl: event.target.value }
                                      : {}),
                                  },
                                },
                              })
                            }
                            placeholder={providerCard.serverUrlPlaceholder}
                            spellCheck={false}
                          />
                          {providerCard.serverUrlDescription ? (
                            <span className="mt-1 block text-xs text-muted-foreground">
                              {providerCard.serverUrlDescription}
                            </span>
                          ) : null}
                        </label>
                      </div>
                    ) : null}

                    {providerCard.serverPasswordPlaceholder ? (
                      <div className="border-t border-border/60 px-4 py-3 sm:px-5">
                        <label
                          htmlFor={`provider-install-${providerCard.provider}-server-password`}
                          className="block"
                        >
                          <span className="text-xs font-medium text-foreground">
                            {providerDisplayName} server password
                          </span>
                          <Input
                            id={`provider-install-${providerCard.provider}-server-password`}
                            className="mt-1.5"
                            type="password"
                            autoComplete="off"
                            value={providerCard.serverPasswordValue}
                            onChange={(event) =>
                              updateSettings({
                                providers: {
                                  ...settings.providers,
                                  [providerCard.provider]: {
                                    ...settings.providers[providerCard.provider],
                                    ...(providerCard.provider === "opencode"
                                      ? { serverPassword: event.target.value }
                                      : {}),
                                  },
                                },
                              })
                            }
                            placeholder={providerCard.serverPasswordPlaceholder}
                            spellCheck={false}
                          />
                          {providerCard.serverPasswordDescription ? (
                            <span className="mt-1 block text-xs text-muted-foreground">
                              {providerCard.serverPasswordDescription}
                            </span>
                          ) : null}
                        </label>
                      </div>
                    ) : null}

                    {providerCard.homePathKey ? (
                      <div className="border-t border-border/60 px-4 py-3 sm:px-5">
                        <label
                          htmlFor={`provider-install-${providerCard.homePathKey}`}
                          className="block"
                        >
                          <span className="text-xs font-medium text-foreground">
                            CODEX_HOME path
                          </span>
                          <Input
                            id={`provider-install-${providerCard.homePathKey}`}
                            className="mt-1.5"
                            value={codexHomePath}
                            onChange={(event) =>
                              updateSettings({
                                providers: {
                                  ...settings.providers,
                                  codex: {
                                    ...settings.providers.codex,
                                    homePath: event.target.value,
                                  },
                                },
                              })
                            }
                            placeholder={providerCard.homePlaceholder}
                            spellCheck={false}
                          />
                          {providerCard.homeDescription ? (
                            <span className="mt-1 block text-xs text-muted-foreground">
                              {providerCard.homeDescription}
                            </span>
                          ) : null}
                        </label>
                      </div>
                    ) : null}

                    {providerCard.provider === "claudeAgent" ? (
                      <div className="border-t border-border/60 px-4 py-3 sm:px-5">
                        <label htmlFor="provider-install-claudeAgent-launch-args" className="block">
                          <span className="text-xs font-medium text-foreground">
                            Launch arguments
                          </span>
                          <Input
                            id="provider-install-claudeAgent-launch-args"
                            className="mt-1.5"
                            value={settings.providers.claudeAgent.launchArgs}
                            onChange={(event) =>
                              updateSettings({
                                providers: {
                                  ...settings.providers,
                                  claudeAgent: {
                                    ...settings.providers.claudeAgent,
                                    launchArgs: event.target.value,
                                  },
                                },
                              })
                            }
                            placeholder="e.g. --chrome"
                            spellCheck={false}
                          />
                          <span className="mt-1 block text-xs text-muted-foreground">
                            Additional CLI arguments passed to Claude Code on session start.
                          </span>
                        </label>
                      </div>
                    ) : null}

                    <div className="border-t border-border/60 px-4 py-3 sm:px-5">
                      <div className="text-xs font-medium text-foreground">Models</div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {providerCard.models.length} model
                        {providerCard.models.length === 1 ? "" : "s"} available.
                      </div>
                      <div
                        ref={(el) => {
                          modelListRefs.current[providerCard.provider] = el;
                        }}
                        className="mt-2 max-h-40 overflow-y-auto pb-1"
                      >
                        {providerCard.models.map((model) => {
                          const caps = model.capabilities;
                          const capLabels: string[] = [];
                          const descriptors = caps?.optionDescriptors ?? [];
                          if (descriptors.some((descriptor) => descriptor.id === "fastMode")) {
                            capLabels.push("Fast mode");
                          }
                          if (descriptors.some((descriptor) => descriptor.id === "thinking")) {
                            capLabels.push("Thinking");
                          }
                          if (
                            descriptors.some(
                              (descriptor) =>
                                descriptor.type === "select" &&
                                (descriptor.id === "reasoningEffort" ||
                                  descriptor.id === "effort" ||
                                  descriptor.id === "reasoning" ||
                                  descriptor.id === "variant"),
                            )
                          ) {
                            capLabels.push("Reasoning");
                          }
                          const hasDetails = capLabels.length > 0 || model.name !== model.slug;

                          return (
                            <div
                              key={`${providerCard.provider}:${model.slug}`}
                              className="flex items-center gap-2 py-1"
                            >
                              <span className="min-w-0 truncate text-xs text-foreground/90">
                                {model.name}
                              </span>
                              {hasDetails ? (
                                <Tooltip>
                                  <TooltipTrigger
                                    render={
                                      <button
                                        type="button"
                                        className="shrink-0 text-muted-foreground/40 transition-colors hover:text-muted-foreground"
                                        aria-label={`Details for ${model.name}`}
                                      />
                                    }
                                  >
                                    <InfoIcon className="size-3" />
                                  </TooltipTrigger>
                                  <TooltipPopup side="top" className="max-w-56">
                                    <div className="space-y-1">
                                      <code className="text-ui-xs block text-foreground">
                                        {model.slug}
                                      </code>
                                      {capLabels.length > 0 ? (
                                        <div className="flex flex-wrap gap-x-2 gap-y-0.5">
                                          {capLabels.map((label) => (
                                            <span
                                              key={label}
                                              className="text-ui-2xs text-muted-foreground"
                                            >
                                              {label}
                                            </span>
                                          ))}
                                        </div>
                                      ) : null}
                                    </div>
                                  </TooltipPopup>
                                </Tooltip>
                              ) : null}
                              {model.isCustom ? (
                                <div className="ml-auto flex shrink-0 items-center gap-1.5">
                                  <span className="text-ui-2xs text-muted-foreground">custom</span>
                                  <button
                                    type="button"
                                    className="text-muted-foreground transition-colors hover:text-foreground"
                                    aria-label={`Remove ${model.slug}`}
                                    onClick={() =>
                                      removeCustomModel(providerCard.provider, model.slug)
                                    }
                                  >
                                    <XIcon className="size-3" />
                                  </button>
                                </div>
                              ) : null}
                            </div>
                          );
                        })}
                      </div>

                      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                        <Input
                          id={`custom-model-${providerCard.provider}`}
                          value={customModelInput}
                          onChange={(event) => {
                            const value = event.target.value;
                            setCustomModelInputByProvider((existing) => ({
                              ...existing,
                              [providerCard.provider]: value,
                            }));
                            if (customModelError) {
                              setCustomModelErrorByProvider((existing) => ({
                                ...existing,
                                [providerCard.provider]: null,
                              }));
                            }
                          }}
                          onKeyDown={(event) => {
                            if (event.key !== "Enter") return;
                            event.preventDefault();
                            addCustomModel(providerCard.provider);
                          }}
                          placeholder={
                            providerCard.provider === "codex"
                              ? "gpt-6.7-codex-ultra-preview"
                              : providerCard.provider === "opencode"
                                ? "openai/gpt-5"
                                : providerCard.provider === "grok"
                                  ? "grok-build"
                                  : "claude-sonnet-5-0"
                          }
                          spellCheck={false}
                        />
                        <Button
                          className="shrink-0"
                          variant="outline"
                          onClick={() => addCustomModel(providerCard.provider)}
                        >
                          <PlusIcon className="size-3.5" />
                          Add
                        </Button>
                      </div>

                      {customModelError ? (
                        <p className="mt-2 text-xs text-destructive">{customModelError}</p>
                      ) : null}
                    </div>
                  </div>
                </CollapsibleContent>
              </Collapsible>
            </div>
          );
        })}
      </SettingsSection>
    </SettingsPageContainer>
  );
}

function useAdvancedSettingsPanelState() {
  const [openingPathByTarget, setOpeningPathByTarget] = useState({
    keybindings: false,
    logsDirectory: false,
  });
  const [openPathErrorByTarget, setOpenPathErrorByTarget] = useState<
    Partial<Record<"keybindings" | "logsDirectory", string | null>>
  >({});

  const keybindingsConfigPath = useServerKeybindingsConfigPath();
  const availableEditors = useServerAvailableEditors();
  const observability = useServerObservability();
  const logsDirectoryPath = observability?.logsDirectoryPath ?? null;
  const diagnosticsDescription = (() => {
    const exports: string[] = [];
    if (observability?.otlpTracesEnabled && observability.otlpTracesUrl) {
      exports.push(`traces to ${observability.otlpTracesUrl}`);
    }
    if (observability?.otlpMetricsEnabled && observability.otlpMetricsUrl) {
      exports.push(`metrics to ${observability.otlpMetricsUrl}`);
    }
    const mode = observability?.localTracingEnabled ? "Local trace file" : "Terminal logs only";
    return exports.length > 0 ? `${mode}. OTLP exporting ${exports.join(" and ")}.` : `${mode}.`;
  })();

  const openInPreferredEditor = useCallback(
    (target: "keybindings" | "logsDirectory", path: string | null, failureMessage: string) => {
      if (!path) return;
      setOpenPathErrorByTarget((existing) => ({ ...existing, [target]: null }));
      setOpeningPathByTarget((existing) => ({ ...existing, [target]: true }));

      const editor = resolveAndPersistPreferredEditor(availableEditors ?? []);
      if (!editor) {
        setOpenPathErrorByTarget((existing) => ({
          ...existing,
          [target]: "No available editors found.",
        }));
        setOpeningPathByTarget((existing) => ({ ...existing, [target]: false }));
        return;
      }

      void ensureLocalApi()
        .shell.openInEditor(path, editor)
        .catch((error) => {
          setOpenPathErrorByTarget((existing) => ({
            ...existing,
            [target]: error instanceof Error ? error.message : failureMessage,
          }));
        })
        .finally(() => {
          setOpeningPathByTarget((existing) => ({ ...existing, [target]: false }));
        });
    },
    [availableEditors],
  );

  const openKeybindingsFile = useCallback(() => {
    openInPreferredEditor("keybindings", keybindingsConfigPath, "Unable to open keybindings file.");
  }, [keybindingsConfigPath, openInPreferredEditor]);

  const openLogsDirectory = useCallback(() => {
    openInPreferredEditor("logsDirectory", logsDirectoryPath, "Unable to open logs folder.");
  }, [logsDirectoryPath, openInPreferredEditor]);

  return {
    diagnosticsDescription,
    isOpeningKeybindings: openingPathByTarget.keybindings,
    isOpeningLogsDirectory: openingPathByTarget.logsDirectory,
    keybindingsConfigPath,
    logsDirectoryPath,
    openDiagnosticsError: openPathErrorByTarget.logsDirectory ?? null,
    openKeybindingsError: openPathErrorByTarget.keybindings ?? null,
    openKeybindingsFile,
    openLogsDirectory,
  };
}

export function AdvancedSettingsPanel() {
  const {
    diagnosticsDescription,
    isOpeningKeybindings,
    isOpeningLogsDirectory,
    keybindingsConfigPath,
    logsDirectoryPath,
    openDiagnosticsError,
    openKeybindingsError,
    openKeybindingsFile,
    openLogsDirectory,
  } = useAdvancedSettingsPanelState();

  return (
    <SettingsPageContainer>
      <SettingsSection title="Files">
        <SettingsRow
          title="Keybindings"
          description="Open the persisted `keybindings.json` file to edit advanced bindings directly."
          status={
            <>
              <span className="text-code-compact block break-all font-mono text-foreground">
                {keybindingsConfigPath ?? "Resolving keybindings path..."}
              </span>
              {openKeybindingsError ? (
                <span className="mt-1 block text-destructive">{openKeybindingsError}</span>
              ) : (
                <span className="mt-1 block">Opens in your preferred editor.</span>
              )}
            </>
          }
          control={
            <Button
              size="xs"
              variant="outline"
              disabled={!keybindingsConfigPath || isOpeningKeybindings}
              onClick={openKeybindingsFile}
            >
              {isOpeningKeybindings ? "Opening..." : "Open file"}
            </Button>
          }
        />
      </SettingsSection>

      <SettingsSection title="Diagnostics">
        <SettingsRow
          title="Logs"
          description={diagnosticsDescription}
          status={
            <>
              <span className="text-code-compact block break-all font-mono text-foreground">
                {logsDirectoryPath ?? "Resolving logs directory..."}
              </span>
              {openDiagnosticsError ? (
                <span className="mt-1 block text-destructive">{openDiagnosticsError}</span>
              ) : null}
            </>
          }
          control={
            <Button
              size="xs"
              variant="outline"
              disabled={!logsDirectoryPath || isOpeningLogsDirectory}
              onClick={openLogsDirectory}
            >
              {isOpeningLogsDirectory ? "Opening..." : "Open logs folder"}
            </Button>
          }
        />
      </SettingsSection>

      <SettingsSection title="Updates">
        {isElectron ? (
          <AboutVersionSection />
        ) : (
          <SettingsRow
            title={<AboutVersionTitle />}
            description="Current version of the application."
          />
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}

export function ArchivedThreadsPanel() {
  return (
    <SettingsPageContainer>
      <ArchivedThreadsSections />
    </SettingsPageContainer>
  );
}

export function GeneralSettingsPanel() {
  return <InterfaceSettingsPanel />;
}
