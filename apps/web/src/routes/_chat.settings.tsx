import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { type ProviderKind, type ServerProviderStatus } from "@t3tools/contracts";
import { getModelOptions, normalizeModelSlug } from "@t3tools/shared/model";
import { ZapIcon } from "lucide-react";

import {
  APP_SERVICE_TIER_OPTIONS,
  MAX_CUSTOM_MODEL_LENGTH,
  shouldShowFastTierIcon,
  useAppSettings,
} from "../appSettings";
import { isElectron } from "../env";
import { useTheme } from "../hooks/useTheme";
import { getProviderAuthGuidance } from "../providerAuthGuidance";
import { serverConfigQueryOptions } from "../lib/serverReactQuery";
import { ensureNativeApi } from "../nativeApi";
import { preferredTerminalEditor } from "../terminal-links";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../components/ui/select";
import { Switch } from "../components/ui/switch";
import { SidebarInset } from "~/components/ui/sidebar";

const THEME_OPTIONS = [
  {
    value: "system",
    label: "System",
    description: "Match your OS appearance setting.",
  },
  {
    value: "light",
    label: "Light",
    description: "Always use the light theme.",
  },
  {
    value: "dark",
    label: "Dark",
    description: "Always use the dark theme.",
  },
] as const;

const MODEL_PROVIDER_SETTINGS: Array<{
  provider: ProviderKind;
  title: string;
  description: string;
  placeholder: string;
  example: string;
}> = [
  {
    provider: "claudeCode",
    title: "Claude Code",
    description: "Save additional Claude Code model slugs for the picker and `/model` command.",
    placeholder: "your-claude-model-slug",
    example: "anthropic/claude-sonnet-max",
  },
  {
    provider: "codex",
    title: "Codex",
    description: "Save additional Codex model slugs for the picker and `/model` command.",
    placeholder: "your-codex-model-slug",
    example: "gpt-6.7-codex-ultra-preview",
  },
] as const;

const PROVIDER_INSTALL_SETTINGS: Array<{
  provider: ProviderKind;
  title: string;
  description: string;
  binaryLabel: string;
  binaryPlaceholder: string;
  homeLabel: string;
  homePlaceholder: string;
  homeHint: string;
  resetLabel: string;
}> = [
  {
    provider: "claudeCode",
    title: "Claude Code",
    description: "These overrides apply to new Claude Code sessions and let you use a non-default CLI install.",
    binaryLabel: "Claude binary path",
    binaryPlaceholder: "claude",
    homeLabel: "CLAUDE_CONFIG_DIR path",
    homePlaceholder: "/Users/you/.claude",
    homeHint: "Optional custom Claude Code config directory.",
    resetLabel: "Reset Claude overrides",
  },
  {
    provider: "codex",
    title: "Codex",
    description: "These overrides apply to new Codex sessions and let you use a non-default Codex install.",
    binaryLabel: "Codex binary path",
    binaryPlaceholder: "codex",
    homeLabel: "CODEX_HOME path",
    homePlaceholder: "/Users/you/.codex",
    homeHint: "Optional custom Codex home/config directory.",
    resetLabel: "Reset Codex overrides",
  },
] as const;

function getProviderBinaryPath(settings: ReturnType<typeof useAppSettings>["settings"], provider: ProviderKind) {
  return provider === "claudeCode" ? settings.claudeBinaryPath : settings.codexBinaryPath;
}

function getProviderHomePath(settings: ReturnType<typeof useAppSettings>["settings"], provider: ProviderKind) {
  return provider === "claudeCode" ? settings.claudeHomePath : settings.codexHomePath;
}

function patchProviderOverrides(provider: ProviderKind, paths: { binaryPath: string; homePath: string }) {
  return provider === "claudeCode"
    ? { claudeBinaryPath: paths.binaryPath, claudeHomePath: paths.homePath }
    : { codexBinaryPath: paths.binaryPath, codexHomePath: paths.homePath };
}

function formatProviderAuthStatus(status: ServerProviderStatus): string {
  switch (status.authStatus) {
    case "authenticated":
      return "Authenticated";
    case "unauthenticated":
      return "Authentication required";
    default:
      return "Auth status unknown";
  }
}

function formatProviderStatus(status: ServerProviderStatus): string {
  switch (status.status) {
    case "ready":
      return "Ready";
    case "warning":
      return "Limited";
    default:
      return "Unavailable";
  }
}

function getProviderStatusClasses(status: ServerProviderStatus): string {
  switch (status.status) {
    case "ready":
      return "border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300";
    case "warning":
      return "border-amber-500/30 bg-amber-500/5 text-amber-700 dark:text-amber-300";
    default:
      return "border-destructive/30 bg-destructive/5 text-destructive";
  }
}

function getCustomModelsForProvider(
  settings: ReturnType<typeof useAppSettings>["settings"],
  provider: ProviderKind,
) {
  switch (provider) {
    case "claudeCode":
      return settings.customClaudeModels;
    case "codex":
    default:
      return settings.customCodexModels;
  }
}

function getDefaultCustomModelsForProvider(
  defaults: ReturnType<typeof useAppSettings>["defaults"],
  provider: ProviderKind,
) {
  switch (provider) {
    case "claudeCode":
      return defaults.customClaudeModels;
    case "codex":
    default:
      return defaults.customCodexModels;
  }
}

function patchCustomModels(provider: ProviderKind, models: string[]) {
  switch (provider) {
    case "claudeCode":
      return { customClaudeModels: models };
    case "codex":
    default:
      return { customCodexModels: models };
  }
}

function SettingsRouteView() {
  const { theme, setTheme, resolvedTheme } = useTheme();
  const { settings, defaults, updateSettings } = useAppSettings();
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  const [isOpeningKeybindings, setIsOpeningKeybindings] = useState(false);
  const [openKeybindingsError, setOpenKeybindingsError] = useState<string | null>(null);
  const [customModelInputByProvider, setCustomModelInputByProvider] = useState<
    Record<ProviderKind, string>
  >({
    codex: "",
    claudeCode: "",
  });
  const [customModelErrorByProvider, setCustomModelErrorByProvider] = useState<
    Partial<Record<ProviderKind, string | null>>
  >({});

  const codexServiceTier = settings.codexServiceTier;
  const keybindingsConfigPath = serverConfigQuery.data?.keybindingsConfigPath ?? null;
  const providerStatuses = serverConfigQuery.data?.providers ?? [];

  const openKeybindingsFile = useCallback(() => {
    if (!keybindingsConfigPath) return;
    setOpenKeybindingsError(null);
    setIsOpeningKeybindings(true);
    const api = ensureNativeApi();
    void api.shell
      .openInEditor(keybindingsConfigPath, preferredTerminalEditor())
      .catch((error) => {
        setOpenKeybindingsError(
          error instanceof Error ? error.message : "Unable to open keybindings file.",
        );
      })
      .finally(() => {
        setIsOpeningKeybindings(false);
      });
  }, [keybindingsConfigPath]);

  const addCustomModel = useCallback((provider: ProviderKind) => {
    const customModelInput = customModelInputByProvider[provider];
    const customModels = getCustomModelsForProvider(settings, provider);
    const normalized = normalizeModelSlug(customModelInput, provider);
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
  }, [customModelInputByProvider, settings, updateSettings]);

  const removeCustomModel = useCallback(
    (provider: ProviderKind, slug: string) => {
      const customModels = getCustomModelsForProvider(settings, provider);
      updateSettings(patchCustomModels(provider, customModels.filter((model) => model !== slug)));
      setCustomModelErrorByProvider((existing) => ({
        ...existing,
        [provider]: null,
      }));
    },
    [settings, updateSettings],
  );

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        {isElectron && (
          <div className="drag-region flex h-[52px] shrink-0 items-center border-b border-border px-5">
            <span className="text-xs font-medium tracking-wide text-muted-foreground/70">
              Settings
            </span>
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-6">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
            <header className="space-y-1">
              <h1 className="text-2xl font-semibold tracking-tight text-foreground">Settings</h1>
              <p className="text-sm text-muted-foreground">
                Configure app-level preferences for this device.
              </p>
            </header>

            <section className="rounded-2xl border border-border bg-card p-5">
              <div className="mb-4">
                <h2 className="text-sm font-medium text-foreground">Appearance</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Choose how T3 Code handles light and dark mode.
                </p>
              </div>

              <div className="space-y-2" role="radiogroup" aria-label="Theme preference">
                {THEME_OPTIONS.map((option) => {
                  const selected = theme === option.value;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      className={`flex w-full items-start justify-between rounded-lg border px-3 py-2 text-left transition-colors ${
                        selected
                          ? "border-primary/60 bg-primary/8 text-foreground"
                          : "border-border bg-background text-muted-foreground hover:bg-accent"
                      }`}
                      onClick={() => setTheme(option.value)}
                    >
                      <span className="flex flex-col">
                        <span className="text-sm font-medium">{option.label}</span>
                        <span className="text-xs">{option.description}</span>
                      </span>
                      {selected ? (
                        <span className="rounded bg-primary/14 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary">
                          Selected
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>

              <p className="mt-4 text-xs text-muted-foreground">
                Active theme: <span className="font-medium text-foreground">{resolvedTheme}</span>
              </p>
            </section>

            <section className="rounded-2xl border border-border bg-card p-5">
              <div className="mb-4">
                <h2 className="text-sm font-medium text-foreground">Provider status</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Current Claude Code and Codex availability reported by the desktop server.
                </p>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                {PROVIDER_INSTALL_SETTINGS.map((providerSettings) => {
                  const status = providerStatuses.find(
                    (entry) => entry.provider === providerSettings.provider,
                  );
                  const authGuidance = getProviderAuthGuidance(providerSettings.provider);
                  const binaryPath = getProviderBinaryPath(settings, providerSettings.provider);
                  return (
                    <div
                      key={`status:${providerSettings.provider}`}
                      className="rounded-xl border border-border bg-background/50 p-4"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <h3 className="text-sm font-medium text-foreground">{providerSettings.title}</h3>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {status?.message ?? "Waiting for provider health check."}
                          </p>
                        </div>
                        <span
                          className={`rounded-full border px-2 py-1 text-[11px] font-medium ${status ? getProviderStatusClasses(status) : "border-border bg-background text-muted-foreground"}`}
                        >
                          {status ? formatProviderStatus(status) : "Unknown"}
                        </span>
                      </div>
                      <div className="mt-3 space-y-1 text-xs text-muted-foreground">
                        <p>{status ? formatProviderAuthStatus(status) : "Auth status unknown"}</p>
                        {authGuidance ? <p>{authGuidance.summary}</p> : null}
                        <p>
                          Binary source:{" "}
                          <span className="font-medium text-foreground">{binaryPath || "PATH"}</span>
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>

            {PROVIDER_INSTALL_SETTINGS.map((providerSettings) => {
              const binaryPath = getProviderBinaryPath(settings, providerSettings.provider);
              const homePath = getProviderHomePath(settings, providerSettings.provider);
              const defaultBinaryPath = getProviderBinaryPath(defaults, providerSettings.provider);
              const defaultHomePath = getProviderHomePath(defaults, providerSettings.provider);
              const authGuidance = getProviderAuthGuidance(providerSettings.provider);

              return (
                <section
                  key={providerSettings.provider}
                  className="rounded-2xl border border-border bg-card p-5"
                >
                  <div className="mb-4">
                    <h2 className="text-sm font-medium text-foreground">{providerSettings.title} CLI</h2>
                    <p className="mt-1 text-xs text-muted-foreground">{providerSettings.description}</p>
                  </div>

                  <div className="space-y-4">
                    {authGuidance ? (
                      <div className="rounded-lg border border-dashed border-border bg-background px-3 py-3 text-xs text-muted-foreground">
                        <p className="font-medium text-foreground">Authentication</p>
                        <p className="mt-1">{authGuidance.detail}</p>
                      </div>
                    ) : null}

                    <label htmlFor={`${providerSettings.provider}-binary-path`} className="block space-y-1">
                      <span className="text-xs font-medium text-foreground">
                        {providerSettings.binaryLabel}
                      </span>
                      <Input
                        id={`${providerSettings.provider}-binary-path`}
                        value={binaryPath}
                        onChange={(event) =>
                          updateSettings(
                            patchProviderOverrides(providerSettings.provider, {
                              binaryPath: event.target.value,
                              homePath,
                            }),
                          )
                        }
                        placeholder={providerSettings.binaryPlaceholder}
                        spellCheck={false}
                      />
                      <span className="text-xs text-muted-foreground">
                        Leave blank to use <code>{providerSettings.binaryPlaceholder}</code> from your PATH.
                      </span>
                    </label>

                    <label htmlFor={`${providerSettings.provider}-home-path`} className="block space-y-1">
                      <span className="text-xs font-medium text-foreground">
                        {providerSettings.homeLabel}
                      </span>
                      <Input
                        id={`${providerSettings.provider}-home-path`}
                        value={homePath}
                        onChange={(event) =>
                          updateSettings(
                            patchProviderOverrides(providerSettings.provider, {
                              binaryPath,
                              homePath: event.target.value,
                            }),
                          )
                        }
                        placeholder={providerSettings.homePlaceholder}
                        spellCheck={false}
                      />
                      <span className="text-xs text-muted-foreground">{providerSettings.homeHint}</span>
                    </label>

                    <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                      <p>
                        Binary source:{" "}
                        <span className="font-medium text-foreground">{binaryPath || "PATH"}</span>
                      </p>
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={() =>
                          updateSettings(
                            patchProviderOverrides(providerSettings.provider, {
                              binaryPath: defaultBinaryPath,
                              homePath: defaultHomePath,
                            }),
                          )
                        }
                      >
                        {providerSettings.resetLabel}
                      </Button>
                    </div>
                  </div>
                </section>
              );
            })}

            <section className="rounded-2xl border border-border bg-card p-5">
              <div className="mb-4">
                <h2 className="text-sm font-medium text-foreground">Models</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Save additional provider model slugs so they appear in the chat model picker and
                  `/model` command suggestions.
                </p>
              </div>

              <div className="space-y-5">
                <label className="block space-y-1">
                  <span className="text-xs font-medium text-foreground">Default service tier</span>
                  <Select
                    items={APP_SERVICE_TIER_OPTIONS.map((option) => ({
                      label: option.label,
                      value: option.value,
                    }))}
                    value={codexServiceTier}
                    onValueChange={(value) => {
                      if (!value) return;
                      updateSettings({ codexServiceTier: value });
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectPopup alignItemWithTrigger={false}>
                      {APP_SERVICE_TIER_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          <div className="flex min-w-0 items-center gap-2">
                            {option.value === "fast" ? (
                              <ZapIcon className="size-3.5 text-amber-500" />
                            ) : (
                              <span className="size-3.5 shrink-0" aria-hidden="true" />
                            )}
                            <span className="truncate">{option.label}</span>
                          </div>
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                  <span className="text-xs text-muted-foreground">
                    {APP_SERVICE_TIER_OPTIONS.find((option) => option.value === codexServiceTier)
                      ?.description ?? "Use Codex defaults without forcing a service tier."}
                  </span>
                </label>

                {MODEL_PROVIDER_SETTINGS.map((providerSettings) => {
                  const provider = providerSettings.provider;
                  const customModels = getCustomModelsForProvider(settings, provider);
                  const customModelInput = customModelInputByProvider[provider];
                  const customModelError = customModelErrorByProvider[provider] ?? null;
                  return (
                    <div
                      key={provider}
                      className="rounded-xl border border-border bg-background/50 p-4"
                    >
                      <div className="mb-4">
                        <h3 className="text-sm font-medium text-foreground">
                          {providerSettings.title}
                        </h3>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {providerSettings.description}
                        </p>
                      </div>

                      <div className="space-y-4">
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
                          <label
                            htmlFor={`custom-model-slug-${provider}`}
                            className="block flex-1 space-y-1"
                          >
                            <span className="text-xs font-medium text-foreground">
                              Custom model slug
                            </span>
                            <Input
                              id={`custom-model-slug-${provider}`}
                              value={customModelInput}
                              onChange={(event) => {
                                const value = event.target.value;
                                setCustomModelInputByProvider((existing) => ({
                                  ...existing,
                                  [provider]: value,
                                }));
                                if (customModelError) {
                                  setCustomModelErrorByProvider((existing) => ({
                                    ...existing,
                                    [provider]: null,
                                  }));
                                }
                              }}
                              onKeyDown={(event) => {
                                if (event.key !== "Enter") return;
                                event.preventDefault();
                                addCustomModel(provider);
                              }}
                              placeholder={providerSettings.placeholder}
                              spellCheck={false}
                            />
                            <span className="text-xs text-muted-foreground">
                              Example: <code>{providerSettings.example}</code>
                            </span>
                          </label>

                          <Button
                            className="sm:mt-6"
                            type="button"
                            onClick={() => addCustomModel(provider)}
                          >
                            Add model
                          </Button>
                        </div>

                        {customModelError ? (
                          <p className="text-xs text-destructive">{customModelError}</p>
                        ) : null}

                        <div className="space-y-2">
                          <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                            <p>Saved custom models: {customModels.length}</p>
                            {customModels.length > 0 ? (
                              <Button
                                size="xs"
                                variant="outline"
                                onClick={() =>
                                  updateSettings(
                                    patchCustomModels(
                                      provider,
                                      [...getDefaultCustomModelsForProvider(defaults, provider)],
                                    ),
                                  )
                                }
                              >
                                Reset custom models
                              </Button>
                            ) : null}
                          </div>

                          {customModels.length > 0 ? (
                            <div className="space-y-2">
                              {customModels.map((slug) => (
                                <div
                                  key={`${provider}:${slug}`}
                                  className="flex items-center justify-between gap-3 rounded-lg border border-border bg-background px-3 py-2"
                                >
                                  <div className="flex min-w-0 flex-1 items-center gap-2">
                                    {provider === "codex" && shouldShowFastTierIcon(slug, codexServiceTier) ? (
                                      <ZapIcon className="size-3.5 shrink-0 text-amber-500" />
                                    ) : null}
                                    <code className="min-w-0 flex-1 truncate text-xs text-foreground">
                                      {slug}
                                    </code>
                                  </div>
                                  <Button
                                    size="xs"
                                    variant="ghost"
                                    onClick={() => removeCustomModel(provider, slug)}
                                  >
                                    Remove
                                  </Button>
                                </div>
                              ))}
                            </div>
                          ) : (
                            <div className="rounded-lg border border-dashed border-border bg-background px-3 py-4 text-xs text-muted-foreground">
                              No custom models saved yet.
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>

            <section className="rounded-2xl border border-border bg-card p-5">
              <div className="mb-4">
                <h2 className="text-sm font-medium text-foreground">Responses</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Control how assistant output is rendered during a turn.
                </p>
              </div>

              <div className="flex items-center justify-between rounded-lg border border-border bg-background px-3 py-2">
                <div>
                  <p className="text-sm font-medium text-foreground">Stream assistant messages</p>
                  <p className="text-xs text-muted-foreground">
                    Show token-by-token output while a response is in progress.
                  </p>
                </div>
                <Switch
                  checked={settings.enableAssistantStreaming}
                  onCheckedChange={(checked) =>
                    updateSettings({
                      enableAssistantStreaming: Boolean(checked),
                    })
                  }
                  aria-label="Stream assistant messages"
                />
              </div>

              {settings.enableAssistantStreaming !== defaults.enableAssistantStreaming ? (
                <div className="mt-3 flex justify-end">
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() =>
                      updateSettings({
                        enableAssistantStreaming: defaults.enableAssistantStreaming,
                      })
                    }
                  >
                    Restore default
                  </Button>
                </div>
              ) : null}
            </section>

            <section className="rounded-2xl border border-border bg-card p-5">
              <div className="mb-4">
                <h2 className="text-sm font-medium text-foreground">Keybindings</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Open the persisted <code>keybindings.json</code> file to edit advanced bindings
                  directly.
                </p>
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-background px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium text-foreground">Config file path</p>
                    <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">
                      {keybindingsConfigPath ?? "Resolving keybindings path..."}
                    </p>
                  </div>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={!keybindingsConfigPath || isOpeningKeybindings}
                    onClick={openKeybindingsFile}
                  >
                    {isOpeningKeybindings ? "Opening..." : "Open keybindings.json"}
                  </Button>
                </div>

                <p className="text-xs text-muted-foreground">
                  Opens in your preferred editor selection.
                </p>
                {openKeybindingsError ? (
                  <p className="text-xs text-destructive">{openKeybindingsError}</p>
                ) : null}
              </div>
            </section>

            <section className="rounded-2xl border border-border bg-card p-5">
              <div className="mb-4">
                <h2 className="text-sm font-medium text-foreground">Safety</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Additional guardrails for destructive local actions.
                </p>
              </div>

              <div className="flex items-center justify-between rounded-lg border border-border bg-background px-3 py-2">
                <div>
                  <p className="text-sm font-medium text-foreground">Confirm thread deletion</p>
                  <p className="text-xs text-muted-foreground">
                    Ask for confirmation before deleting a thread and its chat history.
                  </p>
                </div>
                <Switch
                  checked={settings.confirmThreadDelete}
                  onCheckedChange={(checked) =>
                    updateSettings({
                      confirmThreadDelete: Boolean(checked),
                    })
                  }
                  aria-label="Confirm thread deletion"
                />
              </div>

              {settings.confirmThreadDelete !== defaults.confirmThreadDelete ? (
                <div className="mt-3 flex justify-end">
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() =>
                      updateSettings({
                        confirmThreadDelete: defaults.confirmThreadDelete,
                      })
                    }
                  >
                    Restore default
                  </Button>
                </div>
              ) : null}
            </section>
          </div>
        </div>
      </div>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/settings")({
  component: SettingsRouteView,
});
