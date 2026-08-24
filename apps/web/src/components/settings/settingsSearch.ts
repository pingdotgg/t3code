import { isElectron } from "~/env";
import type { MessageKey, Translate } from "~/i18n/messages";

export type SettingsPath =
  | "/settings/general"
  | "/settings/appearance"
  | "/settings/keybindings"
  | "/settings/providers"
  | "/settings/integrations"
  | "/settings/source-control"
  | "/settings/connections"
  | "/settings/archived";

export interface SettingsSearchItem {
  readonly id: string;
  readonly title: string;
  readonly to: SettingsPath;
  readonly targetId?: string;
  // Its row only renders in the desktop app, so a browser result would land on
  // an anchor that isn't there.
  readonly desktopOnly?: boolean;
}

/** Section labels in sidebar order; the key record keeps localized consumers in sync. */
export const SETTINGS_SECTION_LABELS: Readonly<Record<SettingsPath, string>> = {
  "/settings/general": "General",
  "/settings/appearance": "Appearance",
  "/settings/keybindings": "Keybindings",
  "/settings/providers": "Providers",
  "/settings/integrations": "Integrations",
  "/settings/source-control": "Source Control",
  "/settings/connections": "Connections",
  "/settings/archived": "Archive",
};

export const SETTINGS_SECTION_LABEL_KEYS: Readonly<Record<SettingsPath, MessageKey>> = {
  "/settings/general": "settings.nav.general",
  "/settings/appearance": "settings.nav.appearance",
  "/settings/keybindings": "settings.nav.keybindings",
  "/settings/providers": "settings.nav.providers",
  "/settings/integrations": "settings.nav.integrations",
  "/settings/source-control": "settings.nav.sourceControl",
  "/settings/connections": "settings.nav.connections",
  "/settings/archived": "settings.nav.archive",
};

/**
 * Every searchable setting, in result order. This catalog is the single
 * source of truth for anchor ids and visible titles: panels render both via
 * `searchableSetting`, so a retitle (or, later, a translation pass) happens
 * here once instead of separately in the panel and the index.
 */
export const SETTINGS_SEARCH_ITEMS = [
  {
    id: "color-scheme",
    title: "Color scheme",
    to: "/settings/appearance",
    // The scheme tiles sit at the top of the Appearance section.
    targetId: "appearance",
  },
  {
    id: "theme",
    title: "Themes",
    to: "/settings/appearance",
    // Theme cards live directly under the scheme tiles; the section is the
    // stable scroll destination for both.
    targetId: "appearance",
  },
  {
    // Prefixed because the slider control already owns the `appearance-contrast` id.
    id: "setting-appearance-contrast",
    title: "Contrast",
    to: "/settings/appearance",
  },
  {
    // Prefixed because the slider control already owns the `glass-opacity` id.
    id: "setting-glass-opacity",
    title: "Glass opacity",
    to: "/settings/appearance",
  },
  {
    id: "environment-identification",
    title: "Environment identification",
    to: "/settings/appearance",
    // The setting is stage-dependent, so its parent section is the stable destination.
    targetId: "appearance",
  },
  {
    id: "interface-font",
    title: "Interface font",
    to: "/settings/appearance",
  },
  {
    id: "prompt-font",
    title: "Prompt font",
    to: "/settings/appearance",
  },
  {
    id: "code-font",
    title: "Code font",
    to: "/settings/appearance",
  },
  {
    id: "terminal-font",
    title: "Terminal font",
    to: "/settings/appearance",
  },
  {
    id: "font-smoothing",
    title: "Font smoothing",
    to: "/settings/appearance",
  },
  {
    id: "word-wrap",
    title: "Word wrap",
    to: "/settings/appearance",
  },
  {
    id: "interface-language",
    title: "Interface language",
    to: "/settings/general",
  },
  {
    id: "project-grouping",
    title: "Project grouping",
    to: "/settings/general",
  },
  {
    id: "auto-settle-inactive-threads",
    title: "Auto-settle inactive threads",
    to: "/settings/general",
  },
  {
    id: "auto-settle-merged-threads",
    title: "Auto-settle merged threads",
    to: "/settings/general",
  },
  {
    id: "time-format",
    title: "Time format",
    to: "/settings/general",
  },
  {
    id: "hide-whitespace-changes",
    title: "Hide whitespace changes",
    to: "/settings/general",
  },
  {
    id: "skills-in-slash-menu",
    title: "Show skills in slash menu",
    to: "/settings/general",
  },
  {
    id: "provider-update-checks",
    title: "Provider update checks",
    to: "/settings/general",
  },
  {
    id: "new-threads",
    title: "New threads",
    to: "/settings/general",
  },
  {
    id: "start-from-origin",
    title: "Start from origin",
    to: "/settings/general",
    targetId: "new-threads",
  },
  {
    id: "add-project-starts-in",
    title: "Add project starts in",
    to: "/settings/general",
  },
  {
    id: "archive-confirmation",
    title: "Archive confirmation",
    to: "/settings/general",
  },
  {
    id: "delete-confirmation",
    title: "Delete confirmation",
    to: "/settings/general",
  },
  {
    id: "quit-confirmation",
    title: "Hold to quit",
    to: "/settings/general",
    desktopOnly: true,
  },
  {
    id: "text-generation-model",
    title: "Text generation model",
    to: "/settings/general",
  },
  {
    id: "diagnostics",
    title: "Diagnostics",
    to: "/settings/general",
  },
  {
    id: "legacy-plan-mode",
    title: "Plan mode (legacy)",
    to: "/settings/general",
  },
  {
    id: "legacy-token-streaming",
    title: "Stream token by token (legacy)",
    to: "/settings/general",
  },
  {
    id: "legacy-sidebar",
    title: "Sidebar (legacy)",
    to: "/settings/general",
  },
  {
    id: "keybindings",
    title: "Keybindings",
    to: "/settings/keybindings",
  },
  {
    id: "providers",
    title: "Providers",
    to: "/settings/providers",
  },
  {
    id: "agent-browser-access",
    title: "Agent browser access",
    to: "/settings/integrations",
    targetId: "browser",
  },
  {
    id: "browser-default-viewport",
    title: "Default browser viewport",
    to: "/settings/integrations",
    targetId: "browser",
  },
  {
    id: "browser-default-zoom",
    title: "Default browser zoom",
    to: "/settings/integrations",
    targetId: "browser",
  },
  {
    id: "browser-default-appearance",
    title: "Default browser appearance",
    to: "/settings/integrations",
    targetId: "browser",
  },
  {
    id: "browser-auto-show-floating-preview",
    title: "Auto-show floating preview",
    to: "/settings/integrations",
    targetId: "browser",
  },
  {
    id: "source-control",
    title: "Source control",
    to: "/settings/source-control",
  },
  {
    id: "remote-environments",
    title: "Remote environments",
    to: "/settings/connections",
  },
  {
    id: "archive",
    title: "Archived threads",
    to: "/settings/archived",
  },
] as const satisfies ReadonlyArray<SettingsSearchItem>;

export type SettingsSearchItemId = (typeof SETTINGS_SEARCH_ITEMS)[number]["id"];

export const SETTINGS_SEARCH_TITLE_KEYS: Readonly<Record<SettingsSearchItemId, MessageKey>> = {
  "color-scheme": "settings.search.colorScheme",
  theme: "settings.search.themes",
  "setting-appearance-contrast": "settings.search.contrast",
  "setting-glass-opacity": "settings.search.glassOpacity",
  "environment-identification": "settings.search.environmentIdentification",
  "interface-font": "settings.search.interfaceFont",
  "prompt-font": "settings.search.promptFont",
  "code-font": "settings.search.codeFont",
  "terminal-font": "settings.search.terminalFont",
  "font-smoothing": "settings.search.fontSmoothing",
  "word-wrap": "settings.search.wordWrap",
  "interface-language": "settings.search.interfaceLanguage",
  "project-grouping": "settings.search.projectGrouping",
  "auto-settle-inactive-threads": "settings.search.autoSettleInactive",
  "auto-settle-merged-threads": "settings.search.autoSettleMerged",
  "time-format": "settings.search.timeFormat",
  "hide-whitespace-changes": "settings.search.hideWhitespaceChanges",
  "skills-in-slash-menu": "settings.search.skillsInSlashMenu",
  "provider-update-checks": "settings.search.providerUpdateChecks",
  "new-threads": "settings.search.newThreads",
  "start-from-origin": "settings.search.startFromOrigin",
  "add-project-starts-in": "settings.search.addProjectStartsIn",
  "archive-confirmation": "settings.search.archiveConfirmation",
  "delete-confirmation": "settings.search.deleteConfirmation",
  "quit-confirmation": "settings.search.holdToQuit",
  "text-generation-model": "settings.search.textGenerationModel",
  diagnostics: "settings.search.diagnostics",
  "legacy-plan-mode": "settings.search.legacyPlanMode",
  "legacy-token-streaming": "settings.search.legacyTokenStreaming",
  "legacy-sidebar": "settings.search.legacySidebar",
  keybindings: "settings.search.keybindings",
  providers: "settings.search.providers",
  "agent-browser-access": "settings.search.agentBrowserAccess",
  "browser-default-viewport": "settings.search.browserDefaultViewport",
  "browser-default-zoom": "settings.search.browserDefaultZoom",
  "browser-default-appearance": "settings.search.browserDefaultAppearance",
  "browser-auto-show-floating-preview": "settings.search.browserAutoShowFloatingPreview",
  "source-control": "settings.search.sourceControl",
  "remote-environments": "settings.search.remoteEnvironments",
  archive: "settings.search.archivedThreads",
};

const SEARCH_ITEMS_BY_ID = Object.fromEntries(
  SETTINGS_SEARCH_ITEMS.map((item) => [item.id, item]),
) as Readonly<Record<SettingsSearchItemId, SettingsSearchItem>>;

/**
 * `id` and `title` props for the element a search item anchors to. Panels
 * spread (or pick from) this instead of restating the strings, so the catalog
 * and the rendered settings cannot drift apart.
 */
export function searchableSetting(
  id: SettingsSearchItemId,
  t?: Translate,
): {
  readonly id: string;
  readonly title: string;
} {
  const { id: anchorId, title } = SEARCH_ITEMS_BY_ID[id];
  return { id: anchorId, title: t?.(SETTINGS_SEARCH_TITLE_KEYS[id]) ?? title };
}

export function localizeSettingsSearchItems(t: Translate): ReadonlyArray<SettingsSearchItem> {
  return SETTINGS_SEARCH_ITEMS.map((item) => ({
    ...item,
    title: t(SETTINGS_SEARCH_TITLE_KEYS[item.id]),
  }));
}

function normalizeSearchText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function searchSettings(
  query: string,
  items: ReadonlyArray<SettingsSearchItem> = SETTINGS_SEARCH_ITEMS,
): ReadonlyArray<SettingsSearchItem> {
  const normalizedQuery = normalizeSearchText(query);
  if (normalizedQuery.length === 0) return [];

  return items.filter(
    (item) =>
      (isElectron || item.desktopOnly !== true) &&
      normalizeSearchText(item.title).includes(normalizedQuery),
  );
}
