import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { MODEL_OPTIONS, normalizeModelSlug } from "@t3tools/contracts";

import { MAX_CUSTOM_MODEL_LENGTH, useAppSettings } from "../appSettings";
import { isElectron } from "../env";
import { useTheme } from "../hooks/useTheme";
import { serverConfigQueryOptions } from "../lib/serverReactQuery";
import { ensureNativeApi } from "../nativeApi";
import { useStore } from "../store";
import { preferredTerminalEditor } from "../terminal-links";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
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

const RUNTIME_MODE_OPTIONS = [
  {
    value: "full-access",
    label: "Full access",
    description: "Allow commands to run without confirmation prompts.",
  },
  {
    value: "approval-required",
    label: "Supervised",
    description: "Require approval prompts before command execution.",
  },
] as const;

function SettingsRouteView() {
  const { theme, setTheme, resolvedTheme } = useTheme();
  const runtimeMode = useStore((state) => state.runtimeMode);
  const setRuntimeMode = useStore((state) => state.setRuntimeMode);
  const { settings, defaults, updateSettings } = useAppSettings();
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  const [isOpeningKeybindings, setIsOpeningKeybindings] = useState(false);
  const [openKeybindingsError, setOpenKeybindingsError] = useState<string | null>(null);
  const [customModelInput, setCustomModelInput] = useState("");
  const [customModelError, setCustomModelError] = useState<string | null>(null);

  const codexBinaryPath = settings.codexBinaryPath;
  const codexHomePath = settings.codexHomePath;
  const customCodexModels = settings.customCodexModels;
  const keybindingsConfigPath = serverConfigQuery.data?.keybindingsConfigPath ?? null;

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

  const addCustomModel = useCallback(() => {
    const normalized = normalizeModelSlug(customModelInput);
    if (!normalized) {
      setCustomModelError("Enter a model slug.");
      return;
    }
    if (MODEL_OPTIONS.some((option) => option.slug === normalized)) {
      setCustomModelError("That model is already built in.");
      return;
    }
    if (normalized.length > MAX_CUSTOM_MODEL_LENGTH) {
      setCustomModelError(`Model slugs must be ${MAX_CUSTOM_MODEL_LENGTH} characters or less.`);
      return;
    }
    if (customCodexModels.includes(normalized)) {
      setCustomModelError("That custom model is already saved.");
      return;
    }

    updateSettings({
      customCodexModels: [...customCodexModels, normalized],
    });
    setCustomModelInput("");
    setCustomModelError(null);
  }, [customCodexModels, customModelInput, updateSettings]);

  const removeCustomModel = useCallback(
    (slug: string) => {
      updateSettings({
        customCodexModels: customCodexModels.filter((model) => model !== slug),
      });
      setCustomModelError(null);
    },
    [customCodexModels, updateSettings],
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
                <h2 className="text-sm font-medium text-foreground">Codex App Server</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  These overrides apply to new sessions and let you use a non-default Codex install.
                </p>
              </div>

              <div className="space-y-4">
                <label htmlFor="codex-binary-path" className="block space-y-1">
                  <span className="text-xs font-medium text-foreground">Codex binary path</span>
                  <Input
                    id="codex-binary-path"
                    value={codexBinaryPath}
                    onChange={(event) => updateSettings({ codexBinaryPath: event.target.value })}
                    placeholder="codex"
                    spellCheck={false}
                  />
                  <span className="text-xs text-muted-foreground">
                    Leave blank to use <code>codex</code> from your PATH.
                  </span>
                </label>

                <label htmlFor="codex-home-path" className="block space-y-1">
                  <span className="text-xs font-medium text-foreground">CODEX_HOME path</span>
                  <Input
                    id="codex-home-path"
                    value={codexHomePath}
                    onChange={(event) => updateSettings({ codexHomePath: event.target.value })}
                    placeholder="/Users/you/.codex"
                    spellCheck={false}
                  />
                  <span className="text-xs text-muted-foreground">
                    Optional custom Codex home/config directory.
                  </span>
                </label>

                <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                  <p>
                    Binary source:{" "}
                    <span className="font-medium text-foreground">{codexBinaryPath || "PATH"}</span>
                  </p>
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() =>
                      updateSettings({
                        codexBinaryPath: defaults.codexBinaryPath,
                        codexHomePath: defaults.codexHomePath,
                      })
                    }
                  >
                    Reset codex overrides
                  </Button>
                </div>
              </div>
            </section>

            <section className="rounded-2xl border border-border bg-card p-5">
              <div className="mb-4">
                <h2 className="text-sm font-medium text-foreground">Models</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Save additional Codex model slugs so they appear in the chat model picker.
                </p>
              </div>

              <div className="space-y-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
                  <label htmlFor="custom-model-slug" className="block flex-1 space-y-1">
                    <span className="text-xs font-medium text-foreground">Custom model slug</span>
                    <Input
                      id="custom-model-slug"
                      value={customModelInput}
                      onChange={(event) => {
                        setCustomModelInput(event.target.value);
                        if (customModelError) {
                          setCustomModelError(null);
                        }
                      }}
                      onKeyDown={(event) => {
                        if (event.key !== "Enter") return;
                        event.preventDefault();
                        addCustomModel();
                      }}
                      placeholder="your-model-slug"
                      spellCheck={false}
                    />
                    <span className="text-xs text-muted-foreground">
                      Example: <code>gpt-6.7-codex-ultra-preview</code>
                    </span>
                  </label>

                  <Button className="sm:mt-6" type="button" onClick={addCustomModel}>
                    Add model
                  </Button>
                </div>

                {customModelError ? (
                  <p className="text-xs text-destructive">{customModelError}</p>
                ) : null}

                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                    <p>Saved custom models: {customCodexModels.length}</p>
                    {customCodexModels.length > 0 ? (
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={() =>
                          updateSettings({
                            customCodexModels: defaults.customCodexModels,
                          })
                        }
                      >
                        Reset custom models
                      </Button>
                    ) : null}
                  </div>

                  {customCodexModels.length > 0 ? (
                    <div className="space-y-2">
                      {customCodexModels.map((slug) => (
                        <div
                          key={slug}
                          className="flex items-center justify-between gap-3 rounded-lg border border-border bg-background px-3 py-2"
                        >
                          <code className="min-w-0 flex-1 truncate text-xs text-foreground">
                            {slug}
                          </code>
                          <Button
                            size="xs"
                            variant="ghost"
                            onClick={() => removeCustomModel(slug)}
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
            </section>

            <section className="rounded-2xl border border-border bg-card p-5">
              <div className="mb-4">
                <h2 className="text-sm font-medium text-foreground">Runtime Mode</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Select the default execution policy for this client.
                </p>
              </div>

              <div className="space-y-2" role="radiogroup" aria-label="Runtime mode preference">
                {RUNTIME_MODE_OPTIONS.map((option) => {
                  const selected = runtimeMode === option.value;
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
                      onClick={() => {
                        setRuntimeMode(option.value);
                      }}
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
