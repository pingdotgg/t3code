import {
  ArchiveIcon,
  ArchiveX,
  FolderOpenIcon,
  LoaderIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_REVIEW_CHANGES_PROMPT_TEMPLATE,
  DEFAULT_REVIEW_CHANGES_SCOPE,
  type AgentWorkflowDestinationMode,
  DEFAULT_AGENT_WORKFLOW_AUTOMATION_COOLDOWN_MS,
  DEFAULT_AGENT_WORKFLOW_MAX_RUNS_PER_THREAD,
  defaultInstanceIdForDriver,
  type DesktopUpdateChannel,
  ProviderDriverKind,
  type ProviderInstanceConfig,
  type ProviderInstanceId,
  type ReviewChangesScope,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime";
import {
  DEFAULT_CHAT_FONT_SIZE,
  DEFAULT_CHAT_EXPORT_DETAIL_SETTINGS,
  DEFAULT_CODE_FONT,
  DEFAULT_CODE_FONT_SIZE,
  DEFAULT_INPUT_FONT_SIZE,
  DEFAULT_SIDEBAR_FONT_SIZE,
  DEFAULT_SIDEBAR_TRANSLUCENCY,
  DEFAULT_STATUS_LINE_FONT_SIZE,
  DEFAULT_TOOL_FONT_SIZE,
  DEFAULT_THREAD_COMPLETION_NOTIFICATION_MODE,
  DEFAULT_UI_DENSITY,
  DEFAULT_UI_FONT,
  DEFAULT_UNIFIED_SETTINGS,
  type CodeFont,
  type FontSize,
  type SidebarTranslucency,
  type ThreadCompletionNotificationMode,
  type UiDensity,
  type UiFont,
} from "@t3tools/contracts/settings";
import { createModelSelection } from "@t3tools/shared/model";
import { Equal } from "effect";
import { APP_VERSION } from "../../branding";
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
import {
  setDesktopUpdateStateQueryData,
  useDesktopUpdateState,
} from "../../lib/desktopUpdateReactQuery";
import {
  getCustomModelOptionsByInstance,
  resolveAppModelSelectionState,
} from "../../modelSelection";
import {
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { ensureLocalApi, readLocalApi } from "../../localApi";
import { useShallow } from "zustand/react/shallow";
import {
  selectProjectsAcrossEnvironments,
  selectThreadShellsAcrossEnvironments,
  useStore,
} from "../../store";
import { formatRelativeTime, formatRelativeTimeLabel } from "../../timestampFormat";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { DraftInput } from "../ui/draft-input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { AddProviderInstanceDialog } from "./AddProviderInstanceDialog";
import { ProviderInstanceCard } from "./ProviderInstanceCard";
import { getDriverOption } from "./providerDriverMeta";
import {
  buildArchivedThreadGroups,
  buildProviderInstanceUpdatePatch,
} from "./SettingsPanels.logic";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
  useRelativeTimeTick,
} from "./settingsLayout";
import { ProjectFavicon } from "../ProjectFavicon";
import {
  useServerAvailableEditors,
  useServerKeybindingsConfigPath,
  useServerObservability,
  useServerProviders,
} from "../../rpc/serverState";

const THEME_OPTIONS = [
  {
    value: "system",
    label: "System",
  },
  {
    value: "light",
    label: "Light",
  },
  {
    value: "dark",
    label: "Dark",
  },
] as const;

const TIMESTAMP_FORMAT_LABELS = {
  locale: "System default",
  "12-hour": "12-hour",
  "24-hour": "24-hour",
} as const;

const UI_DENSITY_OPTIONS: ReadonlyArray<{ value: UiDensity; label: string; hint: string }> = [
  { value: "compact", label: "Compact", hint: "— tighter spacing" },
  { value: "default", label: "Default", hint: "— balanced" },
  { value: "comfortable", label: "Comfortable", hint: "— relaxed spacing" },
  { value: "spacious", label: "Spacious", hint: "— more breathing room" },
];

const SIDEBAR_TRANSLUCENCY_OPTIONS: ReadonlyArray<{
  value: SidebarTranslucency;
  label: string;
  hint: string;
}> = [
  { value: "off", label: "Off", hint: "— opaque, fastest" },
  { value: "subtle", label: "Subtle", hint: "— light frosted tint" },
  { value: "medium", label: "Medium", hint: "— balanced translucency" },
  { value: "strong", label: "Strong", hint: "— most see-through" },
  { value: "liquid-glass", label: "Liquid Glass", hint: "— ultra-clear, highest blur" },
];

const THREAD_COMPLETION_NOTIFICATION_OPTIONS: ReadonlyArray<{
  value: ThreadCompletionNotificationMode;
  label: string;
}> = [
  { value: "background-only", label: "Background only" },
  { value: "all", label: "All completions" },
  { value: "off", label: "Off" },
];

const REVIEW_CHANGES_SCOPE_OPTIONS: ReadonlyArray<{
  value: ReviewChangesScope;
  label: string;
}> = [
  { value: "uncommitted", label: "Uncommitted changes" },
  { value: "against-base", label: "Against base branch" },
];

const WORKFLOW_DESTINATION_OPTIONS: ReadonlyArray<{
  value: AgentWorkflowDestinationMode;
  label: string;
}> = [
  { value: "same-chat", label: "Same chat" },
  { value: "new-chat", label: "New chat" },
  { value: "child-chat", label: "Child chat" },
];

const DEFAULT_DRIVER_KIND = ProviderDriverKind.make("codex");

function withoutProviderInstanceKey<V>(
  record: Readonly<Record<ProviderInstanceId, V>> | undefined,
  key: ProviderInstanceId,
): Record<ProviderInstanceId, V> {
  const next = { ...record } as Record<ProviderInstanceId, V>;
  delete next[key];
  return next;
}

function withoutProviderInstanceFavorites(
  favorites: ReadonlyArray<{ readonly provider: ProviderInstanceId; readonly model: string }>,
  instanceId: ProviderInstanceId,
) {
  return favorites.filter((favorite) => favorite.provider !== instanceId);
}

const UI_FONT_OPTIONS: ReadonlyArray<{ value: UiFont; label: string }> = [
  {
    value: "dm-sans",
    label: "DM Sans",
  },
  {
    value: "geist",
    label: "Geist",
  },
];

const CODE_FONT_OPTIONS: ReadonlyArray<{ value: CodeFont; label: string }> = [
  {
    value: "system-mono",
    label: "System mono",
  },
  {
    value: "sf-mono",
    label: "SF Mono",
  },
  {
    value: "menlo",
    label: "Menlo",
  },
  {
    value: "jetbrains-mono",
    label: "JetBrains Mono",
  },
];

function isCodeFont(value: unknown): value is CodeFont {
  return CODE_FONT_OPTIONS.some((option) => option.value === value);
}

const FONT_SIZE_OPTIONS: ReadonlyArray<{ value: FontSize; label: string }> = [
  { value: 6, label: "6px" },
  { value: 7, label: "7px" },
  { value: 8, label: "8px" },
  { value: 9, label: "9px" },
  { value: 10, label: "10px" },
  { value: 11, label: "11px" },
  { value: 12, label: "12px" },
  { value: 13, label: "13px" },
  { value: 14, label: "14px" },
  { value: 15, label: "15px" },
  { value: 16, label: "16px" },
  { value: 18, label: "18px" },
  { value: 20, label: "20px" },
  { value: 22, label: "22px" },
  { value: 24, label: "24px" },
];

function isFontSize(value: unknown): value is FontSize {
  return FONT_SIZE_OPTIONS.some((option) => String(option.value) === String(value));
}

function isReviewChangesScope(value: unknown): value is ReviewChangesScope {
  return REVIEW_CHANGES_SCOPE_OPTIONS.some((option) => option.value === value);
}

function isAgentWorkflowDestinationMode(value: unknown): value is AgentWorkflowDestinationMode {
  return WORKFLOW_DESTINATION_OPTIONS.some((option) => option.value === value);
}

function ReviewPromptTemplateEditor({
  value,
  onCommit,
}: {
  value: string;
  onCommit: (nextValue: string) => void;
}) {
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  const commitDraft = useCallback(() => {
    if (draft !== value) {
      onCommit(draft);
    }
  }, [draft, onCommit, value]);

  return (
    <Textarea
      className="mt-4 w-full"
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commitDraft}
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
          event.currentTarget.blur();
        }
      }}
      placeholder={DEFAULT_REVIEW_CHANGES_PROMPT_TEMPLATE}
      aria-label="Review Code prompt template"
      spellCheck={false}
      rows={9}
    />
  );
}

type InstallProviderSettings = {
  provider: ProviderDriverKind;
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
    provider: ProviderDriverKind.make("codex"),
    title: "Codex",
    binaryPlaceholder: "Codex binary path",
    binaryDescription: "Path to the Codex binary",
    homePathKey: "codexHomePath",
    homePlaceholder: "CODEX_HOME",
    homeDescription: "Optional custom Codex home and config directory.",
  },
  {
    provider: ProviderDriverKind.make("claudeAgent"),
    title: "Claude",
    binaryPlaceholder: "Claude binary path",
    binaryDescription: "Path to the Claude binary",
  },
  {
    provider: ProviderDriverKind.make("cursor"),
    title: "Cursor",
    badgeLabel: "Early Access",
    binaryPlaceholder: "Cursor agent binary path",
    binaryDescription: "Path to the Cursor agent binary",
  },
  {
    provider: ProviderDriverKind.make("copilot"),
    title: "GitHub Copilot",
    binaryPlaceholder: "Copilot binary path",
    binaryDescription: "Path to the GitHub Copilot CLI binary",
  },
  {
    provider: ProviderDriverKind.make("opencode"),
    title: "OpenCode",
    binaryPlaceholder: "OpenCode binary path",
    binaryDescription: "Path to the OpenCode binary",
    serverUrlPlaceholder: "http://127.0.0.1:4096",
    serverUrlDescription: "Leave blank to let T3 Code spawn the server when needed",
    serverPasswordPlaceholder: "Server password (optional)",
    serverPasswordDescription:
      "If your OpenCode server requires authentication, enter the password here. NOTE: Stored in plain text on disk",
  },
] as const;

function ProviderLastChecked({ lastCheckedAt }: { lastCheckedAt: string | null }) {
  useRelativeTimeTick();
  const lastCheckedRelative = lastCheckedAt ? formatRelativeTime(lastCheckedAt) : null;

  if (!lastCheckedRelative) {
    return null;
  }

  return (
    <span className="text-[11px] text-muted-foreground/60">
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

function AboutVersionTitle() {
  return (
    <span className="inline-flex items-center gap-2">
      <span>Version</span>
      <code className="text-[11px] font-medium text-muted-foreground">{APP_VERSION}</code>
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

export function useSettingsRestore(onRestored?: () => void) {
  const { theme, setTheme } = useTheme();
  const settings = useSettings();
  const { resetSettings } = useUpdateSettings();

  const isGitWritingModelDirty = !Equal.equals(
    settings.textGenerationModelSelection ?? null,
    DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection ?? null,
  );
  // A provider surface is "dirty" if either the legacy per-kind
  // `settings.providers[kind]` struct differs from defaults (for users
  // on pre-migration data) or the new `settings.providerInstances` map
  // has any entries (every edit to a default slot promotes it into an
  // explicit entry, so any key in that map represents user intent to
  // diverge from factory defaults). Checking both keeps the Restore
  // Defaults chip accurate throughout the legacy→instance migration.
  const areProviderSettingsDirty =
    PROVIDER_SETTINGS.some((providerSettings) => {
      type LegacyProviderSettings = (typeof settings.providers)[keyof typeof settings.providers];
      const currentProviders = settings.providers as Record<
        string,
        LegacyProviderSettings | undefined
      >;
      const defaultProviders = DEFAULT_UNIFIED_SETTINGS.providers as Record<
        string,
        LegacyProviderSettings | undefined
      >;
      const currentSettings = currentProviders[providerSettings.provider];
      const defaultSettings = defaultProviders[providerSettings.provider];
      return !Equal.equals(currentSettings, defaultSettings);
    }) ||
    Object.keys(settings.providerInstances ?? {}).length > 0 ||
    Object.keys(settings.providerModelPreferences ?? {}).length > 0 ||
    (settings.favorites ?? []).length > 0;

  const changedSettingLabels = useMemo(
    () => [
      ...(theme !== "system" ? ["Theme"] : []),
      ...(settings.timestampFormat !== DEFAULT_UNIFIED_SETTINGS.timestampFormat
        ? ["Time format"]
        : []),
      ...(settings.uiDensity !== DEFAULT_UNIFIED_SETTINGS.uiDensity ? ["UI density"] : []),
      ...(settings.sidebarTranslucency !== DEFAULT_UNIFIED_SETTINGS.sidebarTranslucency
        ? ["Sidebar translucency"]
        : []),
      ...(settings.uiFont !== DEFAULT_UNIFIED_SETTINGS.uiFont ? ["Interface font"] : []),
      ...(settings.codeFont !== DEFAULT_UNIFIED_SETTINGS.codeFont ? ["Code font"] : []),
      ...(settings.codeFontSize !== DEFAULT_UNIFIED_SETTINGS.codeFontSize
        ? ["Code font size"]
        : []),
      ...(settings.chatFontSize !== DEFAULT_UNIFIED_SETTINGS.chatFontSize
        ? ["Chat font size"]
        : []),
      ...(settings.statusLineFontSize !== DEFAULT_UNIFIED_SETTINGS.statusLineFontSize
        ? ["Status line font size"]
        : []),
      ...(settings.inputFontSize !== DEFAULT_UNIFIED_SETTINGS.inputFontSize
        ? ["Input font size"]
        : []),
      ...(settings.sidebarFontSize !== DEFAULT_UNIFIED_SETTINGS.sidebarFontSize
        ? ["Sidebar font size"]
        : []),
      ...(settings.toolFontSize !== DEFAULT_UNIFIED_SETTINGS.toolFontSize
        ? ["Tool font size"]
        : []),
      ...(settings.diffWordWrap !== DEFAULT_UNIFIED_SETTINGS.diffWordWrap
        ? ["Diff line wrapping"]
        : []),
      ...(settings.autoOpenPlanSidebar !== DEFAULT_UNIFIED_SETTINGS.autoOpenPlanSidebar
        ? ["Auto-open task panel"]
        : []),
      ...(settings.enableAssistantStreaming !== DEFAULT_UNIFIED_SETTINGS.enableAssistantStreaming
        ? ["Assistant output"]
        : []),
      ...(settings.defaultThreadEnvMode !== DEFAULT_UNIFIED_SETTINGS.defaultThreadEnvMode
        ? ["New thread mode"]
        : []),
      ...(settings.addProjectBaseDirectory !== DEFAULT_UNIFIED_SETTINGS.addProjectBaseDirectory
        ? ["Add project base directory"]
        : []),
      ...(settings.confirmThreadArchive !== DEFAULT_UNIFIED_SETTINGS.confirmThreadArchive
        ? ["Archive confirmation"]
        : []),
      ...(settings.confirmThreadDelete !== DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete
        ? ["Delete confirmation"]
        : []),
      ...(settings.threadCompletionNotifications !==
      DEFAULT_UNIFIED_SETTINGS.threadCompletionNotifications
        ? ["Completion notifications"]
        : []),
      ...(!Equal.equals(settings.agentWorkflows, DEFAULT_UNIFIED_SETTINGS.agentWorkflows)
        ? ["Agent workflows"]
        : []),
      ...(isGitWritingModelDirty ? ["Git writing model"] : []),
      ...(areProviderSettingsDirty ? ["Providers"] : []),
    ],
    [
      areProviderSettingsDirty,
      isGitWritingModelDirty,
      settings.autoOpenPlanSidebar,
      settings.chatFontSize,
      settings.codeFontSize,
      settings.statusLineFontSize,
      settings.inputFontSize,
      settings.confirmThreadArchive,
      settings.confirmThreadDelete,
      settings.addProjectBaseDirectory,
      settings.codeFont,
      settings.defaultThreadEnvMode,
      settings.diffWordWrap,
      settings.enableAssistantStreaming,
      settings.agentWorkflows,
      settings.sidebarFontSize,
      settings.sidebarTranslucency,
      settings.threadCompletionNotifications,
      settings.timestampFormat,
      settings.toolFontSize,
      settings.uiDensity,
      settings.uiFont,
      theme,
    ],
  );

  const restoreDefaults = useCallback(async () => {
    if (changedSettingLabels.length === 0) return;
    const api = readLocalApi();
    const confirmed = await (api ?? ensureLocalApi()).dialogs.confirm(
      ["Restore default settings?", `This will reset: ${changedSettingLabels.join(", ")}.`].join(
        "\n",
      ),
    );
    if (!confirmed) return;

    setTheme("system");
    resetSettings();
    onRestored?.();
  }, [changedSettingLabels, onRestored, resetSettings, setTheme]);

  return {
    changedSettingLabels,
    restoreDefaults,
  };
}

export function GeneralSettingsPanel() {
  const { theme, setTheme } = useTheme();
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const [openingPathByTarget, setOpeningPathByTarget] = useState({
    keybindings: false,
    logsDirectory: false,
  });
  const [openPathErrorByTarget, setOpenPathErrorByTarget] = useState<
    Partial<Record<"keybindings" | "logsDirectory", string | null>>
  >({});
  const [isRefreshingProviders, setIsRefreshingProviders] = useState(false);
  const [isPickingChatExportDirectory, setIsPickingChatExportDirectory] = useState(false);
  const [isAddInstanceDialogOpen, setIsAddInstanceDialogOpen] = useState(false);
  // Collapsible state per provider-instance card, keyed by the instance id.
  // `Record<string, boolean>` so we don't need to preseed an entry for every
  // configured instance — an absent key reads as collapsed. Default-slot
  // rows share this state: their id is the driver slug
  // (`defaultInstanceIdForDriver(driver)`), which is also `ProviderDriverKind` at
  // runtime, so a pre-existing open key for e.g. "codex" persists across
  // the legacy/unified render swap.
  const [openInstanceDetails, setOpenInstanceDetails] = useState<Record<string, boolean>>({});
  const refreshingRef = useRef(false);
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

  const keybindingsConfigPath = useServerKeybindingsConfigPath();
  const availableEditors = useServerAvailableEditors();
  const observability = useServerObservability();
  const serverProviders = useServerProviders();
  const visibleProviderSettings = PROVIDER_SETTINGS.filter(
    (providerSettings) =>
      providerSettings.provider !== "cursor" ||
      serverProviders.some(
        (provider) =>
          provider.instanceId === defaultInstanceIdForDriver(ProviderDriverKind.make("cursor")),
      ),
  );
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

  const textGenerationModelSelection = resolveAppModelSelectionState(settings, serverProviders);
  const textGenInstanceId = textGenerationModelSelection.instanceId;
  const textGenModel = textGenerationModelSelection.model;
  const textGenModelOptions = textGenerationModelSelection.options;
  const gitModelInstanceEntries = sortProviderInstanceEntries(
    deriveProviderInstanceEntries(serverProviders),
  );
  const textGenInstanceEntry = gitModelInstanceEntries.find(
    (entry) => entry.instanceId === textGenInstanceId,
  );
  const textGenProvider: ProviderDriverKind =
    textGenInstanceEntry?.driverKind ?? DEFAULT_DRIVER_KIND;
  const gitModelOptionsByInstance = getCustomModelOptionsByInstance(
    settings,
    serverProviders,
    textGenInstanceId,
    textGenModel,
  );
  const isGitWritingModelDirty = !Equal.equals(
    settings.textGenerationModelSelection ?? null,
    DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection ?? null,
  );

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

  const chooseChatExportDirectory = useCallback(async () => {
    if (isPickingChatExportDirectory) {
      return;
    }
    setIsPickingChatExportDirectory(true);
    try {
      const pickedPath = await ensureLocalApi().dialogs.pickFolder(
        settings.chatExportDirectory ? { initialPath: settings.chatExportDirectory } : undefined,
      );
      if (pickedPath) {
        updateSettings({ chatExportDirectory: pickedPath });
      }
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Unable to choose export directory",
          description:
            error instanceof Error ? error.message : "An error occurred while opening the picker.",
        }),
      );
    } finally {
      setIsPickingChatExportDirectory(false);
    }
  }, [isPickingChatExportDirectory, settings.chatExportDirectory, updateSettings]);

  const updateChatExportDetail = useCallback(
    (patch: Partial<typeof settings.chatExportDetail>) => {
      updateSettings({
        chatExportDetail: {
          ...settings.chatExportDetail,
          ...patch,
        },
      });
    },
    [settings.chatExportDetail, updateSettings],
  );

  const openKeybindingsError = openPathErrorByTarget.keybindings ?? null;
  const openDiagnosticsError = openPathErrorByTarget.logsDirectory ?? null;
  const isOpeningKeybindings = openingPathByTarget.keybindings;
  const isOpeningLogsDirectory = openingPathByTarget.logsDirectory;

  const lastCheckedAt =
    serverProviders.length > 0
      ? serverProviders.reduce(
          (latest, provider) => (provider.checkedAt > latest ? provider.checkedAt : latest),
          serverProviders[0]!.checkedAt,
        )
      : null;

  /**
   * Build the list of rows to render, one per configured instance. Each
   * row carries enough context to drive `ProviderInstanceCard` without
   * threading storage concerns: whether it's a built-in default slot (in
   * which case `isDefault` is true, deletion is gated off, and the
   * effective envelope may have been synthesized from legacy just for
   * this render), the driver kind narrow for the in-card model-slug
   * normalization, and whether a reset-to-factory action is warranted.
   *
   * Ordering mirrors the prior split: visible built-in default slots
   * first (one per visible kind), then user-authored custom instances
   * grouped by driver after their default sibling, then orphan instances
   * whose driver isn't in the visible-defaults set.
   */
  interface InstanceRow {
    readonly instanceId: ProviderInstanceId;
    readonly instance: ProviderInstanceConfig;
    readonly driver: ProviderDriverKind;
    /** True for the slot whose id is `defaultInstanceIdForDriver(driver)`. */
    readonly isDefault: boolean;
    /**
     * True when this default slot differs from the factory defaults —
     * either through an explicit `providerInstances[defaultId]` entry,
     * or through a non-default legacy `settings.providers[kind]` struct
     * that we're still bridging. Used to show the reset-to-factory
     * affordance. Undefined for custom rows (they have a delete button
     * instead; "factory defaults" isn't meaningful).
     */
    readonly isDirty?: boolean;
  }

  const instancesByDriver = new Map<
    ProviderDriverKind,
    Array<[ProviderInstanceId, ProviderInstanceConfig]>
  >();
  for (const [rawId, instance] of Object.entries(settings.providerInstances ?? {})) {
    const driver = instance.driver;
    const list = instancesByDriver.get(driver) ?? [];
    list.push([rawId as ProviderInstanceId, instance]);
    instancesByDriver.set(driver, list);
  }

  const defaultSlotIdsBySource = new Set<string>(
    visibleProviderSettings.map((providerSettings) =>
      String(defaultInstanceIdForDriver(providerSettings.provider)),
    ),
  );

  const rows: InstanceRow[] = [];
  const visibleDriverKinds = new Set<ProviderDriverKind>(
    visibleProviderSettings.map((providerSettings) => providerSettings.provider),
  );

  for (const providerSettings of visibleProviderSettings) {
    type LegacyProviderSettings = (typeof settings.providers)[keyof typeof settings.providers];
    const legacyProviders = settings.providers as Record<string, LegacyProviderSettings>;
    const defaultLegacyProviders = DEFAULT_UNIFIED_SETTINGS.providers as Record<
      string,
      LegacyProviderSettings
    >;
    const driver = providerSettings.provider;
    const defaultInstanceId = defaultInstanceIdForDriver(driver);
    // Prefer an explicit `providerInstances[defaultId]` entry when one
    // exists (every edit via this UI promotes the default slot into
    // that map); fall back to synthesizing one from the legacy
    // `settings.providers[kind]` struct so first-time viewers still see
    // their persisted config.
    const explicitInstance = settings.providerInstances?.[defaultInstanceId];
    const legacyConfig = legacyProviders[providerSettings.provider]!;
    const defaultLegacyConfig = defaultLegacyProviders[providerSettings.provider]!;
    const effectiveInstance: ProviderInstanceConfig =
      explicitInstance ??
      ({
        driver,
        enabled: legacyConfig.enabled,
        config: legacyConfig,
      } satisfies ProviderInstanceConfig);
    const isDirty =
      explicitInstance !== undefined || !Equal.equals(legacyConfig, defaultLegacyConfig);
    rows.push({
      instanceId: defaultInstanceId,
      instance: effectiveInstance,
      driver,
      isDefault: true,
      isDirty,
    });
    // Non-default customs for this driver kind follow their default.
    for (const [id, instance] of instancesByDriver.get(providerSettings.provider) ?? []) {
      if (id === defaultInstanceId) continue;
      rows.push({ instanceId: id, instance, driver: instance.driver, isDefault: false });
    }
  }
  // Orphan instances: drivers the visible-defaults list doesn't cover
  // (e.g. Cursor when the server hasn't reported it but the user has
  // authored a Cursor instance anyway, or fork drivers not shipped by
  // this build). Preserve insertion order within each driver.
  for (const [driver, list] of instancesByDriver) {
    if (visibleDriverKinds.has(driver)) continue;
    for (const [id, instance] of list) {
      const isDefaultSlot = defaultSlotIdsBySource.has(String(id));
      rows.push({
        instanceId: id,
        instance,
        driver: instance.driver,
        isDefault: isDefaultSlot,
      });
    }
  }

  const updateProviderInstance = (
    row: InstanceRow,
    next: ProviderInstanceConfig,
    options?: {
      readonly textGenerationModelSelection?: Parameters<
        typeof buildProviderInstanceUpdatePatch
      >[0]["textGenerationModelSelection"];
    },
  ) => {
    updateSettings(
      buildProviderInstanceUpdatePatch({
        settings,
        instanceId: row.instanceId,
        instance: next,
        driver: row.driver,
        isDefault: row.isDefault,
        textGenerationModelSelection: options?.textGenerationModelSelection,
      }),
    );
  };

  const deleteProviderInstance = (id: ProviderInstanceId) => {
    updateSettings({
      providerInstances: withoutProviderInstanceKey(settings.providerInstances, id),
      providerModelPreferences: withoutProviderInstanceKey(settings.providerModelPreferences, id),
      favorites: withoutProviderInstanceFavorites(settings.favorites ?? [], id),
    });
  };

  const updateProviderModelPreferences = (
    instanceId: ProviderInstanceId,
    next: {
      readonly hiddenModels: ReadonlyArray<string>;
      readonly modelOrder: ReadonlyArray<string>;
    },
  ) => {
    const hiddenModels = [...new Set(next.hiddenModels.filter((slug) => slug.trim().length > 0))];
    const modelOrder = [...new Set(next.modelOrder.filter((slug) => slug.trim().length > 0))];
    const rest = withoutProviderInstanceKey(settings.providerModelPreferences, instanceId);
    updateSettings({
      providerModelPreferences:
        hiddenModels.length === 0 && modelOrder.length === 0
          ? rest
          : {
              ...rest,
              [instanceId]: {
                hiddenModels,
                modelOrder,
              },
            },
    });
  };

  const updateProviderFavoriteModels = (
    instanceId: ProviderInstanceId,
    nextFavoriteModels: ReadonlyArray<string>,
  ) => {
    const favoriteModels = [
      ...new Set(nextFavoriteModels.map((slug) => slug.trim()).filter((slug) => slug.length > 0)),
    ];
    updateSettings({
      favorites: [
        ...withoutProviderInstanceFavorites(settings.favorites ?? [], instanceId),
        ...favoriteModels.map((model) => ({ provider: instanceId, model })),
      ],
    });
  };

  /**
   * Reset a built-in default slot back to factory defaults. Clears both
   * the legacy `settings.providers[kind]` struct and any explicit
   * `providerInstances[defaultId]` entry that has promoted legacy into
   * the new map, so hydration re-synthesizes a clean envelope on next
   * load. Safe to call on drivers that have never been edited.
   */
  const resetDefaultInstance = (driverKind: ProviderDriverKind) => {
    type LegacyProviderSettings = (typeof settings.providers)[keyof typeof settings.providers];
    const defaultLegacyProviders = DEFAULT_UNIFIED_SETTINGS.providers as Record<
      string,
      LegacyProviderSettings | undefined
    >;
    const defaultInstanceId = defaultInstanceIdForDriver(driverKind);
    const defaultLegacyProvider = defaultLegacyProviders[driverKind];
    if (defaultLegacyProvider === undefined) return;
    updateSettings({
      providers: {
        ...settings.providers,
        [driverKind]: defaultLegacyProvider,
      } as typeof settings.providers,
      providerInstances: withoutProviderInstanceKey(settings.providerInstances, defaultInstanceId),
      providerModelPreferences: withoutProviderInstanceKey(
        settings.providerModelPreferences,
        defaultInstanceId,
      ),
      favorites: withoutProviderInstanceFavorites(settings.favorites ?? [], defaultInstanceId),
    });
  };

  return (
    <SettingsPageContainer>
      <SettingsSection title="General">
        <SettingsRow
          title="Theme"
          description="Choose how T3 Code looks across the app."
          resetAction={
            theme !== "system" ? (
              <SettingResetButton label="theme" onClick={() => setTheme("system")} />
            ) : null
          }
          control={
            <Select
              value={theme}
              onValueChange={(value) => {
                if (value === "system" || value === "light" || value === "dark") {
                  setTheme(value);
                }
              }}
            >
              <SelectTrigger className="w-full sm:w-40" aria-label="Theme preference">
                <SelectValue>
                  {THEME_OPTIONS.find((option) => option.value === theme)?.label ?? "System"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {THEME_OPTIONS.map((option) => (
                  <SelectItem hideIndicator key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />

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
          title="UI density"
          description="Control spacing across the entire interface — sidebar, chat, composer, and toolbars."
          resetAction={
            settings.uiDensity !== DEFAULT_UI_DENSITY ? (
              <SettingResetButton
                label="UI density"
                onClick={() => updateSettings({ uiDensity: DEFAULT_UI_DENSITY })}
              />
            ) : null
          }
          control={
            <Select
              value={settings.uiDensity}
              onValueChange={(value) => {
                if (UI_DENSITY_OPTIONS.some((option) => option.value === value)) {
                  updateSettings({ uiDensity: value as UiDensity });
                }
              }}
            >
              <SelectTrigger className="w-full sm:w-40" aria-label="UI density">
                <SelectValue>
                  {UI_DENSITY_OPTIONS.find((option) => option.value === settings.uiDensity)
                    ?.label ?? "Default"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {UI_DENSITY_OPTIONS.map((option) => (
                  <SelectItem hideIndicator key={option.value} value={option.value}>
                    <div>
                      <span className="font-medium">{option.label}</span>
                      <span className="ml-2 text-muted-foreground/70">{option.hint}</span>
                    </div>
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />

        <SettingsRow
          title="Sidebar translucency"
          description="Control the sidebar's frosted tint. Desktop builds use native vibrancy when available; browsers fall back to CSS blur."
          resetAction={
            settings.sidebarTranslucency !== DEFAULT_SIDEBAR_TRANSLUCENCY ? (
              <SettingResetButton
                label="sidebar translucency"
                onClick={() =>
                  updateSettings({ sidebarTranslucency: DEFAULT_SIDEBAR_TRANSLUCENCY })
                }
              />
            ) : null
          }
          control={
            <Select
              value={settings.sidebarTranslucency}
              onValueChange={(value) => {
                if (
                  value === "off" ||
                  value === "subtle" ||
                  value === "medium" ||
                  value === "strong" ||
                  value === "liquid-glass"
                ) {
                  updateSettings({ sidebarTranslucency: value });
                }
              }}
            >
              <SelectTrigger className="w-full sm:w-40" aria-label="Sidebar translucency">
                <SelectValue>
                  {SIDEBAR_TRANSLUCENCY_OPTIONS.find(
                    (option) => option.value === settings.sidebarTranslucency,
                  )?.label ?? "Off"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {SIDEBAR_TRANSLUCENCY_OPTIONS.map((option) => (
                  <SelectItem hideIndicator key={option.value} value={option.value}>
                    <div>
                      <span className="font-medium">{option.label}</span>
                      <span className="ml-2 text-muted-foreground/70">{option.hint}</span>
                    </div>
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
      </SettingsSection>

      <SettingsSection title="Fonts">
        <SettingsRow
          title="Interface font"
          description="Choose the sans-serif typeface used throughout the app UI."
          resetAction={
            settings.uiFont !== DEFAULT_UI_FONT ? (
              <SettingResetButton
                label="interface font"
                onClick={() =>
                  updateSettings({
                    uiFont: DEFAULT_UI_FONT,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={settings.uiFont}
              onValueChange={(value) => {
                if (value === "dm-sans" || value === "geist") {
                  updateSettings({ uiFont: value });
                }
              }}
            >
              <SelectTrigger className="w-full sm:w-40" aria-label="Interface font">
                <SelectValue>
                  {UI_FONT_OPTIONS.find((option) => option.value === settings.uiFont)?.label ??
                    "DM Sans"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {UI_FONT_OPTIONS.map((option) => (
                  <SelectItem hideIndicator key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          title="Code font"
          description="Choose the monospace typeface used for code blocks, diffs, and terminals."
          resetAction={
            settings.codeFont !== DEFAULT_CODE_FONT ? (
              <SettingResetButton
                label="code font"
                onClick={() =>
                  updateSettings({
                    codeFont: DEFAULT_CODE_FONT,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={settings.codeFont}
              onValueChange={(value) => {
                if (isCodeFont(value)) {
                  updateSettings({ codeFont: value });
                }
              }}
            >
              <SelectTrigger className="w-full sm:w-40" aria-label="Code font">
                <SelectValue>
                  {CODE_FONT_OPTIONS.find((option) => option.value === settings.codeFont)?.label ??
                    "System mono"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {CODE_FONT_OPTIONS.map((option) => (
                  <SelectItem hideIndicator key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          title="Code font size"
          description="Font size for code blocks, diffs, and terminals."
          resetAction={
            settings.codeFontSize !== DEFAULT_CODE_FONT_SIZE ? (
              <SettingResetButton
                label="code font size"
                onClick={() =>
                  updateSettings({
                    codeFontSize: DEFAULT_CODE_FONT_SIZE,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={String(settings.codeFontSize)}
              onValueChange={(value) => {
                const num = Number(value);
                if (isFontSize(num)) {
                  updateSettings({ codeFontSize: num });
                }
              }}
            >
              <SelectTrigger className="w-full sm:w-40" aria-label="Code font size">
                <SelectValue>
                  {FONT_SIZE_OPTIONS.find((option) => option.value === settings.codeFontSize)
                    ?.label ?? `${DEFAULT_CODE_FONT_SIZE}px`}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {FONT_SIZE_OPTIONS.map((option) => (
                  <SelectItem hideIndicator key={option.value} value={String(option.value)}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          title="Chat font size"
          description="Font size for assistant and user messages in the chat."
          resetAction={
            settings.chatFontSize !== DEFAULT_CHAT_FONT_SIZE ? (
              <SettingResetButton
                label="chat font size"
                onClick={() =>
                  updateSettings({
                    chatFontSize: DEFAULT_CHAT_FONT_SIZE,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={String(settings.chatFontSize)}
              onValueChange={(value) => {
                const num = Number(value);
                if (isFontSize(num)) {
                  updateSettings({ chatFontSize: num });
                }
              }}
            >
              <SelectTrigger className="w-full sm:w-40" aria-label="Chat font size">
                <SelectValue>
                  {FONT_SIZE_OPTIONS.find((option) => option.value === settings.chatFontSize)
                    ?.label ?? `${DEFAULT_CHAT_FONT_SIZE}px`}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {FONT_SIZE_OPTIONS.map((option) => (
                  <SelectItem hideIndicator key={option.value} value={String(option.value)}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          title="Status line font size"
          description="Font size for assistant metadata lines, including timestamps, elapsed time, and resume commands."
          resetAction={
            settings.statusLineFontSize !== DEFAULT_STATUS_LINE_FONT_SIZE ? (
              <SettingResetButton
                label="status line font size"
                onClick={() =>
                  updateSettings({
                    statusLineFontSize: DEFAULT_STATUS_LINE_FONT_SIZE,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={String(settings.statusLineFontSize)}
              onValueChange={(value) => {
                const num = Number(value);
                if (isFontSize(num)) {
                  updateSettings({ statusLineFontSize: num });
                }
              }}
            >
              <SelectTrigger className="w-full sm:w-40" aria-label="Status line font size">
                <SelectValue>
                  {FONT_SIZE_OPTIONS.find((option) => option.value === settings.statusLineFontSize)
                    ?.label ?? `${DEFAULT_STATUS_LINE_FONT_SIZE}px`}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {FONT_SIZE_OPTIONS.map((option) => (
                  <SelectItem hideIndicator key={option.value} value={String(option.value)}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          title="Input font size"
          description="Font size for the message composer, its controls, and menus."
          resetAction={
            settings.inputFontSize !== DEFAULT_INPUT_FONT_SIZE ? (
              <SettingResetButton
                label="input font size"
                onClick={() =>
                  updateSettings({
                    inputFontSize: DEFAULT_INPUT_FONT_SIZE,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={String(settings.inputFontSize)}
              onValueChange={(value) => {
                const num = Number(value);
                if (isFontSize(num)) {
                  updateSettings({ inputFontSize: num });
                }
              }}
            >
              <SelectTrigger className="w-full sm:w-40" aria-label="Input font size">
                <SelectValue>
                  {FONT_SIZE_OPTIONS.find((option) => option.value === settings.inputFontSize)
                    ?.label ?? `${DEFAULT_INPUT_FONT_SIZE}px`}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {FONT_SIZE_OPTIONS.map((option) => (
                  <SelectItem hideIndicator key={option.value} value={String(option.value)}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          title="Sidebar font size"
          description="Font size for project and chat titles in the sidebar."
          resetAction={
            settings.sidebarFontSize !== DEFAULT_SIDEBAR_FONT_SIZE ? (
              <SettingResetButton
                label="sidebar font size"
                onClick={() =>
                  updateSettings({
                    sidebarFontSize: DEFAULT_SIDEBAR_FONT_SIZE,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={String(settings.sidebarFontSize)}
              onValueChange={(value) => {
                const num = Number(value);
                if (isFontSize(num)) {
                  updateSettings({ sidebarFontSize: num });
                }
              }}
            >
              <SelectTrigger className="w-full sm:w-40" aria-label="Sidebar font size">
                <SelectValue>
                  {FONT_SIZE_OPTIONS.find((option) => option.value === settings.sidebarFontSize)
                    ?.label ?? `${DEFAULT_SIDEBAR_FONT_SIZE}px`}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {FONT_SIZE_OPTIONS.map((option) => (
                  <SelectItem hideIndicator key={option.value} value={String(option.value)}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          title="Tool output font size"
          description="Font size for work log entries and tool call output."
          resetAction={
            settings.toolFontSize !== DEFAULT_TOOL_FONT_SIZE ? (
              <SettingResetButton
                label="tool output font size"
                onClick={() =>
                  updateSettings({
                    toolFontSize: DEFAULT_TOOL_FONT_SIZE,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={String(settings.toolFontSize)}
              onValueChange={(value) => {
                const num = Number(value);
                if (isFontSize(num)) {
                  updateSettings({ toolFontSize: num });
                }
              }}
            >
              <SelectTrigger className="w-full sm:w-40" aria-label="Tool output font size">
                <SelectValue>
                  {FONT_SIZE_OPTIONS.find((option) => option.value === settings.toolFontSize)
                    ?.label ?? `${DEFAULT_TOOL_FONT_SIZE}px`}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {FONT_SIZE_OPTIONS.map((option) => (
                  <SelectItem hideIndicator key={option.value} value={String(option.value)}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
      </SettingsSection>

      <SettingsSection title="Preferences">
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

        <SettingsRow
          title="Completion notifications"
          description="Show macOS notifications when a chat finishes."
          resetAction={
            settings.threadCompletionNotifications !==
            DEFAULT_THREAD_COMPLETION_NOTIFICATION_MODE ? (
              <SettingResetButton
                label="completion notifications"
                onClick={() =>
                  updateSettings({
                    threadCompletionNotifications: DEFAULT_THREAD_COMPLETION_NOTIFICATION_MODE,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={settings.threadCompletionNotifications}
              onValueChange={(value) => {
                if (value === "off" || value === "background-only" || value === "all") {
                  updateSettings({ threadCompletionNotifications: value });
                }
              }}
            >
              <SelectTrigger className="w-full sm:w-44" aria-label="Completion notifications">
                <SelectValue>
                  {THREAD_COMPLETION_NOTIFICATION_OPTIONS.find(
                    (option) => option.value === settings.threadCompletionNotifications,
                  )?.label ?? "Background only"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {THREAD_COMPLETION_NOTIFICATION_OPTIONS.map((option) => (
                  <SelectItem hideIndicator key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />

        <SettingsRow
          title="Auto-open task panel"
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
              aria-label="Open the task sidebar automatically"
            />
          }
        />

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
            <DraftInput
              className="w-full sm:w-72"
              value={settings.addProjectBaseDirectory}
              onCommit={(next) => updateSettings({ addProjectBaseDirectory: next })}
              placeholder="~/"
              spellCheck={false}
              aria-label="Add project base directory"
            />
          }
        />

        <SettingsRow
          title="Chat export directory"
          description="Markdown chat exports are saved here before opening in your preferred editor."
          resetAction={
            settings.chatExportDirectory !== DEFAULT_UNIFIED_SETTINGS.chatExportDirectory ? (
              <SettingResetButton
                label="chat export directory"
                onClick={() =>
                  updateSettings({
                    chatExportDirectory: DEFAULT_UNIFIED_SETTINGS.chatExportDirectory,
                  })
                }
              />
            ) : null
          }
          control={
            <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
              <DraftInput
                className="w-full sm:w-72"
                value={settings.chatExportDirectory}
                onCommit={(next) => updateSettings({ chatExportDirectory: next })}
                placeholder="~/t3-chat-exports"
                spellCheck={false}
                aria-label="Chat export directory"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void chooseChatExportDirectory()}
                disabled={isPickingChatExportDirectory}
              >
                {isPickingChatExportDirectory ? (
                  <LoaderIcon className="size-3.5 animate-spin" />
                ) : (
                  <FolderOpenIcon className="size-3.5" />
                )}
                Choose
              </Button>
            </div>
          }
        />

        <SettingsRow
          title="Chat export details"
          description="Choose which extra sections are included in exported Markdown chat files."
          resetAction={
            !Equal.equals(settings.chatExportDetail, DEFAULT_CHAT_EXPORT_DETAIL_SETTINGS) ? (
              <SettingResetButton
                label="chat export details"
                onClick={() =>
                  updateSettings({
                    chatExportDetail: DEFAULT_CHAT_EXPORT_DETAIL_SETTINGS,
                  })
                }
              />
            ) : null
          }
          control={
            <div className="grid w-full gap-2 sm:w-80">
              <label className="flex items-center justify-between gap-4 text-xs text-foreground">
                <span>Thread and session metadata</span>
                <Switch
                  checked={settings.chatExportDetail.includeMetadata}
                  onCheckedChange={(checked) =>
                    updateChatExportDetail({ includeMetadata: Boolean(checked) })
                  }
                  aria-label="Include metadata in chat exports"
                />
              </label>
              <label className="flex items-center justify-between gap-4 text-xs text-foreground">
                <span>Tool calls and activity</span>
                <Switch
                  checked={settings.chatExportDetail.includeToolCalls}
                  onCheckedChange={(checked) =>
                    updateChatExportDetail({ includeToolCalls: Boolean(checked) })
                  }
                  aria-label="Include tool calls in chat exports"
                />
              </label>
              <label className="flex items-center justify-between gap-4 text-xs text-foreground">
                <span>Diffs and checkpoints</span>
                <Switch
                  checked={settings.chatExportDetail.includeDiffs}
                  onCheckedChange={(checked) =>
                    updateChatExportDetail({ includeDiffs: Boolean(checked) })
                  }
                  aria-label="Include diffs in chat exports"
                />
              </label>
              <label className="flex items-center justify-between gap-4 text-xs text-foreground">
                <span>Proposed plans</span>
                <Switch
                  checked={settings.chatExportDetail.includePlans}
                  onCheckedChange={(checked) =>
                    updateChatExportDetail({ includePlans: Boolean(checked) })
                  }
                  aria-label="Include proposed plans in chat exports"
                />
              </label>
              <label className="flex items-center justify-between gap-4 text-xs text-foreground">
                <span>Queued turns</span>
                <Switch
                  checked={settings.chatExportDetail.includeQueuedTurns}
                  onCheckedChange={(checked) =>
                    updateChatExportDetail({ includeQueuedTurns: Boolean(checked) })
                  }
                  aria-label="Include queued turns in chat exports"
                />
              </label>
            </div>
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
                activeInstanceId={textGenInstanceId}
                model={textGenModel}
                lockedProvider={null}
                instanceEntries={gitModelInstanceEntries}
                modelOptionsByInstance={gitModelOptionsByInstance}
                triggerVariant="outline"
                triggerClassName="min-w-0 max-w-none shrink-0 text-foreground/90 hover:text-foreground"
                onInstanceModelChange={(instanceId, model) => {
                  updateSettings({
                    textGenerationModelSelection: resolveAppModelSelectionState(
                      {
                        ...settings,
                        textGenerationModelSelection: createModelSelection(instanceId, model),
                      },
                      serverProviders,
                    ),
                  });
                }}
              />
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
                triggerVariant="outline"
                triggerClassName="min-w-0 max-w-none shrink-0 text-foreground/90 hover:text-foreground"
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
                    onClick={() => setIsAddInstanceDialogOpen(true)}
                    aria-label="Add provider instance"
                  >
                    <PlusIcon className="size-3" />
                  </Button>
                }
              />
              <TooltipPopup side="top">Add provider instance</TooltipPopup>
            </Tooltip>
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
        {rows.map((row) => {
          const driverOption = getDriverOption(row.driver);
          const liveProvider = serverProviders.find(
            (candidate) => candidate.instanceId === row.instanceId,
          );
          const modelPreferences = settings.providerModelPreferences?.[row.instanceId] ?? {
            hiddenModels: [],
            modelOrder: [],
          };
          const favoriteModels = (settings.favorites ?? [])
            .filter((favorite) => favorite.provider === row.instanceId)
            .map((favorite) => favorite.model);
          const resetLabel = driverOption?.label ?? String(row.driver);
          const headerAction =
            row.isDefault && row.isDirty ? (
              <SettingResetButton
                label={`${resetLabel} provider settings`}
                onClick={() => resetDefaultInstance(row.driver)}
              />
            ) : null;
          return (
            <ProviderInstanceCard
              key={row.instanceId}
              instanceId={row.instanceId}
              instance={row.instance}
              driverOption={driverOption}
              liveProvider={liveProvider}
              isExpanded={openInstanceDetails[row.instanceId] ?? false}
              onExpandedChange={(open) =>
                setOpenInstanceDetails((existing) => ({
                  ...existing,
                  [row.instanceId]: open,
                }))
              }
              onUpdate={(next) => {
                // When the user disables the exact instance the text-gen
                // selection points at, fall back to the global default so we
                // don't leave the selection dangling on a disabled instance.
                // Prior kind-level behavior cleared on any kind-matching
                // disable; instance-level addressing makes this narrower and
                // more accurate (other instances of the same kind stay
                // untouched).
                const wasEnabled = row.instance.enabled ?? true;
                const isDisabling = next.enabled === false && wasEnabled;
                const shouldClearTextGen = isDisabling && textGenInstanceId === row.instanceId;
                if (shouldClearTextGen) {
                  updateProviderInstance(row, next, {
                    textGenerationModelSelection:
                      DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection,
                  });
                } else {
                  updateProviderInstance(row, next);
                }
              }}
              onDelete={row.isDefault ? undefined : () => deleteProviderInstance(row.instanceId)}
              headerAction={headerAction}
              hiddenModels={modelPreferences.hiddenModels}
              favoriteModels={favoriteModels}
              modelOrder={modelPreferences.modelOrder}
              onHiddenModelsChange={(hiddenModels) =>
                updateProviderModelPreferences(row.instanceId, {
                  ...modelPreferences,
                  hiddenModels,
                })
              }
              onFavoriteModelsChange={(favoriteModels) =>
                updateProviderFavoriteModels(row.instanceId, favoriteModels)
              }
              onModelOrderChange={(modelOrder) =>
                updateProviderModelPreferences(row.instanceId, {
                  ...modelPreferences,
                  modelOrder,
                })
              }
            />
          );
        })}
      </SettingsSection>

      <AddProviderInstanceDialog
        open={isAddInstanceDialogOpen}
        onOpenChange={setIsAddInstanceDialogOpen}
      />

      <SettingsSection title="Advanced">
        <SettingsRow
          title="Keybindings"
          description="Open the persisted `keybindings.json` file to edit advanced bindings directly."
          status={
            <>
              <span className="block break-all font-mono text-[11px] text-foreground">
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

      <SettingsSection title="About">
        {isElectron ? (
          <AboutVersionSection />
        ) : (
          <SettingsRow
            title={<AboutVersionTitle />}
            description="Current version of the application."
          />
        )}
        <SettingsRow
          title="Diagnostics"
          description={diagnosticsDescription}
          status={
            <>
              <span className="block break-all font-mono text-[11px] text-foreground">
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
    </SettingsPageContainer>
  );
}

export function AgentWorkflowsSettingsPanel() {
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const customWorkflows = settings.agentWorkflows.customWorkflows;

  const updateAgentWorkflows = useCallback(
    (patch: Partial<typeof settings.agentWorkflows>) => {
      updateSettings({
        agentWorkflows: {
          ...settings.agentWorkflows,
          ...patch,
        },
      });
    },
    [settings.agentWorkflows, updateSettings],
  );

  const updateReviewChangesWorkflow = useCallback(
    (patch: Partial<typeof settings.agentWorkflows.reviewChanges>) => {
      updateAgentWorkflows({
        reviewChanges: {
          ...settings.agentWorkflows.reviewChanges,
          ...patch,
        },
      });
    },
    [settings.agentWorkflows.reviewChanges, updateAgentWorkflows],
  );

  const updateCustomWorkflows = useCallback(
    (nextCustomWorkflows: typeof customWorkflows) => {
      updateAgentWorkflows({ customWorkflows: nextCustomWorkflows });
    },
    [customWorkflows, updateAgentWorkflows],
  );

  const addCustomWorkflow = useCallback(() => {
    updateCustomWorkflows([
      ...customWorkflows,
      {
        id: `custom-${crypto.randomUUID()}`,
        enabled: true,
        name: "New workflow",
        buttonLabel: "Run",
        promptTemplate: "",
        showInHeader: true,
        destinationMode: "child-chat",
        automation: {
          afterAssistantTurnCompletes: false,
          cooldownMs: DEFAULT_AGENT_WORKFLOW_AUTOMATION_COOLDOWN_MS,
          maxRunsPerThread: DEFAULT_AGENT_WORKFLOW_MAX_RUNS_PER_THREAD,
        },
      },
    ]);
  }, [customWorkflows, updateCustomWorkflows]);

  const updateCustomWorkflow = useCallback(
    (workflowId: string, patch: Partial<(typeof customWorkflows)[number]>) => {
      updateCustomWorkflows(
        customWorkflows.map((workflow) =>
          workflow.id === workflowId ? { ...workflow, ...patch } : workflow,
        ),
      );
    },
    [customWorkflows, updateCustomWorkflows],
  );

  const deleteCustomWorkflow = useCallback(
    (workflowId: string) => {
      updateCustomWorkflows(customWorkflows.filter((workflow) => workflow.id !== workflowId));
    },
    [customWorkflows, updateCustomWorkflows],
  );

  const commitRequiredCustomText = useCallback(
    (workflowId: string, key: "name" | "buttonLabel", value: string) => {
      const trimmed = value.trim();
      if (trimmed.length === 0) {
        toastManager.add({
          type: "warning",
          title: key === "name" ? "Workflow name is required" : "Button label is required",
        });
        return;
      }
      updateCustomWorkflow(workflowId, { [key]: trimmed });
    },
    [updateCustomWorkflow],
  );

  return (
    <SettingsPageContainer>
      <SettingsSection title="Built-in workflows">
        <SettingsRow
          title="Review Code"
          description="Show the Review Code header action and allow it to create review chats."
          resetAction={
            settings.agentWorkflows.reviewChanges.enabled !==
            DEFAULT_UNIFIED_SETTINGS.agentWorkflows.reviewChanges.enabled ? (
              <SettingResetButton
                label="Review Code workflow enabled state"
                onClick={() =>
                  updateReviewChangesWorkflow({
                    enabled: DEFAULT_UNIFIED_SETTINGS.agentWorkflows.reviewChanges.enabled,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.agentWorkflows.reviewChanges.enabled}
              onCheckedChange={(checked) =>
                updateReviewChangesWorkflow({ enabled: Boolean(checked) })
              }
              aria-label="Enable Review Code workflow"
            />
          }
        />

        <SettingsRow
          title="Review scope"
          description="Default scope for the Review Code button. The dropdown can still run either scope."
          resetAction={
            settings.agentWorkflows.reviewChanges.defaultScope !== DEFAULT_REVIEW_CHANGES_SCOPE ? (
              <SettingResetButton
                label="Review Code default scope"
                onClick={() =>
                  updateReviewChangesWorkflow({
                    defaultScope: DEFAULT_REVIEW_CHANGES_SCOPE,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={settings.agentWorkflows.reviewChanges.defaultScope}
              onValueChange={(value) => {
                if (isReviewChangesScope(value)) {
                  updateReviewChangesWorkflow({ defaultScope: value });
                }
              }}
            >
              <SelectTrigger className="w-full sm:w-48" aria-label="Review Code default scope">
                <SelectValue>
                  {REVIEW_CHANGES_SCOPE_OPTIONS.find(
                    (option) => option.value === settings.agentWorkflows.reviewChanges.defaultScope,
                  )?.label ?? "Uncommitted changes"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {REVIEW_CHANGES_SCOPE_OPTIONS.map((option) => (
                  <SelectItem hideIndicator key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />

        <SettingsRow
          title="Review prompt"
          description="Instructions inserted after the fixed scope context. Leave blank to use the built-in default prompt."
          resetAction={
            settings.agentWorkflows.reviewChanges.promptTemplate !==
            DEFAULT_REVIEW_CHANGES_PROMPT_TEMPLATE ? (
              <SettingResetButton
                label="Review Code prompt"
                onClick={() =>
                  updateReviewChangesWorkflow({
                    promptTemplate: DEFAULT_REVIEW_CHANGES_PROMPT_TEMPLATE,
                  })
                }
              />
            ) : null
          }
        >
          <ReviewPromptTemplateEditor
            value={settings.agentWorkflows.reviewChanges.promptTemplate}
            onCommit={(promptTemplate) => updateReviewChangesWorkflow({ promptTemplate })}
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection
        title="Custom workflows"
        headerAction={
          <Button size="xs" variant="outline" onClick={addCustomWorkflow}>
            <PlusIcon className="size-3.5" />
            Add workflow
          </Button>
        }
      >
        {customWorkflows.length === 0 ? (
          <SettingsRow
            title="No custom workflows"
            description="Create a prompt-only workflow to show it in the chat header."
          />
        ) : (
          customWorkflows.map((workflow) => (
            <div key={workflow.id} className="border-t border-border/60 first:border-t-0">
              <SettingsRow
                title={workflow.name}
                description="Configure the workflow display, destination, and prompt."
                control={
                  <div className="flex items-center gap-2">
                    <Switch
                      checked={workflow.enabled}
                      onCheckedChange={(checked) =>
                        updateCustomWorkflow(workflow.id, { enabled: Boolean(checked) })
                      }
                      aria-label={`Enable ${workflow.name}`}
                    />
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      className="size-6 text-muted-foreground hover:text-destructive"
                      aria-label={`Delete ${workflow.name}`}
                      onClick={() => deleteCustomWorkflow(workflow.id)}
                    >
                      <Trash2Icon className="size-3.5" />
                    </Button>
                  </div>
                }
              >
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <DraftInput
                    value={workflow.name}
                    onCommit={(value) => commitRequiredCustomText(workflow.id, "name", value)}
                    placeholder="Workflow name"
                    aria-label={`${workflow.name} workflow name`}
                  />
                  <DraftInput
                    value={workflow.buttonLabel}
                    onCommit={(value) =>
                      commitRequiredCustomText(workflow.id, "buttonLabel", value)
                    }
                    placeholder="Button label"
                    aria-label={`${workflow.name} button label`}
                  />
                  <div className="flex items-center justify-between rounded-lg border px-3 py-2">
                    <span className="text-xs text-muted-foreground">Show in chat header</span>
                    <Switch
                      checked={workflow.showInHeader}
                      onCheckedChange={(checked) =>
                        updateCustomWorkflow(workflow.id, { showInHeader: Boolean(checked) })
                      }
                      aria-label={`Show ${workflow.name} in header`}
                    />
                  </div>
                  <Select
                    value={workflow.destinationMode}
                    onValueChange={(value) => {
                      if (isAgentWorkflowDestinationMode(value)) {
                        updateCustomWorkflow(workflow.id, { destinationMode: value });
                      }
                    }}
                  >
                    <SelectTrigger aria-label={`${workflow.name} destination`}>
                      <SelectValue>
                        {WORKFLOW_DESTINATION_OPTIONS.find(
                          (option) => option.value === workflow.destinationMode,
                        )?.label ?? "Child chat"}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectPopup align="end" alignItemWithTrigger={false}>
                      {WORKFLOW_DESTINATION_OPTIONS.map((option) => (
                        <SelectItem hideIndicator key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                  <div className="flex items-center justify-between rounded-lg border px-3 py-2">
                    <span className="text-xs text-muted-foreground">
                      Run after assistant completes
                    </span>
                    <Switch
                      checked={workflow.automation.afterAssistantTurnCompletes}
                      onCheckedChange={(checked) =>
                        updateCustomWorkflow(workflow.id, {
                          automation: {
                            ...workflow.automation,
                            afterAssistantTurnCompletes: Boolean(checked),
                          },
                        })
                      }
                      aria-label={`Run ${workflow.name} after assistant completes`}
                    />
                  </div>
                  <label className="grid gap-1 text-xs text-muted-foreground">
                    Cooldown seconds
                    <DraftInput
                      value={String(Math.round(workflow.automation.cooldownMs / 1000))}
                      inputMode="numeric"
                      onCommit={(value) => {
                        const seconds = Number.parseInt(value.trim(), 10);
                        if (!Number.isFinite(seconds) || seconds < 0) {
                          toastManager.add({
                            type: "warning",
                            title: "Cooldown must be zero or greater",
                          });
                          return;
                        }
                        updateCustomWorkflow(workflow.id, {
                          automation: {
                            ...workflow.automation,
                            cooldownMs: seconds * 1000,
                          },
                        });
                      }}
                      aria-label={`${workflow.name} automation cooldown seconds`}
                    />
                  </label>
                  <label className="grid gap-1 text-xs text-muted-foreground">
                    Max runs per thread
                    <DraftInput
                      value={String(workflow.automation.maxRunsPerThread)}
                      inputMode="numeric"
                      onCommit={(value) => {
                        const maxRunsPerThread = Number.parseInt(value.trim(), 10);
                        if (!Number.isFinite(maxRunsPerThread) || maxRunsPerThread < 0) {
                          toastManager.add({
                            type: "warning",
                            title: "Max runs must be zero or greater",
                          });
                          return;
                        }
                        updateCustomWorkflow(workflow.id, {
                          automation: {
                            ...workflow.automation,
                            maxRunsPerThread,
                          },
                        });
                      }}
                      aria-label={`${workflow.name} automation max runs per thread`}
                    />
                  </label>
                </div>
                <ReviewPromptTemplateEditor
                  value={workflow.promptTemplate}
                  onCommit={(promptTemplate) =>
                    updateCustomWorkflow(workflow.id, { promptTemplate })
                  }
                />
              </SettingsRow>
            </div>
          ))
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}

export function ArchivedThreadsPanel() {
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const threads = useStore(useShallow(selectThreadShellsAcrossEnvironments));
  const { unarchiveThread, confirmAndDeleteThread } = useThreadActions();
  const archivedGroups = useMemo(() => {
    return buildArchivedThreadGroups({ projects, threads });
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

  return (
    <SettingsPageContainer>
      {archivedGroups.length === 0 ? (
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
      ) : (
        archivedGroups.map(({ project, threads: projectThreads }) => (
          <SettingsSection
            key={`${project.environmentId}:${project.id}`}
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
        ))
      )}
    </SettingsPageContainer>
  );
}
