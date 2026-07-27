export type SettingsPath =
  | "/settings/general"
  | "/settings/keybindings"
  | "/settings/providers"
  | "/settings/source-control"
  | "/settings/connections"
  | "/settings/beta"
  | "/settings/archived";

export interface SettingsSearchItem {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly to: SettingsPath;
  readonly targetId?: string;
  readonly keywords?: ReadonlyArray<string>;
}

export const SETTINGS_SECTION_LABELS: Readonly<Record<SettingsPath, string>> = {
  "/settings/general": "General",
  "/settings/keybindings": "Keybindings",
  "/settings/providers": "Providers",
  "/settings/source-control": "Source Control",
  "/settings/connections": "Connections",
  "/settings/beta": "Beta",
  "/settings/archived": "Archive",
};

export const SETTINGS_SEARCH_ITEMS: ReadonlyArray<SettingsSearchItem> = [
  {
    id: "theme",
    title: "Theme",
    description: "Choose how T3 Code looks across the app.",
    to: "/settings/general",
    keywords: ["appearance", "light", "dark", "system"],
  },
  {
    // Prefixed because the slider control already owns the `glass-opacity` id.
    id: "setting-glass-opacity",
    title: "Glass opacity",
    description: "Control how transparent menus, dialogs, and the composer are.",
    to: "/settings/general",
    keywords: ["appearance", "transparency"],
  },
  {
    id: "project-grouping",
    title: "Project grouping",
    description: "Combine matching repositories across environments.",
    to: "/settings/general",
    keywords: ["sidebar", "repositories", "environments"],
  },
  {
    id: "time-format",
    title: "Time format",
    description: "Choose the clock format used for timestamps.",
    to: "/settings/general",
    keywords: ["timestamp", "12 hour", "24 hour", "locale"],
  },
  {
    id: "word-wrap",
    title: "Word wrap",
    description: "Wrap long lines in code blocks, tables, diffs, and file previews.",
    to: "/settings/general",
    keywords: ["line wrapping", "code"],
  },
  {
    id: "hide-whitespace-changes",
    title: "Hide whitespace changes",
    description: "Ignore whitespace-only edits in the diff panel by default.",
    to: "/settings/general",
    keywords: ["diff", "spaces"],
  },
  {
    id: "assistant-output",
    title: "Assistant output",
    description: "Show token-by-token output while a response is in progress.",
    to: "/settings/general",
    keywords: ["streaming", "responses"],
  },
  {
    id: "provider-update-checks",
    title: "Provider update checks",
    description: "Check installed provider CLIs for newer versions.",
    to: "/settings/general",
    keywords: ["updates", "codex", "claude", "opencode"],
  },
  {
    id: "auto-open-task-panel",
    title: "Auto-open task panel",
    description: "Open the plan and task panel automatically when steps appear.",
    to: "/settings/general",
    keywords: ["plan", "sidebar"],
  },
  {
    id: "new-threads",
    title: "New threads",
    description: "Choose the default workspace mode for new draft threads.",
    to: "/settings/general",
    keywords: ["worktree", "local", "workspace"],
  },
  {
    id: "start-from-origin",
    title: "Start from origin",
    description: "Create new worktrees from the latest matching branch on origin.",
    to: "/settings/general",
    targetId: "new-threads",
    keywords: ["worktree", "git", "remote branch"],
  },
  {
    id: "add-project-starts-in",
    title: "Add project starts in",
    description: "Choose the initial directory for the Add Project browser.",
    to: "/settings/general",
    keywords: ["folder", "directory", "path"],
  },
  {
    id: "archive-confirmation",
    title: "Archive confirmation",
    description: "Require a second click before a thread is archived.",
    to: "/settings/general",
    keywords: ["confirm", "threads"],
  },
  {
    id: "delete-confirmation",
    title: "Delete confirmation",
    description: "Ask before deleting a thread and its chat history.",
    to: "/settings/general",
    keywords: ["confirm", "threads"],
  },
  {
    id: "text-generation-model",
    title: "Text generation model",
    description: "Choose the model used for commit messages, PR titles, and other Git text.",
    to: "/settings/general",
    keywords: ["git", "commit message", "pull request"],
  },
  {
    id: "diagnostics",
    title: "Diagnostics",
    description: "View application tracing, metrics, processes, and failure details.",
    to: "/settings/general",
    keywords: ["debug", "logs", "observability"],
  },
  {
    id: "keybindings",
    title: "Keybindings",
    description: "View and customize keyboard shortcuts.",
    to: "/settings/keybindings",
    keywords: ["keyboard", "shortcuts", "hotkeys"],
  },
  {
    id: "providers",
    title: "Providers",
    description: "Configure agent providers, instances, models, and availability.",
    to: "/settings/providers",
    keywords: ["codex", "claude", "cursor", "grok", "opencode", "models"],
  },
  {
    id: "source-control",
    title: "Source control",
    description: "Configure detected version control systems and hosting providers.",
    to: "/settings/source-control",
    keywords: ["git", "jj", "github", "gitlab", "bitbucket", "azure devops"],
  },
  {
    id: "remote-environments",
    title: "Remote environments",
    description: "Add and manage connections to other T3 Code environments.",
    to: "/settings/connections",
    keywords: ["ssh", "hosts", "servers"],
  },
  {
    id: "sidebar-v2",
    title: "Sidebar v2",
    description: "Use the flat thread list with rich active-work cards.",
    to: "/settings/beta",
    keywords: ["threads", "settled"],
  },
  {
    id: "auto-settle-inactive-threads",
    title: "Auto-settle inactive threads",
    description: "Settle threads automatically after a period without activity.",
    to: "/settings/beta",
    targetId: "sidebar-v2",
    keywords: ["sidebar", "archive", "days"],
  },
  {
    id: "archive",
    title: "Archived threads",
    description: "View, restore, or delete archived conversations.",
    to: "/settings/archived",
    keywords: ["unarchive", "history", "deleted"],
  },
];

function normalizeSearchText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function scoreSettingsSearchItem(item: SettingsSearchItem, tokens: ReadonlyArray<string>): number {
  const title = normalizeSearchText(item.title);
  const section = normalizeSearchText(SETTINGS_SECTION_LABELS[item.to]);
  const description = normalizeSearchText(item.description);
  const keywords = normalizeSearchText(item.keywords?.join(" ") ?? "");
  const searchableText = `${title} ${section} ${description} ${keywords}`;

  if (!tokens.every((token) => searchableText.includes(token))) {
    return -1;
  }

  return tokens.reduce((score, token) => {
    if (title === token) return score + 100;
    if (title.startsWith(token)) return score + 75;
    if (title.includes(token)) return score + 50;
    if (section.includes(token)) return score + 25;
    if (keywords.includes(token)) return score + 15;
    return score + 5;
  }, 0);
}

export function searchSettings(
  query: string,
  items: ReadonlyArray<SettingsSearchItem> = SETTINGS_SEARCH_ITEMS,
): ReadonlyArray<SettingsSearchItem> {
  const normalizedQuery = normalizeSearchText(query);
  if (normalizedQuery.length === 0) return [];

  const tokens = normalizedQuery.split(" ");
  return items
    .map((item, index) => ({ item, index, score: scoreSettingsSearchItem(item, tokens) }))
    .filter((result) => result.score >= 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map((result) => result.item);
}
