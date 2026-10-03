import { isElectron } from "../../env";

export type SettingsPath =
  | "/settings/general"
  | "/settings/appearance"
  | "/settings/providers"
  | "/settings/keybindings"
  | "/settings/storage"
  | "/settings/connections"
  | "/settings/workflows"
  | "/settings/pull-request-collaboration"
  | "/settings/archived";

export interface SettingsSearchItem {
  readonly title: string;
  readonly to: SettingsPath;
  readonly id: string;
  readonly terms?: string;
  readonly desktopOnly?: boolean;
  readonly localRebuildOnly?: boolean;
}

export function settingsSearchId(title: string) {
  return `setting-${title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")}`;
}

const settingsByPage: ReadonlyArray<{
  to: SettingsPath;
  rows: ReadonlyArray<string>;
}> = [
  {
    to: "/settings/general",
    rows: [
      "Automatically monitor associated PRs",
      "Automatic maintenance chats",
      "Default list state",
      "Agent browser access",
      "Agent browser preview",
      "Browser recording frame rate",
      "Browser profiles",
      "Device environments",
      "Device support",
      "Agent device access",
      "Device hosts",
      "Assistant output",
      "Completion notifications",
      "Auto-open task panel",
      "New threads",
      "Add project starts in",
      "Chat export directory",
      "Transfer active chats",
      "Chat export details",
      "Archive review chats on merge",
      "Auto-archive settled threads",
      "Archive confirmation",
      "Delete confirmation",
      "Keybindings",
      "Diagnostics",
    ],
  },
  {
    to: "/settings/appearance",
    rows: [
      "Theme",
      "Time format",
      "UI density",
      "Sidebar translucency",
      "Inbox sidebar (beta)",
      "Project scripts",
      "Open in editor",
      "Git actions",
      "Workflows",
      "Workflow runs",
      "Export chat",
      "Insights toggle",
      "Browser toggle",
      "Files toggle",
      "Terminal toggle",
      "Diff toggle",
      "Search",
      "Pull requests",
      "Skills",
      "New thread",
      "Confirm before export",
      "Confirm script runs",
      "Remember preferred editor",
      "Confirm default-branch git actions",
      "Git quick action",
      "Confirm workflow runs",
      "Prewarm workflows on hover",
      "Workflow badge count",
      "Search shortcut hint",
      "Confirm new thread",
      "Interface font",
      "Code font",
      "Code font size",
      "File preview line spacing",
      "Chat font size",
      "Status line font size",
      "Input font size",
      "Sidebar font size",
      "Sidebar icon size",
      "Sidebar metadata font size",
      "Sidebar row spacing",
      "Tool output font size",
      "Normal message preview",
      "Cross-thread message preview",
      "Monitoring message preview",
      "Diff code font size",
      "Body font size",
      "Wrap long diff lines",
      "Browser default viewport",
      "Browser default zoom",
      "Browser default appearance",
      "Open links in",
      "Diff line wrapping",
    ],
  },
  {
    to: "/settings/providers",
    rows: ["Default model", "Text generation model", "Delegated thread model", "Providers"],
  },
  {
    to: "/settings/keybindings",
    rows: ["Keybindings", "Shortcuts", "Keybindings file"],
  },
  {
    to: "/settings/storage",
    rows: [
      "Delete worktrees with deleted threads",
      "Delete merged worktrees",
      "Project checkout",
      "Shared worktrees",
      "Worktrees with local changes",
    ],
  },
  {
    to: "/settings/connections",
    rows: ["Remote tunnel", "T3 Connect account", "Local network access"],
  },
  {
    to: "/settings/workflows",
    rows: ["Review Code", "Review scope", "Review prompt", "Fix Review Issues", "Fix prompt"],
  },
  {
    to: "/settings/pull-request-collaboration",
    rows: [
      "Automation policy",
      "Exchange budget",
      "Review trigger",
      "Review workflow",
      "PR feedback policy",
      "Advanced limits",
    ],
  },
];

const relatedTerms: Readonly<Record<string, string>> = {
  "Remote tunnel": "remote access connect",
  "Local network access": "lan pairing phone",
  "Device environments": "pair phone emulator simulator",
  "Browser recording frame rate": "capture video fps",
  "Review prompt": "review code instructions",
  "Fix prompt": "review prompt fix issues instructions",
  "Delegated thread model": "child agent model",
  Theme: "appearance dark light system",
  "UI density": "spacing compact comfortable spacious",
  "Archived threads": "archive restore delete",
  "Archive review chats on merge": "review pull request merged cleanup",
  "Auto-archive settled threads": "settled archive cleanup days",
};

export const SETTINGS_SEARCH_ITEMS: ReadonlyArray<SettingsSearchItem> = [
  ...settingsByPage.flatMap(({ to, rows }) =>
    rows.map((title) => ({
      title,
      to,
      id:
        title === "Providers"
          ? "section-providers"
          : title === "Keybindings" || title === "Shortcuts"
            ? "section-shortcuts"
            : settingsSearchId(title),
      ...(relatedTerms[title] ? { terms: relatedTerms[title] } : {}),
    })),
  ),
  {
    title: "Update track",
    to: "/settings/general",
    id: settingsSearchId("Update track"),
    desktopOnly: true,
  },
  ...["Local source", "Check for source updates"].map((title) => ({
    title,
    to: "/settings/general" as const,
    id: settingsSearchId(title),
    desktopOnly: true,
    localRebuildOnly: true,
  })),
  {
    title: "Version",
    to: "/settings/general",
    id: "section-about",
  },
  {
    title: "Custom workflows",
    to: "/settings/workflows",
    id: "section-custom-workflows",
    terms: "add prompt workflow",
  },
  {
    title: "Archived threads",
    to: "/settings/archived",
    id: "section-archived-threads",
    terms: "archive restore delete",
  },
];

function normalize(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

export function searchSettings(
  query: string,
  availability: { readonly localRebuildEnabled?: boolean } = {},
): ReadonlyArray<SettingsSearchItem> {
  const text = normalize(query);
  if (!text) return [];
  const tokens = text.split(" ");
  return SETTINGS_SEARCH_ITEMS.flatMap((item, index) => {
    if (item.desktopOnly && !isElectron) return [];
    if (item.localRebuildOnly && !availability.localRebuildEnabled) return [];
    const title = normalize(item.title);
    const terms = normalize(item.terms ?? "");
    const page = item.to.slice("/settings/".length).replaceAll("-", " ");
    if (
      !tokens.every((token) => {
        const singular =
          token.length > 3 && token.endsWith("s") && !token.endsWith("ss")
            ? token.slice(0, -1)
            : token;
        return [title, terms, page].some(
          (field) => field.includes(token) || field.includes(singular),
        );
      })
    ) {
      return [];
    }
    const rank = title === text ? 4 : title.startsWith(text) ? 3 : title.includes(text) ? 2 : 1;
    return [{ item, index, rank }];
  })
    .sort((a, b) => b.rank - a.rank || a.index - b.index)
    .map(({ item }) => item);
}
