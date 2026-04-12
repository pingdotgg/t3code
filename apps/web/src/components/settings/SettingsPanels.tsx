import {
  ArchiveIcon,
  ArchiveX,
  ChevronDownIcon,
  InfoIcon,
  LoaderIcon,
  PlusIcon,
  RefreshCwIcon,
  XIcon,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useCallback, useMemo, useRef, useState } from "react";
import {
  type ModelSelection,
  type OllamaConnectionSettings,
  PROVIDER_DISPLAY_NAMES,
  type ScopedThreadRef,
  type ProviderKind,
  type ProviderModelOptions,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { normalizeModelSlug } from "@t3tools/shared/model";
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
  MAX_CUSTOM_MODEL_LENGTH,
  getCustomModelOptionsByProvider,
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
import { Button } from "../ui/button";
import { Collapsible, CollapsibleContent } from "../ui/collapsible";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
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

type InstallProviderSettings = {
  provider: ProviderKind;
  title: string;
  mode: "cli" | "connections";
  binaryPlaceholder?: string;
  binaryDescription?: ReactNode;
  homePathKey?: "codexHomePath";
  homePlaceholder?: string;
  homeDescription?: ReactNode;
};

const PROVIDER_SETTINGS: readonly InstallProviderSettings[] = [
  {
    provider: "codex",
    title: "Codex",
    mode: "cli",
    binaryPlaceholder: "Codex binary path",
    binaryDescription: "Path to the Codex binary",
    homePathKey: "codexHomePath",
    homePlaceholder: "CODEX_HOME",
    homeDescription: "Optional custom Codex home and config directory.",
  },
  {
    provider: "claudeAgent",
    title: "Claude",
    mode: "cli",
    binaryPlaceholder: "Claude binary path",
    binaryDescription: "Path to the Claude binary",
  },
  {
    provider: "ollama",
    title: "Ollama",
    mode: "connections",
  },
] as const;

function createProviderModelSelection(
  provider: ProviderKind,
  model: string,
  options?: ProviderModelOptions[ProviderKind],
): ModelSelection {
  switch (provider) {
    case "codex":
      return options !== undefined
        ? { provider, model, options: options as NonNullable<ProviderModelOptions["codex"]> }
        : { provider, model };
    case "claudeAgent":
      return options !== undefined
        ? {
            provider,
            model,
            options: options as NonNullable<ProviderModelOptions["claudeAgent"]>,
          }
        : { provider, model };
    case "ollama":
      return options !== undefined
        ? { provider, model, options: options as NonNullable<ProviderModelOptions["ollama"]> }
        : { provider, model };
  }
}

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

function normalizeOllamaConnections(
  connections: ReadonlyArray<OllamaConnectionSettings>,
): ReadonlyArray<OllamaConnectionSettings> {
  if (connections.length === 0) {
    return connections;
  }
  const hasDefault = connections.some((connection) => connection.isDefault);
  const defaultId = hasDefault
    ? connections.find((connection) => connection.isDefault)?.id
    : connections[0]?.id;
  return connections.map((connection) => ({
    ...connection,
    isDefault: connection.id === defaultId,
  }));
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
        provider.message ?? "This provider is installed but disabled for new sessions in T3 Code.",
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
    detail: provider.message ?? "Installed and ready, but authentication could not be verified.",
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

  const updateState = updateStateQuery.data ?? null;

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
          toastManager.add({
            type: "error",
            title: "Could not download update",
            description: error instanceof Error ? error.message : "Download failed.",
          });
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
          toastManager.add({
            type: "error",
            title: "Could not install update",
            description: error instanceof Error ? error.message : "Install failed.",
          });
        });
      return;
    }

    if (typeof bridge.checkForUpdate !== "function") return;
    void bridge
      .checkForUpdate()
      .then((result) => {
        setDesktopUpdateStateQueryData(queryClient, result.state);
        if (!result.checked) {
          toastManager.add({
            type: "error",
            title: "Could not check for updates",
            description:
              result.state.message ?? "Automatic updates are not available in this build.",
          });
        }
      })
      .catch((error: unknown) => {
        toastManager.add({
          type: "error",
          title: "Could not check for updates",
          description: error instanceof Error ? error.message : "Update check failed.",
        });
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
  const areProviderSettingsDirty = PROVIDER_SETTINGS.some((providerSettings) => {
    const currentSettings = settings.providers[providerSettings.provider];
    const defaultSettings = DEFAULT_UNIFIED_SETTINGS.providers[providerSettings.provider];
    return !Equal.equals(currentSettings, defaultSettings);
  });

  const changedSettingLabels = useMemo(
    () => [
      ...(theme !== "system" ? ["Theme"] : []),
      ...(settings.timestampFormat !== DEFAULT_UNIFIED_SETTINGS.timestampFormat
        ? ["Time format"]
        : []),
      ...(settings.diffWordWrap !== DEFAULT_UNIFIED_SETTINGS.diffWordWrap
        ? ["Diff line wrapping"]
        : []),
      ...(settings.enableAssistantStreaming !== DEFAULT_UNIFIED_SETTINGS.enableAssistantStreaming
        ? ["Assistant output"]
        : []),
      ...(settings.defaultThreadEnvMode !== DEFAULT_UNIFIED_SETTINGS.defaultThreadEnvMode
        ? ["New thread mode"]
        : []),
      ...(settings.confirmThreadArchive !== DEFAULT_UNIFIED_SETTINGS.confirmThreadArchive
        ? ["Archive confirmation"]
        : []),
      ...(settings.confirmThreadDelete !== DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete
        ? ["Delete confirmation"]
        : []),
      ...(isGitWritingModelDirty ? ["Git writing model"] : []),
      ...(areProviderSettingsDirty ? ["Providers"] : []),
    ],
    [
      areProviderSettingsDirty,
      isGitWritingModelDirty,
      settings.confirmThreadArchive,
      settings.confirmThreadDelete,
      settings.defaultThreadEnvMode,
      settings.diffWordWrap,
      settings.enableAssistantStreaming,
      settings.timestampFormat,
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
  const [openProviderDetails, setOpenProviderDetails] = useState<Record<ProviderKind, boolean>>({
    codex: Boolean(
      settings.providers.codex.binaryPath !== DEFAULT_UNIFIED_SETTINGS.providers.codex.binaryPath ||
      settings.providers.codex.homePath !== DEFAULT_UNIFIED_SETTINGS.providers.codex.homePath ||
      settings.providers.codex.customModels.length > 0,
    ),
    claudeAgent: Boolean(
      settings.providers.claudeAgent.binaryPath !==
        DEFAULT_UNIFIED_SETTINGS.providers.claudeAgent.binaryPath ||
      settings.providers.claudeAgent.customModels.length > 0,
    ),
    ollama: Boolean(
      settings.providers.ollama.connections.length !==
        DEFAULT_UNIFIED_SETTINGS.providers.ollama.connections.length ||
      !Equal.equals(
        settings.providers.ollama.connections,
        DEFAULT_UNIFIED_SETTINGS.providers.ollama.connections,
      ),
    ),
  });
  const [customModelInputByProvider, setCustomModelInputByProvider] = useState<
    Record<ProviderKind, string>
  >({
    codex: "",
    claudeAgent: "",
    ollama: "",
  });
  const [customModelErrorByProvider, setCustomModelErrorByProvider] = useState<
    Partial<Record<ProviderKind, string | null>>
  >({});
  const [isRefreshingProviders, setIsRefreshingProviders] = useState(false);
  const refreshingRef = useRef(false);
  const modelListRefs = useRef<Partial<Record<ProviderKind, HTMLDivElement | null>>>({});
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
  const codexHomePath = settings.providers.codex.homePath;
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
  const textGenProvider = textGenerationModelSelection.provider;
  const textGenModel = textGenerationModelSelection.model;
  const textGenModelOptions = textGenerationModelSelection.options;
  const gitModelOptionsByProvider = getCustomModelOptionsByProvider(
    settings,
    serverProviders,
    textGenProvider,
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

  const openKeybindingsError = openPathErrorByTarget.keybindings ?? null;
  const openDiagnosticsError = openPathErrorByTarget.logsDirectory ?? null;
  const isOpeningKeybindings = openingPathByTarget.keybindings;
  const isOpeningLogsDirectory = openingPathByTarget.logsDirectory;

  const addCustomModel = useCallback(
    (provider: ProviderKind) => {
      if (provider === "ollama") {
        return;
      }
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
      if (provider === "ollama") {
        return;
      }
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

  const updateOllamaConnections = useCallback(
    (
      updater: (
        current: ReadonlyArray<OllamaConnectionSettings>,
      ) => ReadonlyArray<OllamaConnectionSettings>,
    ) => {
      updateSettings({
        providers: {
          ...settings.providers,
          ollama: {
            ...settings.providers.ollama,
            connections: normalizeOllamaConnections(updater(settings.providers.ollama.connections)),
          },
        },
      });
    },
    [settings, updateSettings],
  );

  const addOllamaConnection = useCallback(() => {
    updateOllamaConnections((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        name: `Ollama ${current.length + 1}`,
        baseUrl: "http://127.0.0.1:11434",
        authMode: "none",
        apiKey: "",
        customModels: [],
        isDefault: current.length === 0,
      },
    ]);
  }, [updateOllamaConnections]);

  const providerCards = PROVIDER_SETTINGS.map((providerSettings) => {
    const liveProvider = serverProviders.find(
      (candidate) => candidate.provider === providerSettings.provider,
    );
    const providerConfig = settings.providers[providerSettings.provider];
    const defaultProviderConfig = DEFAULT_UNIFIED_SETTINGS.providers[providerSettings.provider];
    const statusKey = liveProvider?.status ?? (providerConfig.enabled ? "warning" : "disabled");
    const summary = getProviderSummary(liveProvider);
    const fallbackModelSlugs =
      providerSettings.provider === "ollama"
        ? settings.providers.ollama.connections.flatMap((connection) => connection.customModels)
        : settings.providers[providerSettings.provider].customModels;
    const models: ReadonlyArray<ServerProviderModel> =
      liveProvider?.models ??
      fallbackModelSlugs.map((slug: string) => ({
        slug,
        name: slug,
        isCustom: true,
        capabilities: null,
      }));

    return {
      provider: providerSettings.provider,
      title: providerSettings.title,
      mode: providerSettings.mode,
      binaryPlaceholder: providerSettings.binaryPlaceholder,
      binaryDescription: providerSettings.binaryDescription,
      homePathKey: providerSettings.homePathKey,
      homePlaceholder: providerSettings.homePlaceholder,
      homeDescription: providerSettings.homeDescription,
      binaryPathValue:
        providerSettings.mode === "cli" && "binaryPath" in providerConfig
          ? providerConfig.binaryPath
          : "",
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
                        textGenerationModelSelection: createProviderModelSelection(provider, model),
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
                        textGenerationModelSelection: createProviderModelSelection(
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
            PROVIDER_DISPLAY_NAMES[providerCard.provider] ?? providerCard.title;

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
                      {providerCard.versionLabel ? (
                        <code className="text-xs text-muted-foreground">
                          {providerCard.versionLabel}
                        </code>
                      ) : null}
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
                          "size-3.5 transition-transform",
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
                    {providerCard.mode === "cli" ? (
                      <>
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
                              if (caps?.supportsFastMode) capLabels.push("Fast mode");
                              if (caps?.supportsThinkingToggle) capLabels.push("Thinking");
                              if (
                                caps?.reasoningEffortLevels &&
                                caps.reasoningEffortLevels.length > 0
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
                                          <code className="block text-[11px] text-foreground">
                                            {model.slug}
                                          </code>
                                          {capLabels.length > 0 ? (
                                            <div className="flex flex-wrap gap-x-2 gap-y-0.5">
                                              {capLabels.map((label) => (
                                                <span
                                                  key={label}
                                                  className="text-[10px] text-muted-foreground"
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
                                      <span className="text-[10px] text-muted-foreground">
                                        custom
                                      </span>
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
                      </>
                    ) : (
                      <div className="border-t border-border/60 px-4 py-3 sm:px-5">
                        <div className="mb-3 flex items-center justify-between gap-2">
                          <div>
                            <div className="text-xs font-medium text-foreground">Connections</div>
                            <div className="mt-1 text-xs text-muted-foreground">
                              Configure one or more Ollama hosts and choose which one is the
                              default.
                            </div>
                          </div>
                          <Button size="sm" variant="outline" onClick={addOllamaConnection}>
                            <PlusIcon className="size-3.5" />
                            Add connection
                          </Button>
                        </div>
                        <div className="space-y-3">
                          {settings.providers.ollama.connections.map((connection) => {
                            const liveConnection = (
                              providerCard.liveProvider?.connections ?? []
                            ).find((candidate) => candidate.id === connection.id);
                            return (
                              <div
                                key={connection.id}
                                className="rounded-md border border-border/60 p-3"
                              >
                                <div className="flex items-center justify-between gap-2">
                                  <div className="min-w-0">
                                    <div className="text-xs font-medium text-foreground">
                                      {connection.name || "Unnamed connection"}
                                    </div>
                                    <div className="mt-1 text-[11px] text-muted-foreground">
                                      {liveConnection?.message ??
                                        liveConnection?.baseUrl ??
                                        connection.baseUrl}
                                    </div>
                                  </div>
                                  <div className="flex items-center gap-2">
                                    <Button
                                      size="xs"
                                      variant={connection.isDefault ? "default" : "outline"}
                                      onClick={() =>
                                        updateOllamaConnections((current) =>
                                          current.map((entry) => ({
                                            ...entry,
                                            isDefault: entry.id === connection.id,
                                          })),
                                        )
                                      }
                                    >
                                      {connection.isDefault ? "Default" : "Make default"}
                                    </Button>
                                    <Button
                                      size="xs"
                                      variant="ghost"
                                      disabled={settings.providers.ollama.connections.length <= 1}
                                      onClick={() =>
                                        updateOllamaConnections((current) =>
                                          current.filter((entry) => entry.id !== connection.id),
                                        )
                                      }
                                    >
                                      Delete
                                    </Button>
                                  </div>
                                </div>

                                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                                  <label className="block">
                                    <span className="text-xs font-medium text-foreground">
                                      Name
                                    </span>
                                    <Input
                                      className="mt-1.5"
                                      value={connection.name}
                                      onChange={(event) =>
                                        updateOllamaConnections((current) =>
                                          current.map((entry) =>
                                            entry.id === connection.id
                                              ? { ...entry, name: event.target.value }
                                              : entry,
                                          ),
                                        )
                                      }
                                    />
                                  </label>
                                  <label className="block">
                                    <span className="text-xs font-medium text-foreground">
                                      Base URL
                                    </span>
                                    <Input
                                      className="mt-1.5"
                                      value={connection.baseUrl}
                                      onChange={(event) =>
                                        updateOllamaConnections((current) =>
                                          current.map((entry) =>
                                            entry.id === connection.id
                                              ? { ...entry, baseUrl: event.target.value }
                                              : entry,
                                          ),
                                        )
                                      }
                                      spellCheck={false}
                                    />
                                  </label>
                                  <label className="block">
                                    <span className="text-xs font-medium text-foreground">
                                      Auth mode
                                    </span>
                                    <Select
                                      value={connection.authMode}
                                      onValueChange={(value) => {
                                        if (value !== "none" && value !== "bearer") return;
                                        updateOllamaConnections((current) =>
                                          current.map((entry) =>
                                            entry.id === connection.id
                                              ? { ...entry, authMode: value }
                                              : entry,
                                          ),
                                        );
                                      }}
                                    >
                                      <SelectTrigger className="mt-1.5">
                                        <SelectValue />
                                      </SelectTrigger>
                                      <SelectPopup align="end" alignItemWithTrigger={false}>
                                        <SelectItem hideIndicator value="none">
                                          None
                                        </SelectItem>
                                        <SelectItem hideIndicator value="bearer">
                                          Bearer token
                                        </SelectItem>
                                      </SelectPopup>
                                    </Select>
                                  </label>
                                  <label className="block">
                                    <span className="text-xs font-medium text-foreground">
                                      Request timeout (ms)
                                    </span>
                                    <Input
                                      className="mt-1.5"
                                      value={connection.requestTimeoutMs ?? ""}
                                      onChange={(event) =>
                                        updateOllamaConnections((current) =>
                                          current.map((entry) =>
                                            entry.id === connection.id
                                              ? {
                                                  ...entry,
                                                  requestTimeoutMs:
                                                    event.target.value.trim().length === 0
                                                      ? undefined
                                                      : Number(event.target.value),
                                                }
                                              : entry,
                                          ),
                                        )
                                      }
                                      spellCheck={false}
                                    />
                                  </label>
                                </div>

                                {connection.authMode === "bearer" ? (
                                  <label className="mt-3 block">
                                    <span className="text-xs font-medium text-foreground">
                                      API key
                                    </span>
                                    <Input
                                      className="mt-1.5"
                                      type="password"
                                      value={connection.apiKey}
                                      onChange={(event) =>
                                        updateOllamaConnections((current) =>
                                          current.map((entry) =>
                                            entry.id === connection.id
                                              ? { ...entry, apiKey: event.target.value }
                                              : entry,
                                          ),
                                        )
                                      }
                                      spellCheck={false}
                                    />
                                  </label>
                                ) : null}

                                <label className="mt-3 block">
                                  <span className="text-xs font-medium text-foreground">
                                    Custom models
                                  </span>
                                  <Input
                                    className="mt-1.5"
                                    value={connection.customModels.join(", ")}
                                    onChange={(event) =>
                                      updateOllamaConnections((current) =>
                                        current.map((entry) =>
                                          entry.id === connection.id
                                            ? {
                                                ...entry,
                                                customModels: event.target.value
                                                  .split(",")
                                                  .map((value) =>
                                                    normalizeModelSlug(value, "ollama"),
                                                  )
                                                  .filter((value): value is string =>
                                                    Boolean(value),
                                                  ),
                                              }
                                            : entry,
                                        ),
                                      )
                                    }
                                    placeholder="llama3.2, qwen3:14b"
                                    spellCheck={false}
                                  />
                                  <span className="mt-1 block text-xs text-muted-foreground">
                                    Comma-separated model slugs to expose even when the host does
                                    not advertise them yet.
                                  </span>
                                </label>

                                {liveConnection ? (
                                  <div className="mt-3 text-[11px] text-muted-foreground">
                                    Status: {liveConnection.status}
                                    {liveConnection.version ? ` · ${liveConnection.version}` : ""}
                                    {liveConnection.models.length > 0
                                      ? ` · ${liveConnection.models.length} model${liveConnection.models.length === 1 ? "" : "s"}`
                                      : ""}
                                  </div>
                                ) : null}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                </CollapsibleContent>
              </Collapsible>
            </div>
          );
        })}
      </SettingsSection>

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

export function ArchivedThreadsPanel() {
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
          toastManager.add({
            type: "error",
            title: "Failed to unarchive thread",
            description: error instanceof Error ? error.message : "An error occurred.",
          });
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
                        toastManager.add({
                          type: "error",
                          title: "Failed to unarchive thread",
                          description:
                            error instanceof Error ? error.message : "An error occurred.",
                        });
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
