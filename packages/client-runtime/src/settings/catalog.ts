/**
 * Canonical settings sections for every client surface.
 *
 * Web and mobile nav, search labels, and parity tests read from here so a new
 * section is declared once and each surface either implements it or is marked
 * out of scope via `surfaces`.
 */

export type SettingsSurface = "web" | "desktop" | "mobile";

export type SettingsOwnership = "client" | "server" | "hybrid";

export type SettingsSectionId =
  | "general"
  | "appearance"
  | "chat"
  | "diffs"
  | "keybindings"
  | "voice"
  | "snap-shot"
  | "providers"
  | "threads"
  | "browser"
  | "devices"
  | "scheduled-tasks"
  | "projects"
  | "source-control"
  | "worktrees"
  | "connections"
  | "access"
  | "secrets"
  | "maintenance"
  | "labs"
  | "about"
  | "archived"
  | "diagnostics"
  // Mobile-shaped surfaces that have no dedicated web settings page.
  | "notifications"
  | "navigation"
  | "keyboard";

export type SettingsNavGroupId = "device" | "agents" | "code" | "connections" | "footer";

export interface SettingsSectionDefinition {
  readonly id: SettingsSectionId;
  readonly label: string;
  /** Sidebar / index group. `null` puts the section in the unheaded top or footer block. */
  readonly group: SettingsNavGroupId | null;
  /** Surfaces that must expose this section. */
  readonly surfaces: ReadonlyArray<SettingsSurface>;
  readonly ownership: SettingsOwnership;
  /** Web/desktop route when the section appears there. */
  readonly webPath?: `/settings/${string}`;
  readonly searchTerms?: ReadonlyArray<string>;
  /** Omit from nav until the secrets feature flag is on. */
  readonly secretsFeature?: boolean;
  /** Listed in search / About links but not the primary settings index. */
  readonly secondary?: boolean;
}

const WEB_DESKTOP_MOBILE: ReadonlyArray<SettingsSurface> = ["web", "desktop", "mobile"];
const WEB_DESKTOP: ReadonlyArray<SettingsSurface> = ["web", "desktop"];
const MOBILE_ONLY: ReadonlyArray<SettingsSurface> = ["mobile"];

/**
 * Order within each group is nav order. Group order: device → agents → code →
 * connections → footer. Sections with `group: null` and no `secondary` sit in
 * the unheaded device block when their surfaces include the client; footer
 * null-group sections are listed after connections via `footerSectionIds`.
 */
export const SETTINGS_SECTIONS = [
  {
    id: "general",
    label: "General",
    group: null,
    surfaces: WEB_DESKTOP_MOBILE,
    ownership: "client",
    webPath: "/settings/general",
    searchTerms: ["notifications", "sidebar", "confirmations", "organization", "project grouping"],
  },
  {
    id: "appearance",
    label: "Appearance",
    group: null,
    surfaces: WEB_DESKTOP_MOBILE,
    ownership: "client",
    webPath: "/settings/appearance",
    searchTerms: ["theme", "fonts", "dark mode", "text size"],
  },
  {
    id: "chat",
    label: "Chat",
    group: null,
    surfaces: WEB_DESKTOP_MOBILE,
    ownership: "client",
    webPath: "/settings/chat",
    searchTerms: ["composer", "follow-ups", "queue", "steer"],
  },
  {
    id: "diffs",
    label: "Diffs & pull requests",
    group: null,
    surfaces: WEB_DESKTOP_MOBILE,
    ownership: "client",
    webPath: "/settings/diffs",
    searchTerms: ["diff", "pull request", "review", "word break"],
  },
  {
    id: "keybindings",
    label: "Keybindings",
    group: null,
    surfaces: WEB_DESKTOP,
    ownership: "client",
    webPath: "/settings/keybindings",
    searchTerms: ["shortcuts", "hotkeys", "keymap"],
  },
  {
    id: "voice",
    label: "Voice",
    group: null,
    surfaces: WEB_DESKTOP_MOBILE,
    ownership: "hybrid",
    webPath: "/settings/voice",
    searchTerms: ["dictation", "microphone", "transcription"],
  },
  {
    id: "snap-shot",
    label: "SnapShots",
    group: null,
    // Route exists on web; the panel is a no-op outside the Electron shell.
    surfaces: WEB_DESKTOP,
    ownership: "client",
    webPath: "/settings/snap-shot",
    searchTerms: ["screenshot", "capture", "window"],
  },
  {
    id: "navigation",
    label: "Navigation tabs",
    group: null,
    surfaces: MOBILE_ONLY,
    ownership: "client",
    searchTerms: ["tabs", "tab order", "reorder", "hide tabs"],
  },
  {
    id: "keyboard",
    label: "Keyboard",
    group: null,
    surfaces: MOBILE_ONLY,
    ownership: "client",
    searchTerms: ["return key", "send message", "new line", "hardware keyboard"],
  },
  {
    id: "notifications",
    label: "Notifications",
    group: "connections",
    surfaces: MOBILE_ONLY,
    ownership: "client",
    searchTerms: ["push", "alerts", "live activity", "agent activity"],
  },
  {
    id: "providers",
    label: "Providers",
    group: "agents",
    surfaces: WEB_DESKTOP_MOBILE,
    ownership: "server",
    webPath: "/settings/providers",
    searchTerms: ["agents", "codex", "claude", "cursor", "opencode", "models", "auth", "binary"],
  },
  {
    id: "threads",
    label: "Threads",
    group: "agents",
    surfaces: WEB_DESKTOP_MOBILE,
    ownership: "server",
    webPath: "/settings/threads",
    searchTerms: ["workspace", "permissions", "auto-settle", "usage limits", "streaming"],
  },
  {
    id: "browser",
    label: "Browser",
    group: "agents",
    surfaces: WEB_DESKTOP_MOBILE,
    ownership: "hybrid",
    webPath: "/settings/browser",
    searchTerms: ["agent browser", "preview", "viewport", "profiles"],
  },
  {
    id: "devices",
    label: "Devices",
    group: "agents",
    surfaces: WEB_DESKTOP_MOBILE,
    ownership: "hybrid",
    webPath: "/settings/devices",
    searchTerms: ["simulator", "emulator", "device hub", "ios", "android"],
  },
  {
    id: "scheduled-tasks",
    label: "Scheduled tasks",
    group: "agents",
    surfaces: WEB_DESKTOP_MOBILE,
    ownership: "server",
    webPath: "/settings/scheduled-tasks",
    searchTerms: ["automations", "cron", "webhook", "recurring"],
  },
  {
    id: "projects",
    label: "Projects",
    group: "code",
    surfaces: WEB_DESKTOP_MOBILE,
    ownership: "hybrid",
    webPath: "/settings/projects",
    searchTerms: ["checkout", "project overview", "pin", "archive"],
  },
  {
    id: "source-control",
    label: "Source control",
    group: "code",
    surfaces: WEB_DESKTOP_MOBILE,
    ownership: "server",
    webPath: "/settings/source-control",
    searchTerms: ["git", "pull requests", "github", "co-authors"],
  },
  {
    id: "worktrees",
    label: "Worktrees",
    group: "code",
    surfaces: WEB_DESKTOP_MOBILE,
    ownership: "server",
    webPath: "/settings/worktrees",
    searchTerms: ["branch naming", "submodules", "cleanup"],
  },
  {
    id: "connections",
    label: "Environments",
    group: "connections",
    surfaces: WEB_DESKTOP_MOBILE,
    ownership: "hybrid",
    webPath: "/settings/connections",
    searchTerms: ["servers", "pair", "remote", "tailscale"],
  },
  {
    id: "access",
    label: "Sharing & access",
    group: "connections",
    surfaces: WEB_DESKTOP_MOBILE,
    ownership: "hybrid",
    webPath: "/settings/access",
    searchTerms: ["permissions", "scopes", "routes", "authorized clients"],
  },
  {
    id: "secrets",
    label: "Secrets",
    group: "connections",
    surfaces: WEB_DESKTOP_MOBILE,
    ownership: "server",
    webPath: "/settings/secrets",
    searchTerms: ["credentials", "secret providers", "1password", "vault"],
    secretsFeature: true,
  },
  {
    id: "maintenance",
    label: "Maintenance",
    group: "footer",
    surfaces: WEB_DESKTOP_MOBILE,
    ownership: "server",
    webPath: "/settings/maintenance",
    searchTerms: ["updates", "storage", "cleanup", "restart"],
  },
  {
    id: "labs",
    label: "Labs",
    group: "footer",
    surfaces: WEB_DESKTOP_MOBILE,
    ownership: "hybrid",
    webPath: "/settings/labs",
    searchTerms: ["beta", "experimental", "plan mode"],
  },
  {
    id: "about",
    label: "About",
    group: "footer",
    surfaces: WEB_DESKTOP_MOBILE,
    ownership: "client",
    webPath: "/settings/about",
    searchTerms: ["version", "licenses", "legal"],
  },
  {
    id: "archived",
    label: "Archive",
    group: "footer",
    surfaces: WEB_DESKTOP_MOBILE,
    ownership: "server",
    webPath: "/settings/archived",
    searchTerms: ["archive", "restore", "unarchive"],
  },
  {
    id: "diagnostics",
    label: "Diagnostics",
    group: "footer",
    surfaces: WEB_DESKTOP_MOBILE,
    ownership: "hybrid",
    webPath: "/settings/diagnostics",
    searchTerms: ["otel", "telemetry", "crash", "logs"],
    secondary: true,
  },
] satisfies ReadonlyArray<SettingsSectionDefinition>;

export type SettingsSection = SettingsSectionDefinition;

const SECTIONS_BY_ID = new Map<SettingsSectionId, SettingsSection>(
  SETTINGS_SECTIONS.map((section) => [section.id, section]),
);

export function settingsSection(id: SettingsSectionId): SettingsSection {
  const section = SECTIONS_BY_ID.get(id);
  if (!section) throw new Error(`Unknown settings section: ${id}`);
  return section;
}

export function settingsSectionsForSurface(
  surface: SettingsSurface,
  options?: { readonly secretsFeatureEnabled?: boolean; readonly includeSecondary?: boolean },
): ReadonlyArray<SettingsSection> {
  const secretsEnabled = options?.secretsFeatureEnabled ?? false;
  const includeSecondary = options?.includeSecondary ?? false;
  return SETTINGS_SECTIONS.filter((section) => {
    if (!section.surfaces.includes(surface)) return false;
    if (section.secretsFeature && !secretsEnabled) return false;
    if (section.secondary && !includeSecondary) return false;
    return true;
  });
}

/** Nav groups for a surface, in display order, omitting empty groups. */
export function settingsNavGroupsForSurface(
  surface: SettingsSurface,
  options?: { readonly secretsFeatureEnabled?: boolean },
): ReadonlyArray<{
  readonly id: SettingsNavGroupId | null;
  readonly heading: string | null;
  readonly sections: ReadonlyArray<SettingsSection>;
}> {
  const sections = settingsSectionsForSurface(surface, options);
  const groupMeta: ReadonlyArray<{
    readonly id: SettingsNavGroupId | null;
    readonly heading: string | null;
  }> = [
    { id: null, heading: null },
    { id: "agents", heading: "Agents" },
    { id: "code", heading: "Code" },
    { id: "connections", heading: "Connections" },
    { id: "footer", heading: null },
  ];

  return groupMeta.flatMap((meta) => {
    const groupSections = sections.filter((section) => section.group === meta.id);
    if (groupSections.length === 0) return [];
    return [{ ...meta, sections: groupSections }];
  });
}

export function assertSettingsSurfaceCoverage(
  surface: SettingsSurface,
  implemented: ReadonlySet<SettingsSectionId>,
  options?: { readonly secretsFeatureEnabled?: boolean; readonly includeSecondary?: boolean },
): ReadonlyArray<SettingsSectionId> {
  return settingsSectionsForSurface(surface, options)
    .map((section) => section.id)
    .filter((id) => !implemented.has(id));
}
