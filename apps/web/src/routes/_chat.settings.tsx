import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import { EDITORS, type EditorId, type ProviderKind, type ServerCliInstallation } from "@t3tools/contracts";
import { useTokenUsageStore } from "../tokenUsageStore";
import { getModelOptions, normalizeModelSlug } from "@t3tools/shared/model";
import {
  BotIcon,
  CodeIcon,
  GitPullRequestIcon,
  KeyboardIcon,
  LayoutTemplateIcon,
  MessageSquareTextIcon,
  PaletteIcon,
  SearchIcon,
  ShieldCheckIcon,
  SquareStackIcon,
  ZapIcon,
} from "lucide-react";

import {
  APP_SERVICE_TIER_OPTIONS,
  CANVAS_DEFAULT_TAB_OPTIONS,
  CANVAS_PREVIEW_DEVICE_OPTIONS,
  GITHUB_AUTH_MODE_OPTIONS,
  MAX_CUSTOM_MODEL_LENGTH,
  shouldShowFastTierIcon,
  useAppSettings,
} from "../appSettings";
import { CursorIcon, OpenCodeIcon, VisualStudioCode, WindsurfIcon, Zed } from "../components/Icons";
import WorkspaceSurfaceActions from "../components/WorkspaceSurfaceActions";
import { isElectron } from "../env";
import { useWorkspaceSurfaceLaunchers } from "../hooks/useWorkspaceSurfaceLaunchers";
import { useTheme } from "../hooks/useTheme";
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
    provider: "codex",
    title: "Codex",
    description: "Save additional Codex model slugs for the picker and `/model` command.",
    placeholder: "your-codex-model-slug",
    example: "gpt-6.7-codex-ultra-preview",
  },
] as const;

function getCustomModelsForProvider(
  settings: ReturnType<typeof useAppSettings>["settings"],
  provider: ProviderKind,
) {
  switch (provider) {
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
    case "codex":
    default:
      return defaults.customCodexModels;
  }
}

function patchCustomModels(provider: ProviderKind, models: string[]) {
  switch (provider) {
    case "codex":
    default:
      return { customCodexModels: models };
  }
}

const SETTINGS_SECTIONS = [
  {
    id: "appearance",
    title: "Appearance",
    description: "Theme, look and feel",
    icon: PaletteIcon,
    keywords: ["theme", "appearance", "light", "dark", "system"],
  },
  {
    id: "editor",
    title: "Editor",
    description: "Preferred editor for opening projects",
    icon: CodeIcon,
    keywords: ["editor", "cursor", "vscode", "windsurf", "opencode", "zed", "ide"],
  },
  {
    id: "codex",
    title: "Codex App Server",
    description: "Binary and CODEX_HOME overrides",
    icon: BotIcon,
    keywords: ["codex", "binary", "home", "server", "path"],
  },
  {
    id: "canvas",
    title: "Canvas",
    description: "Generated app surface defaults",
    icon: LayoutTemplateIcon,
    keywords: ["canvas", "preview", "react", "app", "device"],
  },
  {
    id: "models",
    title: "Models",
    description: "Model slugs and service tier",
    icon: SquareStackIcon,
    keywords: ["models", "service tier", "codex", "slug"],
  },
  {
    id: "github",
    title: "GitHub",
    description: "Auth, PR, actions and security defaults",
    icon: GitPullRequestIcon,
    keywords: ["github", "token", "actions", "pull request", "security", "workflow"],
  },
  {
    id: "responses",
    title: "Responses",
    description: "Streaming behavior",
    icon: MessageSquareTextIcon,
    keywords: ["responses", "streaming", "assistant"],
  },
  {
    id: "keybindings",
    title: "Keybindings",
    description: "Open and edit keybindings.json",
    icon: KeyboardIcon,
    keywords: ["keybindings", "shortcuts", "editor"],
  },
  {
    id: "safety",
    title: "Safety",
    description: "Destructive action guardrails",
    icon: ShieldCheckIcon,
    keywords: ["safety", "delete", "confirm", "guardrails"],
  },
] as const;

type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]["id"];
const SETTINGS_TARGET_SECTION_STORAGE_KEY = "t3code:settings-target-section";

function readPendingSettingsSectionTarget(): SettingsSectionId | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(SETTINGS_TARGET_SECTION_STORAGE_KEY);
  if (raw !== null) {
    window.localStorage.removeItem(SETTINGS_TARGET_SECTION_STORAGE_KEY);
  }
  return SETTINGS_SECTIONS.some((section) => section.id === raw)
    ? (raw as SettingsSectionId)
    : null;
}

function matchesSettingsSection(query: string, section: (typeof SETTINGS_SECTIONS)[number]): boolean {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return true;
  }

  return [section.title, section.description, ...section.keywords].some((value) =>
    value.toLowerCase().includes(normalizedQuery),
  );
}

function GithubSettingToggle(props: {
  label: string;
  description: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between rounded-lg border border-border bg-background px-3 py-2">
      <div>
        <p className="text-sm font-medium text-foreground">{props.label}</p>
        <p className="text-xs text-muted-foreground">{props.description}</p>
      </div>
      <Switch
        checked={props.checked}
        onCheckedChange={(checked) => props.onCheckedChange(Boolean(checked))}
        aria-label={props.label}
      />
    </div>
  );
}

function CliBinaryControl(props: {
  title: string;
  pathValue: string;
  argsValue: string;
  onPathChange: (value: string) => void;
  onArgsChange: (value: string) => void;
  detectedPath: string | null;
  detectedVersion: string | null;
  isScanning: boolean;
  onScan: () => void;
}) {
  return (
    <div className="rounded-lg border border-border bg-background p-3">
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="text-sm font-medium text-foreground">{props.title}</p>
        <Button size="xs" variant="outline" onClick={props.onScan} disabled={props.isScanning}>
          {props.isScanning ? "Scanning..." : "Scan installation"}
        </Button>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <label className="block space-y-1">
          <span className="text-xs font-medium text-foreground">Binary path</span>
          <Input
            value={props.pathValue}
            onChange={(event) => props.onPathChange(event.target.value)}
            placeholder="auto from PATH"
            spellCheck={false}
          />
        </label>
        <label className="block space-y-1">
          <span className="text-xs font-medium text-foreground">Default args</span>
          <Input
            value={props.argsValue}
            onChange={(event) => props.onArgsChange(event.target.value)}
            placeholder="--no-color"
            spellCheck={false}
          />
        </label>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        {props.detectedPath
          ? `Detected: ${props.detectedPath}${props.detectedVersion ? ` (${props.detectedVersion})` : ""}`
          : "No detected installation yet. Use scan or provide path manually."}
      </p>
    </div>
  );
}

function GitHubDeviceFlowConnect(props: { onTokenReceived: (token: string) => void }) {
  const [status, setStatus] = useState<"idle" | "loading" | "code" | "polling" | "success" | "error">("idle");
  const [userCode, setUserCode] = useState("");
  const [verificationUri, setVerificationUri] = useState("");
  const [errorMessage, setErrorMessage] = useState("");

  const startFlow = useCallback(async () => {
    setStatus("loading");
    setErrorMessage("");
    try {
      const api = ensureNativeApi();
      const result = await api.github.startDeviceFlow();
      setUserCode(result.userCode);
      setVerificationUri(result.verificationUri);
      setStatus("code");

      // Open the verification page in the browser
      void api.shell.openExternal(result.verificationUri).catch(() => undefined);

      // Start polling in background
      setStatus("polling");
      const tokenResult = await api.github.pollDeviceFlow({
        deviceCode: result.deviceCode,
        interval: result.interval,
        expiresIn: result.expiresIn,
      });

      props.onTokenReceived(tokenResult.accessToken);
      setStatus("success");
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Authorization failed.");
      setStatus("error");
    }
  }, [props]);

  if (status === "idle" || status === "error") {
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Button size="xs" variant="outline" onClick={() => void startFlow()}>
            Connect GitHub account
          </Button>
          {status === "error" && (
            <span className="text-xs text-destructive">{errorMessage}</span>
          )}
        </div>
      </div>
    );
  }

  if (status === "loading") {
    return (
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">Requesting device code...</span>
      </div>
    );
  }

  if (status === "success") {
    return (
      <div className="flex items-center gap-2">
        <span className="text-xs text-green-600 dark:text-green-400">
          GitHub connected successfully! Token saved.
        </span>
        <Button size="xs" variant="outline" onClick={() => setStatus("idle")}>
          Reconnect
        </Button>
      </div>
    );
  }

  // status === "code" || status === "polling"
  return (
    <div className="rounded-lg border border-border bg-background p-3 space-y-3">
      <p className="text-xs text-muted-foreground">
        A browser tab has been opened. Enter this code on GitHub:
      </p>
      <div className="flex items-center gap-3">
        <code className="rounded bg-muted px-3 py-1.5 text-lg font-bold tracking-widest text-foreground select-all">
          {userCode}
        </code>
        <Button
          size="xs"
          variant="outline"
          onClick={() => {
            void navigator.clipboard.writeText(userCode);
          }}
        >
          Copy
        </Button>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">
          {status === "polling" ? "Waiting for authorization..." : "Enter the code above on GitHub."}
        </span>
        <Button
          size="xs"
          variant="outline"
          onClick={() => {
            const api = ensureNativeApi();
            void api.shell.openExternal(verificationUri).catch(() => undefined);
          }}
        >
          Open GitHub
        </Button>
      </div>
      <p className="text-[10px] text-muted-foreground">
        Code expires in 15 minutes. Never share this code — it is a common phishing target.
      </p>
    </div>
  );
}

function SettingsRouteView() {
  const { theme, setTheme, resolvedTheme } = useTheme();
  const { settings, defaults, updateSettings } = useAppSettings();
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  const { codexStatus, openCanvas, openLab, openTerminal } = useWorkspaceSurfaceLaunchers();
  const [settingsSearch, setSettingsSearch] = useState("");
  const [activeSectionId, setActiveSectionId] = useState<SettingsSectionId>(
    () => readPendingSettingsSectionTarget() ?? "appearance",
  );
  const [isOpeningKeybindings, setIsOpeningKeybindings] = useState(false);
  const [openKeybindingsError, setOpenKeybindingsError] = useState<string | null>(null);
  const [customModelInputByProvider, setCustomModelInputByProvider] = useState<
    Record<ProviderKind, string>
  >({
    codex: "",
    "claude-code": "",
    "gemini-cli": "",
    "github-copilot-cli": "",
  });
  const [customModelErrorByProvider, setCustomModelErrorByProvider] = useState<
    Partial<Record<ProviderKind, string | null>>
  >({});
  const [isScanningCliInstallations, setIsScanningCliInstallations] = useState(false);
  const [cliInstallationsById, setCliInstallationsById] = useState<
    Partial<Record<ServerCliInstallation["id"], ServerCliInstallation>>
  >({});

  const LAST_EDITOR_KEY = "t3code:last-editor";
  const availableEditors: ReadonlyArray<EditorId> = serverConfigQuery.data?.availableEditors ?? [];
  const [preferredEditor, setPreferredEditor] = useState<EditorId>(() => {
    const stored = localStorage.getItem(LAST_EDITOR_KEY);
    return EDITORS.some((e) => e.id === stored) ? (stored as EditorId) : EDITORS[0].id;
  });
  const handleEditorChange = useCallback((editorId: EditorId) => {
    setPreferredEditor(editorId);
    localStorage.setItem(LAST_EDITOR_KEY, editorId);
  }, []);

  const EDITOR_UI_OPTIONS: Array<{ id: EditorId; label: string; icon: React.FC<React.SVGProps<SVGSVGElement>> }> = [
    { id: "cursor", label: "Cursor", icon: CursorIcon },
    { id: "vscode", label: "VS Code", icon: VisualStudioCode },
    { id: "windsurf", label: "Windsurf", icon: WindsurfIcon },
    { id: "opencode", label: "OpenCode", icon: OpenCodeIcon },
    { id: "zed", label: "Zed", icon: Zed },
  ];

  const codexBinaryPath = settings.codexBinaryPath;
  const codexHomePath = settings.codexHomePath;
  const codexServiceTier = settings.codexServiceTier;
  const githubSettingsChanged =
    settings.githubEnabled !== defaults.githubEnabled ||
    settings.githubAuthMode !== defaults.githubAuthMode ||
    settings.githubToken !== defaults.githubToken ||
    settings.githubOwner !== defaults.githubOwner ||
    settings.githubRepo !== defaults.githubRepo ||
    settings.githubDefaultBaseBranch !== defaults.githubDefaultBaseBranch ||
    settings.githubWorkflowNameFilter !== defaults.githubWorkflowNameFilter ||
    settings.githubDefaultLabels !== defaults.githubDefaultLabels ||
    settings.githubAutoLinkIssues !== defaults.githubAutoLinkIssues ||
    settings.githubAutoReviewOnPr !== defaults.githubAutoReviewOnPr ||
    settings.githubActionsAutoRerunFailed !== defaults.githubActionsAutoRerunFailed ||
    settings.githubSecurityScanOnPush !== defaults.githubSecurityScanOnPush ||
    settings.githubRequirePassingChecks !== defaults.githubRequirePassingChecks ||
    settings.githubCreateDraftPrByDefault !== defaults.githubCreateDraftPrByDefault ||
    settings.githubSidebarControllerEnabled !== defaults.githubSidebarControllerEnabled ||
    settings.githubCliPath !== defaults.githubCliPath ||
    settings.githubCliArgs !== defaults.githubCliArgs ||
    settings.claudeCliPath !== defaults.claudeCliPath ||
    settings.claudeCliArgs !== defaults.claudeCliArgs ||
    settings.geminiCliPath !== defaults.geminiCliPath ||
    settings.geminiCliArgs !== defaults.geminiCliArgs;
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

  const scanCliInstallations = useCallback(async () => {
    const api = ensureNativeApi();
    setIsScanningCliInstallations(true);
    try {
      const installations = await api.server.detectCliInstallations();
      const byId: Partial<Record<ServerCliInstallation["id"], ServerCliInstallation>> = {};
      for (const installation of installations) {
        byId[installation.id] = installation;
      }
      setCliInstallationsById(byId);
      const github = byId["github-cli"];
      const claude = byId["claude-cli"];
      const gemini = byId["gemini-cli"];
      updateSettings({
        ...(github?.path ? { githubCliPath: github.path } : {}),
        ...(claude?.path ? { claudeCliPath: claude.path } : {}),
        ...(gemini?.path ? { geminiCliPath: gemini.path } : {}),
      });
    } finally {
      setIsScanningCliInstallations(false);
    }
  }, [updateSettings]);

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

  const visibleSections = useMemo(
    () => SETTINGS_SECTIONS.filter((section) => matchesSettingsSection(settingsSearch, section)),
    [settingsSearch],
  );

  useEffect(() => {
    if (visibleSections.length === 0) {
      return;
    }
    if (!visibleSections.some((section) => section.id === activeSectionId)) {
      setActiveSectionId(visibleSections[0]!.id);
    }
  }, [activeSectionId, visibleSections]);

  const activeSection = useMemo(
    () =>
      visibleSections.find((section) => section.id === activeSectionId) ??
      visibleSections[0] ??
      SETTINGS_SECTIONS[0],
    [activeSectionId, visibleSections],
  );

  const jumpToSection = useCallback((sectionId: SettingsSectionId) => {
    setActiveSectionId(sectionId);
  }, []);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        {isElectron && (
          <div className="drag-region grid h-[60px] shrink-0 grid-cols-[minmax(0,1fr)_minmax(18rem,32rem)_minmax(0,1fr)] items-center gap-4 border-b border-border px-5">
            <span className="min-w-0 shrink-0 text-xs font-medium tracking-wide text-muted-foreground/70">
              Settings
            </span>
            <div className="no-drag-region relative col-start-2 w-full">
              <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground/60" />
              <Input
                value={settingsSearch}
                onChange={(event) => setSettingsSearch(event.target.value)}
                placeholder="Search settings"
                className="h-10 border-border/80 bg-card/70 pl-9"
              />
            </div>
            <WorkspaceSurfaceActions
              codexStatus={codexStatus}
              className="no-drag-region justify-self-end"
              onToggleTerminal={() => {
                void openTerminal();
              }}
              onOpenLab={() => {
                void openLab();
              }}
              onToggleCanvas={() => {
                void openCanvas();
              }}
            />
          </div>
        )}

        <div className="flex min-h-0 flex-1 overflow-hidden">
          <aside className="hidden w-[260px] shrink-0 border-r border-border/70 bg-card/30 lg:block">
            <div className="border-b border-border/70 px-4 py-3">
              <div className="text-xs font-semibold tracking-[0.18em] text-muted-foreground uppercase">
                Settings Tabs
              </div>
              <div className="mt-1 text-sm text-muted-foreground/75">
                Navigate settings like an editor panel.
              </div>
            </div>
            <div className="flex flex-col gap-1 p-3">
              {visibleSections.map((section) => (
                <button
                  key={section.id}
                  type="button"
                  onClick={() => jumpToSection(section.id)}
                  className={`flex items-start gap-3 rounded-xl px-3 py-2 text-left transition ${
                    activeSectionId === section.id
                      ? "bg-accent text-foreground"
                      : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
                  }`}
                >
                  <section.icon className="mt-0.5 size-4 shrink-0" />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">{section.title}</span>
                    <span className="block text-xs text-muted-foreground/80">
                      {section.description}
                    </span>
                  </span>
                </button>
              ))}
              {visibleSections.length === 0 ? (
                <div className="rounded-xl border border-dashed border-border/70 px-3 py-4 text-xs text-muted-foreground/70">
                  No matching settings.
                </div>
              ) : null}
            </div>
          </aside>

          <div className="flex-1 overflow-y-auto p-6">
            <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
              <header className="space-y-3">
                <div className="space-y-1">
                  <h1 className="text-2xl font-semibold tracking-tight text-foreground">Settings</h1>
                  <p className="text-sm text-muted-foreground">
                    Configure app-level preferences for this device.
                  </p>
                </div>
                <div className="lg:hidden">
                  <div className="flex flex-wrap gap-2">
                    {visibleSections.map((section) => (
                      <button
                        key={section.id}
                        type="button"
                        onClick={() => jumpToSection(section.id)}
                        className={`rounded-full border px-3 py-1.5 text-xs font-medium transition ${
                          activeSection.id === section.id
                            ? "border-border bg-accent text-foreground"
                            : "border-border/70 text-muted-foreground hover:bg-accent/60 hover:text-foreground"
                        }`}
                      >
                        {section.title}
                      </button>
                    ))}
                  </div>
                </div>
                {!isElectron ? (
                  <div className="relative w-full max-w-md">
                    <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground/60" />
                    <Input
                      value={settingsSearch}
                      onChange={(event) => setSettingsSearch(event.target.value)}
                      placeholder="Search settings"
                      className="h-10 border-border/80 bg-card/70 pl-9"
                    />
                  </div>
                ) : null}
              </header>

              <div key={activeSection.id} className="settings-tab-panel">
            {activeSection.id === "appearance" ? (
            <section
              id="settings-appearance"
              className="rounded-2xl border border-border bg-card p-5"
            >
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
            ) : null}

            {activeSection.id === "editor" ? (
            <section
              id="settings-editor"
              className="rounded-2xl border border-border bg-card p-5"
            >
              <div className="mb-4">
                <h2 className="text-sm font-medium text-foreground">Editor</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Choose your preferred editor for opening projects. This selection is used by the
                  &quot;Open in&quot; button in the project header and terminal file links.
                </p>
              </div>

              <div className="space-y-2" role="radiogroup" aria-label="Editor preference">
                {EDITOR_UI_OPTIONS.map((option) => {
                  const selected = preferredEditor === option.id;
                  const installed = availableEditors.includes(option.id);
                  const EditorIcon = option.icon;
                  return (
                    <button
                      key={option.id}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      disabled={!installed}
                      className={`flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors ${
                        selected
                          ? "border-primary/60 bg-primary/8 text-foreground"
                          : installed
                            ? "border-border bg-background text-muted-foreground hover:bg-accent"
                            : "cursor-not-allowed border-border bg-background text-muted-foreground/40 opacity-50"
                      }`}
                      onClick={() => installed && handleEditorChange(option.id)}
                    >
                      <EditorIcon aria-hidden="true" className="size-5 shrink-0" />
                      <span className="flex flex-1 flex-col">
                        <span className="text-sm font-medium">{option.label}</span>
                        {!installed && (
                          <span className="text-[11px]">Not detected on PATH</span>
                        )}
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
                Editors are auto-detected from your system PATH. Install an editor&apos;s CLI command to enable it.
              </p>
            </section>
            ) : null}

            {activeSection.id === "codex" ? (
            <section
              id="settings-codex"
              className="rounded-2xl border border-border bg-card p-5"
            >
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
            ) : null}

            {activeSection.id === "canvas" ? (
            <section
              id="settings-canvas"
              className="rounded-2xl border border-border bg-card p-5"
            >
              <div className="mb-4">
                <h2 className="text-sm font-medium text-foreground">Canvas</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Control how the in-app app canvas opens and previews generated React work.
                </p>
              </div>

              <div className="space-y-5">
                <label className="block space-y-1">
                  <span className="text-xs font-medium text-foreground">Default canvas tab</span>
                  <Select
                    items={CANVAS_DEFAULT_TAB_OPTIONS.map((option) => ({
                      label: option.label,
                      value: option.value,
                    }))}
                    value={settings.canvasDefaultTab}
                    onValueChange={(value) => {
                      if (!value) return;
                      updateSettings({ canvasDefaultTab: value });
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectPopup alignItemWithTrigger={false}>
                      {CANVAS_DEFAULT_TAB_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </label>

                <label className="block space-y-1">
                  <span className="text-xs font-medium text-foreground">Preview device</span>
                  <Select
                    items={CANVAS_PREVIEW_DEVICE_OPTIONS.map((option) => ({
                      label: option.label,
                      value: option.value,
                    }))}
                    value={settings.canvasPreviewDevice}
                    onValueChange={(value) => {
                      if (!value) return;
                      updateSettings({ canvasPreviewDevice: value });
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectPopup alignItemWithTrigger={false}>
                      {CANVAS_PREVIEW_DEVICE_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </label>

                <div className="flex items-center justify-between rounded-lg border border-border bg-background px-3 py-2">
                  <div>
                    <p className="text-sm font-medium text-foreground">Auto-open canvas on update</p>
                    <p className="text-xs text-muted-foreground">
                      When the agent updates the canvas state, keep the canvas surface ready in chat.
                    </p>
                  </div>
                  <Switch
                    checked={settings.canvasAutoOpenOnUpdate}
                    onCheckedChange={(checked) =>
                      updateSettings({
                        canvasAutoOpenOnUpdate: Boolean(checked),
                      })
                    }
                    aria-label="Auto-open canvas on update"
                  />
                </div>
              </div>
            </section>
            ) : null}
            {activeSection.id === "models" ? (
            <section
              id="settings-models"
              className="rounded-2xl border border-border bg-card p-5"
            >
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
            ) : null}

            {activeSection.id === "github" ? (
            <section
              id="settings-github"
              className="rounded-2xl border border-border bg-card p-5"
            >
              <div className="mb-4">
                <h2 className="text-sm font-medium text-foreground">GitHub Integration</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Configure account connection, repository defaults, PR behavior, actions, and security checks.
                </p>
              </div>

              <div className="space-y-5">
                <div className="flex items-center justify-between rounded-lg border border-border bg-background px-3 py-2">
                  <div>
                    <p className="text-sm font-medium text-foreground">Enable GitHub integration</p>
                    <p className="text-xs text-muted-foreground">Turns on GitHub controls in chat and sidebar.</p>
                  </div>
                  <Switch
                    checked={settings.githubEnabled}
                    onCheckedChange={(checked) => updateSettings({ githubEnabled: Boolean(checked) })}
                    aria-label="Enable GitHub integration"
                  />
                </div>

                <label className="block space-y-1">
                  <span className="text-xs font-medium text-foreground">Authentication mode</span>
                  <Select
                    items={GITHUB_AUTH_MODE_OPTIONS.map((option) => ({
                      label: option.label,
                      value: option.value,
                    }))}
                    value={settings.githubAuthMode}
                    onValueChange={(value) => {
                      if (!value) return;
                      updateSettings({ githubAuthMode: value });
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectPopup alignItemWithTrigger={false}>
                      {GITHUB_AUTH_MODE_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </label>

                <label className="block space-y-1">
                  <span className="text-xs font-medium text-foreground">GitHub token</span>
                  <Input
                    type="password"
                    value={settings.githubToken}
                    onChange={(event) => updateSettings({ githubToken: event.target.value })}
                    placeholder="ghp_xxx..."
                    spellCheck={false}
                  />
                </label>

                <GitHubDeviceFlowConnect
                  onTokenReceived={(token) => {
                    updateSettings({ githubToken: token });
                  }}
                />
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => {
                      void scanCliInstallations();
                    }}
                    disabled={isScanningCliInstallations}
                  >
                    {isScanningCliInstallations ? "Checking..." : "Verify GitHub connection"}
                  </Button>
                  <span className="text-xs text-muted-foreground">
                    {(() => {
                      const githubCli = cliInstallationsById["github-cli"];
                      if (!githubCli) return "Not checked yet.";
                      if (!githubCli.found) return "GitHub CLI not found.";
                      if (githubCli.authenticated === false) return "GitHub CLI found but not authenticated.";
                      if (githubCli.authenticated === true) return "GitHub CLI authenticated.";
                      return "GitHub CLI found.";
                    })()}
                  </span>
                </div>

                <div className="grid gap-4 md:grid-cols-2">
                  <label className="block space-y-1">
                    <span className="text-xs font-medium text-foreground">Repository owner</span>
                    <Input
                      value={settings.githubOwner}
                      onChange={(event) => updateSettings({ githubOwner: event.target.value })}
                      placeholder="your-org"
                      spellCheck={false}
                    />
                  </label>
                  <label className="block space-y-1">
                    <span className="text-xs font-medium text-foreground">Repository name</span>
                    <Input
                      value={settings.githubRepo}
                      onChange={(event) => updateSettings({ githubRepo: event.target.value })}
                      placeholder="your-repo"
                      spellCheck={false}
                    />
                  </label>
                </div>

                <div className="grid gap-4 md:grid-cols-2">
                  <label className="block space-y-1">
                    <span className="text-xs font-medium text-foreground">Default base branch</span>
                    <Input
                      value={settings.githubDefaultBaseBranch}
                      onChange={(event) =>
                        updateSettings({ githubDefaultBaseBranch: event.target.value })
                      }
                      placeholder="main"
                      spellCheck={false}
                    />
                  </label>
                  <label className="block space-y-1">
                    <span className="text-xs font-medium text-foreground">Workflow name filter</span>
                    <Input
                      value={settings.githubWorkflowNameFilter}
                      onChange={(event) =>
                        updateSettings({ githubWorkflowNameFilter: event.target.value })
                      }
                      placeholder="ci | build | deploy"
                      spellCheck={false}
                    />
                  </label>
                </div>

                <label className="block space-y-1">
                  <span className="text-xs font-medium text-foreground">Default PR labels</span>
                  <Input
                    value={settings.githubDefaultLabels}
                    onChange={(event) => updateSettings({ githubDefaultLabels: event.target.value })}
                    placeholder="ai-generated, needs-review"
                    spellCheck={false}
                  />
                  <span className="text-xs text-muted-foreground">Comma-separated labels.</span>
                </label>

                <div className="grid gap-2 md:grid-cols-2">
                  <GithubSettingToggle
                    label="Auto-link issues in PR body"
                    description="Attach issue references when creating pull requests."
                    checked={settings.githubAutoLinkIssues}
                    onCheckedChange={(checked) =>
                      updateSettings({ githubAutoLinkIssues: Boolean(checked) })
                    }
                  />
                  <GithubSettingToggle
                    label="Auto-request review on PR"
                    description="Request review immediately after PR creation."
                    checked={settings.githubAutoReviewOnPr}
                    onCheckedChange={(checked) =>
                      updateSettings({ githubAutoReviewOnPr: Boolean(checked) })
                    }
                  />
                  <GithubSettingToggle
                    label="Auto-rerun failed Actions"
                    description="Retry failed workflows one time."
                    checked={settings.githubActionsAutoRerunFailed}
                    onCheckedChange={(checked) =>
                      updateSettings({ githubActionsAutoRerunFailed: Boolean(checked) })
                    }
                  />
                  <GithubSettingToggle
                    label="Run security scan on push"
                    description="Trigger code scanning after each push."
                    checked={settings.githubSecurityScanOnPush}
                    onCheckedChange={(checked) =>
                      updateSettings({ githubSecurityScanOnPush: Boolean(checked) })
                    }
                  />
                  <GithubSettingToggle
                    label="Require passing checks"
                    description="Block merge flow until checks are green."
                    checked={settings.githubRequirePassingChecks}
                    onCheckedChange={(checked) =>
                      updateSettings({ githubRequirePassingChecks: Boolean(checked) })
                    }
                  />
                  <GithubSettingToggle
                    label="Create draft PR by default"
                    description="Open pull requests as draft first."
                    checked={settings.githubCreateDraftPrByDefault}
                    onCheckedChange={(checked) =>
                      updateSettings({ githubCreateDraftPrByDefault: Boolean(checked) })
                    }
                  />
                  <GithubSettingToggle
                    label="Show sidebar GitHub controller"
                    description="Display GitHub context controller in left sidebar."
                    checked={settings.githubSidebarControllerEnabled}
                    onCheckedChange={(checked) =>
                      updateSettings({ githubSidebarControllerEnabled: Boolean(checked) })
                    }
                  />
                </div>

                <div className="space-y-3">
                  <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground/80">
                    CLI Runtime Control
                  </p>
                  <CliBinaryControl
                    title="GitHub CLI (`gh`)"
                    pathValue={settings.githubCliPath}
                    argsValue={settings.githubCliArgs}
                    onPathChange={(value) => updateSettings({ githubCliPath: value })}
                    onArgsChange={(value) => updateSettings({ githubCliArgs: value })}
                    detectedPath={cliInstallationsById["github-cli"]?.path ?? null}
                    detectedVersion={cliInstallationsById["github-cli"]?.version ?? null}
                    isScanning={isScanningCliInstallations}
                    onScan={() => {
                      void scanCliInstallations();
                    }}
                  />
                  <CliBinaryControl
                    title="Claude CLI (`claude`)"
                    pathValue={settings.claudeCliPath}
                    argsValue={settings.claudeCliArgs}
                    onPathChange={(value) => updateSettings({ claudeCliPath: value })}
                    onArgsChange={(value) => updateSettings({ claudeCliArgs: value })}
                    detectedPath={cliInstallationsById["claude-cli"]?.path ?? null}
                    detectedVersion={cliInstallationsById["claude-cli"]?.version ?? null}
                    isScanning={isScanningCliInstallations}
                    onScan={() => {
                      void scanCliInstallations();
                    }}
                  />
                  <CliBinaryControl
                    title="Gemini CLI (`gemini` / `gemini-cli`)"
                    pathValue={settings.geminiCliPath}
                    argsValue={settings.geminiCliArgs}
                    onPathChange={(value) => updateSettings({ geminiCliPath: value })}
                    onArgsChange={(value) => updateSettings({ geminiCliArgs: value })}
                    detectedPath={cliInstallationsById["gemini-cli"]?.path ?? null}
                    detectedVersion={cliInstallationsById["gemini-cli"]?.version ?? null}
                    isScanning={isScanningCliInstallations}
                    onScan={() => {
                      void scanCliInstallations();
                    }}
                  />
                </div>

                {githubSettingsChanged ? (
                  <div className="flex justify-end">
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() =>
                        updateSettings({
                          githubEnabled: defaults.githubEnabled,
                          githubAuthMode: defaults.githubAuthMode,
                          githubToken: defaults.githubToken,
                          githubOwner: defaults.githubOwner,
                          githubRepo: defaults.githubRepo,
                          githubDefaultBaseBranch: defaults.githubDefaultBaseBranch,
                          githubWorkflowNameFilter: defaults.githubWorkflowNameFilter,
                          githubDefaultLabels: defaults.githubDefaultLabels,
                          githubAutoLinkIssues: defaults.githubAutoLinkIssues,
                          githubAutoReviewOnPr: defaults.githubAutoReviewOnPr,
                          githubActionsAutoRerunFailed: defaults.githubActionsAutoRerunFailed,
                          githubSecurityScanOnPush: defaults.githubSecurityScanOnPush,
                          githubRequirePassingChecks: defaults.githubRequirePassingChecks,
                          githubCreateDraftPrByDefault: defaults.githubCreateDraftPrByDefault,
                          githubSidebarControllerEnabled: defaults.githubSidebarControllerEnabled,
                          githubCliPath: defaults.githubCliPath,
                          githubCliArgs: defaults.githubCliArgs,
                          claudeCliPath: defaults.claudeCliPath,
                          claudeCliArgs: defaults.claudeCliArgs,
                          geminiCliPath: defaults.geminiCliPath,
                          geminiCliArgs: defaults.geminiCliArgs,
                        })
                      }
                    >
                      Reset GitHub settings
                    </Button>
                  </div>
                ) : null}
              </div>
            </section>
            ) : null}

            {activeSection.id === "responses" ? (
            <section
              id="settings-responses"
              className="rounded-2xl border border-border bg-card p-5"
            >
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
            ) : null}

            {activeSection.id === "keybindings" ? (
            <section
              id="settings-keybindings"
              className="rounded-2xl border border-border bg-card p-5"
            >
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
            ) : null}

            {activeSection.id === "safety" ? (
            <section
              id="settings-safety"
              className="rounded-2xl border border-border bg-card p-5"
            >
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
            ) : null}

            <UsageAndStatusSection />
              </div>
            </div>
          </div>
        </div>
      </div>
    </SidebarInset>
  );
}

// ── Usage & Provider Status ──────────────────────────────────────────

function UsageAndStatusSection() {
  const todayUsage = useTokenUsageStore((s) => s.getTodayUsage());
  const weekUsage = useTokenUsageStore((s) => s.getWeekUsage());
  const rateLimits = useTokenUsageStore((s) => s.rateLimits);
  const [statusData, setStatusData] = useState<{
    status: string;
    description: string;
    updatedAt: string;
  } | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);

  const fetchOpenAIStatus = useCallback(() => {
    setStatusLoading(true);
    fetch("https://status.openai.com/api/v2/status.json")
      .then((res) => res.json())
      .then((data: { status: { indicator: string; description: string }; page: { updated_at: string } }) => {
        setStatusData({
          status: data.status.indicator,
          description: data.status.description,
          updatedAt: new Date(data.page.updated_at).toLocaleString(),
        });
      })
      .catch(() => {
        setStatusData({ status: "error", description: "Could not fetch status", updatedAt: "" });
      })
      .finally(() => setStatusLoading(false));
  }, []);

  const statusColor =
    statusData?.status === "none"
      ? "bg-green-500"
      : statusData?.status === "minor"
        ? "bg-yellow-500"
        : statusData?.status === "major" || statusData?.status === "critical"
          ? "bg-red-500"
          : "bg-muted-foreground";

  return (
    <section className="rounded-2xl border border-border bg-card p-5">
      <div className="mb-4">
        <h2 className="text-sm font-medium text-foreground">Usage & Provider Status</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Token consumption tracking and provider health.
        </p>
      </div>

      {/* Usage stats */}
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-lg border border-border bg-background p-3">
            <p className="text-xs text-muted-foreground">Today</p>
            <p className="text-lg font-semibold text-foreground">
              {formatTokens(todayUsage.totalTokens)}
            </p>
            <p className="text-xs text-muted-foreground">
              {todayUsage.turnCount} turns
              {todayUsage.totalCostUsd > 0 && ` \u00b7 $${todayUsage.totalCostUsd.toFixed(2)}`}
            </p>
          </div>
          <div className="rounded-lg border border-border bg-background p-3">
            <p className="text-xs text-muted-foreground">This week</p>
            <p className="text-lg font-semibold text-foreground">
              {formatTokens(weekUsage.totalTokens)}
            </p>
            <p className="text-xs text-muted-foreground">
              {weekUsage.turnCount} turns
              {weekUsage.totalCostUsd > 0 && ` \u00b7 $${weekUsage.totalCostUsd.toFixed(2)}`}
            </p>
          </div>
        </div>

        {/* Rate limits */}
        {rateLimits.length > 0 && (
          <div className="rounded-lg border border-border bg-background p-3">
            <p className="mb-1 text-xs font-medium text-muted-foreground">Rate Limits</p>
            {rateLimits.map((rl) => (
              <div key={rl.provider} className="text-xs text-foreground">
                <span className="font-medium">{rl.provider}:</span>{" "}
                <span className="text-muted-foreground">
                  {JSON.stringify(rl.limits).slice(0, 120)}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* OpenAI Status */}
        <div className="rounded-lg border border-border bg-background p-3">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium text-muted-foreground">OpenAI Status</p>
            <Button
              size="xs"
              variant="outline"
              onClick={fetchOpenAIStatus}
              disabled={statusLoading}
            >
              {statusLoading ? "Checking..." : statusData ? "Refresh" : "Check Status"}
            </Button>
          </div>
          {statusData && (
            <div className="mt-2 flex items-center gap-2">
              <div className={`h-2 w-2 rounded-full ${statusColor}`} />
              <span className="text-sm text-foreground">{statusData.description}</span>
              {statusData.updatedAt && (
                <span className="text-xs text-muted-foreground">({statusData.updatedAt})</span>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function formatTokens(tokens: number): string {
  if (tokens === 0) return "0";
  if (tokens < 1_000) return String(tokens);
  if (tokens < 1_000_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return `${(tokens / 1_000_000).toFixed(2)}M`;
}

export const Route = createFileRoute("/_chat/settings")({
  component: SettingsRouteView,
});






