import {
  ArchiveIcon,
  ArchiveX,
  ChevronDownIcon,
  FolderIcon,
  PlusIcon,
  Undo2Icon,
  XIcon,
} from "lucide-react";
import { type ReactNode, useCallback, useMemo, useState } from "react";
import { type ProviderKind, DEFAULT_GIT_TEXT_GENERATION_MODEL, ThreadId } from "@t3tools/contracts";
import { getModelOptions, normalizeModelSlug } from "@t3tools/shared/model";

import {
  getAppModelOptions,
  getCustomModelsForProvider,
  MAX_CUSTOM_MODEL_LENGTH,
  MODEL_PROVIDER_SETTINGS,
  patchCustomModels,
  useAppSettings,
} from "../../appSettings";
import { APP_VERSION } from "../../branding";
import { useStore } from "../../store";
import { Button } from "../ui/button";
import { Collapsible, CollapsibleContent } from "../ui/collapsible";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { resolveAndPersistPreferredEditor } from "../../editorPreferences";
import { ensureNativeApi, readNativeApi } from "../../nativeApi";
import { useTheme } from "../../hooks/useTheme";
import { serverConfigQueryOptions } from "../../lib/serverReactQuery";
import { cn } from "../../lib/utils";
import { useQuery } from "@tanstack/react-query";
import { useThreadActions } from "../../hooks/useThreadActions";
import { toastManager } from "../ui/toast";

const THEME_OPTIONS = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
] as const;

const TIMESTAMP_FORMAT_LABELS = {
  locale: "System default",
  "12-hour": "12-hour",
  "24-hour": "24-hour",
} as const;

type InstallBinarySettingsKey = "claudeBinaryPath" | "codexBinaryPath";
type InstallProviderSettings = {
  provider: ProviderKind;
  title: string;
  binaryPathKey: InstallBinarySettingsKey;
  binaryPlaceholder: string;
  binaryDescription: ReactNode;
  homePathKey?: "codexHomePath";
  homePlaceholder?: string;
  homeDescription?: ReactNode;
};

const INSTALL_PROVIDER_SETTINGS: readonly InstallProviderSettings[] = [
  {
    provider: "codex",
    title: "Codex",
    binaryPathKey: "codexBinaryPath",
    binaryPlaceholder: "Codex binary path",
    binaryDescription: (
      <>
        Leave blank to use <code>codex</code> from your PATH.
      </>
    ),
    homePathKey: "codexHomePath",
    homePlaceholder: "CODEX_HOME",
    homeDescription: "Optional custom Codex home and config directory.",
  },
  {
    provider: "claudeAgent",
    title: "Claude",
    binaryPathKey: "claudeBinaryPath",
    binaryPlaceholder: "Claude binary path",
    binaryDescription: (
      <>
        Leave blank to use <code>claude</code> from your PATH.
      </>
    ),
  },
] as const;

const DEFAULT_CUSTOM_MODEL_PROVIDER = "codex" as const;
const EMPTY_CUSTOM_MODEL_INPUT_BY_PROVIDER = {
  codex: "",
  claudeAgent: "",
} satisfies Record<ProviderKind, string>;

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function SettingsSection({ children }: { children: ReactNode }) {
  return (
    <section>
      <div className="relative overflow-hidden rounded-2xl border bg-card text-card-foreground shadow-xs/5 not-dark:bg-clip-padding before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-2xl)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] dark:before:shadow-[0_-1px_--theme(--color-white/6%)]">
        {children}
      </div>
    </section>
  );
}

function SettingsRow({
  title,
  description,
  status,
  resetAction,
  control,
  children,
}: {
  title: string;
  description: string;
  status?: ReactNode;
  resetAction?: ReactNode;
  control?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="border-t border-border px-4 py-4 first:border-t-0 sm:px-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-h-5 items-center gap-1.5">
            <h3 className="text-sm font-medium text-foreground">{title}</h3>
            <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center">
              {resetAction}
            </span>
          </div>
          <p className="text-xs text-muted-foreground">{description}</p>
          {status ? <div className="pt-1 text-[11px] text-muted-foreground">{status}</div> : null}
        </div>
        {control ? (
          <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
            {control}
          </div>
        ) : null}
      </div>
      {children}
    </div>
  );
}

function SettingResetButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={`Reset ${label} to default`}
            className="size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground"
            onClick={(event) => {
              event.stopPropagation();
              onClick();
            }}
          >
            <Undo2Icon className="size-3" />
          </Button>
        }
      />
      <TooltipPopup side="top">Reset to default</TooltipPopup>
    </Tooltip>
  );
}

function SettingsPageContainer({ children }: { children: ReactNode }) {
  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">{children}</div>
    </div>
  );
}

export function useSettingsRestore(onRestored?: () => void) {
  const { theme, setTheme } = useTheme();
  const { settings, defaults, resetSettings } = useAppSettings();

  const isInstallSettingsDirty =
    settings.claudeBinaryPath !== defaults.claudeBinaryPath ||
    settings.codexBinaryPath !== defaults.codexBinaryPath ||
    settings.codexHomePath !== defaults.codexHomePath;
  const isGitTextGenerationModelDirty =
    (settings.textGenerationModel ?? DEFAULT_GIT_TEXT_GENERATION_MODEL) !==
    (defaults.textGenerationModel ?? DEFAULT_GIT_TEXT_GENERATION_MODEL);
  const changedSettingLabels = useMemo(
    () => [
      ...(theme !== "system" ? ["Theme"] : []),
      ...(settings.timestampFormat !== defaults.timestampFormat ? ["Time format"] : []),
      ...(settings.enableAssistantStreaming !== defaults.enableAssistantStreaming
        ? ["Assistant output"]
        : []),
      ...(settings.defaultThreadEnvMode !== defaults.defaultThreadEnvMode
        ? ["New thread mode"]
        : []),
      ...(settings.confirmThreadArchive !== defaults.confirmThreadArchive
        ? ["Archive confirmation"]
        : []),
      ...(settings.confirmThreadDelete !== defaults.confirmThreadDelete
        ? ["Delete confirmation"]
        : []),
      ...(isGitTextGenerationModelDirty ? ["Git writing model"] : []),
      ...(settings.customCodexModels.length > 0 || settings.customClaudeModels.length > 0
        ? ["Custom models"]
        : []),
      ...(isInstallSettingsDirty ? ["Provider installs"] : []),
    ],
    [
      defaults.confirmThreadArchive,
      defaults.confirmThreadDelete,
      defaults.defaultThreadEnvMode,
      defaults.enableAssistantStreaming,
      defaults.timestampFormat,
      isGitTextGenerationModelDirty,
      isInstallSettingsDirty,
      settings.confirmThreadArchive,
      settings.confirmThreadDelete,
      settings.customClaudeModels.length,
      settings.customCodexModels.length,
      settings.defaultThreadEnvMode,
      settings.enableAssistantStreaming,
      settings.timestampFormat,
      theme,
    ],
  );

  const restoreDefaults = useCallback(async () => {
    if (changedSettingLabels.length === 0) return;
    const api = readNativeApi();
    const confirmed = await (api ?? ensureNativeApi()).dialogs.confirm(
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
  return (
    <SettingsPageContainer>
      <GeneralPreferencesSection />
      <ModelSettingsSection />
      <AdvancedSettingsSection />
    </SettingsPageContainer>
  );
}

function GeneralPreferencesSection() {
  const { theme, setTheme } = useTheme();
  const { settings, defaults, updateSettings } = useAppSettings();

  return (
    <SettingsSection>
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
          settings.timestampFormat !== defaults.timestampFormat ? (
            <SettingResetButton
              label="time format"
              onClick={() => updateSettings({ timestampFormat: defaults.timestampFormat })}
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
        title="Assistant output"
        description="Show token-by-token output while a response is in progress."
        resetAction={
          settings.enableAssistantStreaming !== defaults.enableAssistantStreaming ? (
            <SettingResetButton
              label="assistant output"
              onClick={() =>
                updateSettings({
                  enableAssistantStreaming: defaults.enableAssistantStreaming,
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
          settings.defaultThreadEnvMode !== defaults.defaultThreadEnvMode ? (
            <SettingResetButton
              label="new threads"
              onClick={() =>
                updateSettings({
                  defaultThreadEnvMode: defaults.defaultThreadEnvMode,
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
          settings.confirmThreadArchive !== defaults.confirmThreadArchive ? (
            <SettingResetButton
              label="archive confirmation"
              onClick={() =>
                updateSettings({
                  confirmThreadArchive: defaults.confirmThreadArchive,
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
          settings.confirmThreadDelete !== defaults.confirmThreadDelete ? (
            <SettingResetButton
              label="delete confirmation"
              onClick={() =>
                updateSettings({
                  confirmThreadDelete: defaults.confirmThreadDelete,
                })
              }
            />
          ) : null
        }
        control={
          <Switch
            checked={settings.confirmThreadDelete}
            onCheckedChange={(checked) => updateSettings({ confirmThreadDelete: Boolean(checked) })}
            aria-label="Confirm thread deletion"
          />
        }
      />
    </SettingsSection>
  );
}

function ModelSettingsSection() {
  const { settings, defaults, updateSettings } = useAppSettings();
  const [selectedCustomModelProvider, setSelectedCustomModelProvider] = useState<ProviderKind>(
    DEFAULT_CUSTOM_MODEL_PROVIDER,
  );
  const [customModelInputByProvider, setCustomModelInputByProvider] = useState<
    Record<ProviderKind, string>
  >(EMPTY_CUSTOM_MODEL_INPUT_BY_PROVIDER);
  const [customModelErrorByProvider, setCustomModelErrorByProvider] = useState<
    Partial<Record<ProviderKind, string | null>>
  >({});
  const [showAllCustomModels, setShowAllCustomModels] = useState(false);

  const gitTextGenerationModelOptions = getAppModelOptions(
    "codex",
    settings.customCodexModels,
    settings.textGenerationModel,
  );
  const currentGitTextGenerationModel =
    settings.textGenerationModel ?? DEFAULT_GIT_TEXT_GENERATION_MODEL;
  const defaultGitTextGenerationModel =
    defaults.textGenerationModel ?? DEFAULT_GIT_TEXT_GENERATION_MODEL;
  const isGitTextGenerationModelDirty =
    currentGitTextGenerationModel !== defaultGitTextGenerationModel;
  const selectedGitTextGenerationModelLabel =
    gitTextGenerationModelOptions.find((option) => option.slug === currentGitTextGenerationModel)
      ?.name ?? currentGitTextGenerationModel;
  const selectedCustomModelProviderSettings = MODEL_PROVIDER_SETTINGS.find(
    (providerSettings) => providerSettings.provider === selectedCustomModelProvider,
  )!;
  const selectedCustomModelInput = customModelInputByProvider[selectedCustomModelProvider];
  const selectedCustomModelError = customModelErrorByProvider[selectedCustomModelProvider] ?? null;
  const totalCustomModels = settings.customCodexModels.length + settings.customClaudeModels.length;
  const savedCustomModelRows = MODEL_PROVIDER_SETTINGS.flatMap((providerSettings) =>
    getCustomModelsForProvider(settings, providerSettings.provider).map((slug) => ({
      key: `${providerSettings.provider}:${slug}`,
      provider: providerSettings.provider,
      providerTitle: providerSettings.title,
      slug,
    })),
  );
  const visibleCustomModelRows = showAllCustomModels
    ? savedCustomModelRows
    : savedCustomModelRows.slice(0, 5);

  const addCustomModel = useCallback(
    (provider: ProviderKind) => {
      const customModels = getCustomModelsForProvider(settings, provider);
      const normalized = normalizeModelSlug(customModelInputByProvider[provider], provider);
      if (!normalized) {
        setCustomModelErrorByProvider((existing) => ({
          ...existing,
          [provider]: "Enter a model slug.",
        }));
        return;
      }
      if (getModelOptions(provider).some((option) => option.slug === normalized)) {
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
      updateSettings(patchCustomModels(provider, [...customModels, normalized]));
      setCustomModelInputByProvider((existing) => ({
        ...existing,
        [provider]: "",
      }));
      setCustomModelErrorByProvider((existing) => ({
        ...existing,
        [provider]: null,
      }));
    },
    [customModelInputByProvider, settings, updateSettings],
  );

  const removeCustomModel = useCallback(
    (provider: ProviderKind, slug: string) => {
      updateSettings(
        patchCustomModels(
          provider,
          getCustomModelsForProvider(settings, provider).filter((model) => model !== slug),
        ),
      );
      setCustomModelErrorByProvider((existing) => ({
        ...existing,
        [provider]: null,
      }));
    },
    [settings, updateSettings],
  );

  return (
    <SettingsSection>
      <SettingsRow
        title="Git writing model"
        description="Used for generated commit messages, PR titles, and branch names."
        resetAction={
          isGitTextGenerationModelDirty ? (
            <SettingResetButton
              label="git writing model"
              onClick={() =>
                updateSettings({
                  textGenerationModel: defaults.textGenerationModel,
                })
              }
            />
          ) : null
        }
        control={
          <Select
            value={currentGitTextGenerationModel}
            onValueChange={(value) => {
              if (value) {
                updateSettings({ textGenerationModel: value });
              }
            }}
          >
            <SelectTrigger className="w-full sm:w-52" aria-label="Git text generation model">
              <SelectValue>{selectedGitTextGenerationModelLabel}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {gitTextGenerationModelOptions.map((option) => (
                <SelectItem hideIndicator key={option.slug} value={option.slug}>
                  {option.name}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />

      <SettingsRow
        title="Custom models"
        description="Add custom model slugs for supported providers."
        resetAction={
          totalCustomModels > 0 ? (
            <SettingResetButton
              label="custom models"
              onClick={() => {
                updateSettings({
                  customCodexModels: defaults.customCodexModels,
                  customClaudeModels: defaults.customClaudeModels,
                });
                setCustomModelErrorByProvider({});
                setShowAllCustomModels(false);
              }}
            />
          ) : null
        }
      >
        <div className="mt-4 border-t border-border pt-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Select
              value={selectedCustomModelProvider}
              onValueChange={(value) => {
                if (value === "codex" || value === "claudeAgent") {
                  setSelectedCustomModelProvider(value);
                }
              }}
            >
              <SelectTrigger
                size="sm"
                className="w-full sm:w-40"
                aria-label="Custom model provider"
              >
                <SelectValue>{selectedCustomModelProviderSettings.title}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="start" alignItemWithTrigger={false}>
                {MODEL_PROVIDER_SETTINGS.map((providerSettings) => (
                  <SelectItem
                    hideIndicator
                    className="min-h-7 text-sm"
                    key={providerSettings.provider}
                    value={providerSettings.provider}
                  >
                    {providerSettings.title}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <Input
              value={selectedCustomModelInput}
              onChange={(event) => {
                const value = event.target.value;
                setCustomModelInputByProvider((existing) => ({
                  ...existing,
                  [selectedCustomModelProvider]: value,
                }));
                if (selectedCustomModelError) {
                  setCustomModelErrorByProvider((existing) => ({
                    ...existing,
                    [selectedCustomModelProvider]: null,
                  }));
                }
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  addCustomModel(selectedCustomModelProvider);
                }
              }}
              placeholder={selectedCustomModelProviderSettings.example}
              spellCheck={false}
            />
            <Button
              className="shrink-0"
              variant="outline"
              onClick={() => addCustomModel(selectedCustomModelProvider)}
            >
              <PlusIcon className="size-3.5" />
              Add
            </Button>
          </div>

          {selectedCustomModelError ? (
            <p className="mt-2 text-xs text-destructive">{selectedCustomModelError}</p>
          ) : null}

          {totalCustomModels > 0 ? (
            <div className="mt-3">
              {visibleCustomModelRows.map((row) => (
                <div
                  key={row.key}
                  className="group grid grid-cols-[minmax(5rem,6rem)_minmax(0,1fr)_auto] items-center gap-3 border-t border-border/60 px-4 py-2 first:border-t-0"
                >
                  <span className="truncate text-xs text-muted-foreground">
                    {row.providerTitle}
                  </span>
                  <code className="min-w-0 truncate text-sm text-foreground">{row.slug}</code>
                  <button
                    type="button"
                    className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100 hover:opacity-100"
                    aria-label={`Remove ${row.slug}`}
                    onClick={() => removeCustomModel(row.provider, row.slug)}
                  >
                    <XIcon className="size-3.5 text-muted-foreground hover:text-foreground" />
                  </button>
                </div>
              ))}

              {savedCustomModelRows.length > 5 ? (
                <button
                  type="button"
                  className="mt-2 text-xs text-muted-foreground transition-colors hover:text-foreground"
                  onClick={() => setShowAllCustomModels((value) => !value)}
                >
                  {showAllCustomModels
                    ? "Show less"
                    : `Show more (${savedCustomModelRows.length - 5})`}
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      </SettingsRow>
    </SettingsSection>
  );
}

function AdvancedSettingsSection() {
  const { settings, defaults, updateSettings } = useAppSettings();
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  const keybindingsConfigPath = serverConfigQuery.data?.keybindingsConfigPath ?? null;
  const availableEditors = serverConfigQuery.data?.availableEditors;
  const [isOpeningKeybindings, setIsOpeningKeybindings] = useState(false);
  const [openKeybindingsError, setOpenKeybindingsError] = useState<string | null>(null);
  const [openInstallProviders, setOpenInstallProviders] = useState<Record<ProviderKind, boolean>>({
    codex: Boolean(settings.codexBinaryPath || settings.codexHomePath),
    claudeAgent: Boolean(settings.claudeBinaryPath),
  });

  const isInstallSettingsDirty =
    settings.claudeBinaryPath !== defaults.claudeBinaryPath ||
    settings.codexBinaryPath !== defaults.codexBinaryPath ||
    settings.codexHomePath !== defaults.codexHomePath;

  const openKeybindingsFile = useCallback(() => {
    if (!keybindingsConfigPath) return;
    setOpenKeybindingsError(null);
    setIsOpeningKeybindings(true);
    const api = ensureNativeApi();
    const editor = resolveAndPersistPreferredEditor(availableEditors ?? []);
    if (!editor) {
      setOpenKeybindingsError("No available editors found.");
      setIsOpeningKeybindings(false);
      return;
    }
    void api.shell
      .openInEditor(keybindingsConfigPath, editor)
      .catch((error) => {
        setOpenKeybindingsError(
          error instanceof Error ? error.message : "Unable to open keybindings file.",
        );
      })
      .finally(() => {
        setIsOpeningKeybindings(false);
      });
  }, [availableEditors, keybindingsConfigPath]);

  return (
    <SettingsSection>
      <SettingsRow
        title="Provider installs"
        description="Override the CLI used for new sessions."
        resetAction={
          isInstallSettingsDirty ? (
            <SettingResetButton
              label="provider installs"
              onClick={() => {
                updateSettings({
                  claudeBinaryPath: defaults.claudeBinaryPath,
                  codexBinaryPath: defaults.codexBinaryPath,
                  codexHomePath: defaults.codexHomePath,
                });
                setOpenInstallProviders({
                  codex: false,
                  claudeAgent: false,
                });
              }}
            />
          ) : null
        }
      >
        <div className="mt-4">
          <div className="space-y-2">
            {INSTALL_PROVIDER_SETTINGS.map((providerSettings) => {
              const isOpen = openInstallProviders[providerSettings.provider];
              const isDirty =
                providerSettings.provider === "codex"
                  ? settings.codexBinaryPath !== defaults.codexBinaryPath ||
                    settings.codexHomePath !== defaults.codexHomePath
                  : settings.claudeBinaryPath !== defaults.claudeBinaryPath;
              const binaryPathValue =
                providerSettings.binaryPathKey === "claudeBinaryPath"
                  ? settings.claudeBinaryPath
                  : settings.codexBinaryPath;

              return (
                <Collapsible
                  key={providerSettings.provider}
                  open={isOpen}
                  onOpenChange={(open) =>
                    setOpenInstallProviders((existing) => ({
                      ...existing,
                      [providerSettings.provider]: open,
                    }))
                  }
                >
                  <div className="overflow-hidden rounded-xl border border-border/70">
                    <button
                      type="button"
                      className="flex w-full items-center gap-3 px-4 py-3 text-left"
                      onClick={() =>
                        setOpenInstallProviders((existing) => ({
                          ...existing,
                          [providerSettings.provider]: !existing[providerSettings.provider],
                        }))
                      }
                    >
                      <span className="min-w-0 flex-1 text-sm font-medium text-foreground">
                        {providerSettings.title}
                      </span>
                      {isDirty ? (
                        <span className="text-[11px] text-muted-foreground">Custom</span>
                      ) : null}
                      <ChevronDownIcon
                        className={cn(
                          "size-4 shrink-0 text-muted-foreground transition-transform",
                          isOpen && "rotate-180",
                        )}
                      />
                    </button>

                    <CollapsibleContent>
                      <div className="border-t border-border/70 px-4 py-4">
                        <div className="space-y-3">
                          <label
                            htmlFor={`provider-install-${providerSettings.binaryPathKey}`}
                            className="block"
                          >
                            <span className="block text-xs font-medium text-foreground">
                              {providerSettings.title} binary path
                            </span>
                            <Input
                              id={`provider-install-${providerSettings.binaryPathKey}`}
                              className="mt-1"
                              value={binaryPathValue}
                              onChange={(event) =>
                                updateSettings(
                                  providerSettings.binaryPathKey === "claudeBinaryPath"
                                    ? { claudeBinaryPath: event.target.value }
                                    : { codexBinaryPath: event.target.value },
                                )
                              }
                              placeholder={providerSettings.binaryPlaceholder}
                              spellCheck={false}
                            />
                            <span className="mt-1 block text-xs text-muted-foreground">
                              {providerSettings.binaryDescription}
                            </span>
                          </label>

                          {providerSettings.homePathKey ? (
                            <label
                              htmlFor={`provider-install-${providerSettings.homePathKey}`}
                              className="block"
                            >
                              <span className="block text-xs font-medium text-foreground">
                                CODEX_HOME path
                              </span>
                              <Input
                                id={`provider-install-${providerSettings.homePathKey}`}
                                className="mt-1"
                                value={settings.codexHomePath}
                                onChange={(event) =>
                                  updateSettings({
                                    codexHomePath: event.target.value,
                                  })
                                }
                                placeholder={providerSettings.homePlaceholder}
                                spellCheck={false}
                              />
                              {providerSettings.homeDescription ? (
                                <span className="mt-1 block text-xs text-muted-foreground">
                                  {providerSettings.homeDescription}
                                </span>
                              ) : null}
                            </label>
                          ) : null}
                        </div>
                      </div>
                    </CollapsibleContent>
                  </div>
                </Collapsible>
              );
            })}
          </div>
        </div>
      </SettingsRow>

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

      <SettingsRow
        title="Version"
        description="Current application version."
        control={<code className="text-xs font-medium text-muted-foreground">{APP_VERSION}</code>}
      />
    </SettingsSection>
  );
}

export function ArchivedThreadsPanel() {
  const projects = useStore((store) => store.projects);
  const threads = useStore((store) => store.threads);
  const { unarchiveThread, confirmAndDeleteThread } = useThreadActions();
  const [hoveredThreadId, setHoveredThreadId] = useState<ThreadId | null>(null);

  const archivedGroups = useMemo(() => {
    const projectById = new Map(projects.map((project) => [project.id, project] as const));
    return [...projectById.values()]
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
    async (threadId: ThreadId, position: { x: number; y: number }) => {
      const api = readNativeApi();
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
          await unarchiveThread(threadId);
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
        await confirmAndDeleteThread(threadId);
      }
    },
    [confirmAndDeleteThread, unarchiveThread],
  );

  return (
    <SettingsPageContainer>
      <SettingsSection>
        {archivedGroups.length === 0 ? (
          <Empty className="min-h-[22rem]">
            <EmptyMedia variant="icon">
              <ArchiveIcon />
            </EmptyMedia>
            <EmptyHeader>
              <EmptyTitle>No archived threads</EmptyTitle>
              <EmptyDescription>Archived threads will appear here.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="divide-y divide-border">
            {archivedGroups.map(({ project, threads: projectThreads }) => (
              <section key={project.id} className="px-4 py-4 sm:px-5">
                <div className="mb-3 flex items-center gap-2">
                  <FolderIcon className="size-3.5 text-muted-foreground" />
                  <h3 className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">
                    {project.name}
                  </h3>
                </div>
                <div className="space-y-2">
                  {projectThreads.map((thread) => (
                    <div
                      key={thread.id}
                      className="flex w-full items-center justify-between gap-3 rounded-xl border border-border/70 px-3 py-3 text-left transition-colors hover:bg-accent"
                      onMouseEnter={() => setHoveredThreadId(thread.id)}
                      onMouseLeave={() =>
                        setHoveredThreadId((current) => (current === thread.id ? null : current))
                      }
                      onContextMenu={(event) => {
                        event.preventDefault();
                        setHoveredThreadId((current) => (current === thread.id ? null : current));
                        void handleArchivedThreadContextMenu(thread.id, {
                          x: event.clientX,
                          y: event.clientY,
                        });
                      }}
                    >
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium text-foreground">
                          {thread.title}
                        </div>
                        <div className="mt-1 text-xs text-muted-foreground">
                          Archived {formatRelativeTime(thread.archivedAt ?? thread.createdAt)}
                        </div>
                      </div>
                      <div className="flex min-w-20 shrink-0 justify-end pl-3">
                        {hoveredThreadId === thread.id ? (
                          <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            className="h-7 rounded-full px-2.5 gap-1.5 "
                            onClick={() =>
                              void unarchiveThread(thread.id).catch((error) => {
                                toastManager.add({
                                  type: "error",
                                  title: "Failed to unarchive thread",
                                  description:
                                    error instanceof Error ? error.message : "An error occurred.",
                                });
                              })
                            }
                          >
                            <ArchiveX size="3.5" />
                            <span>Unarchive</span>
                          </Button>
                        ) : (
                          <div className="text-[11px] text-muted-foreground/70">
                            {formatRelativeTime(thread.createdAt)}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
