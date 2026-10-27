import { foldSearchQuery, rankSearchItems, scoreSearchTerms } from "@t3tools/shared/paletteSearch";

import type { SettingsPageTarget } from "./components/settings-page-targets";

/** What each page holds besides its row's label, so search finds a setting by its own name. */
const SETTINGS_SEARCH_TERMS = {
  account: ["sign in", "sign out", "login", "clerk", "connect"],
  SettingsEnvironments: [
    "servers",
    "connections",
    "pair",
    "add environment",
    "remote",
    "tailscale",
  ],
  SettingsNotifications: ["push", "alerts", "live activity", "agent activity"],
  SettingsAppearance: [
    "theme",
    "dark mode",
    "light mode",
    "colors",
    "font size",
    "text size",
    "code",
    "diffs",
    "terminal",
    "word break",
    "math",
  ],
  SettingsNavigation: ["tabs", "tab order", "reorder", "hide tabs"],
  SettingsKeyboard: ["return key", "send message", "new line", "hardware keyboard"],
  SettingsMicrophone: ["voice", "dictation", "audio input", "bluetooth"],
  SettingsScheduledTasks: ["automations", "schedule", "cron", "recurring", "webhook"],
  SettingsProjectOverview: ["project", "overview", "checkouts", "delete project"],
  SettingsOrganization: [
    "project grouping",
    "group projects",
    "organization",
    "sidebar",
    "working section",
    "new threads",
    "last project",
  ],
  SettingsThreads: [
    "new threads",
    "default workspace",
    "default permissions",
    "access",
    "response streaming",
    "preview browser",
    "browser access",
    "auto-settle",
    "settle",
    "snooze",
    "usage limits",
    "auto-resume",
    "thread behavior",
  ],
  SettingsFollowUp: ["follow-ups", "queue", "steer", "while the agent is running"],
  SettingsArchive: ["archive", "archived", "restore", "unarchive"],
  SettingsProviderAccounts: [
    "provider accounts",
    "codex",
    "claude",
    "cursor",
    "opencode",
    "sign in",
    "login",
    "auth",
  ],
  SettingsEnvironmentSourceControl: [
    "git",
    "pull requests",
    "co-authors",
    "agent credits",
    "default branch",
    "automatically pull",
  ],
  SettingsWorktrees: [
    "worktree",
    "branch naming",
    "branch prefix",
    "submodules",
    "start from remote",
  ],
  SettingsLabs: ["legacy", "plan mode", "beta"],
  SettingsEnvironmentMaintenance: ["updates", "provider updates", "restart", "manage environments"],
  SettingsAbout: [
    "version",
    "diagnostics",
    "client storage",
    "cache",
    "legal",
    "privacy",
    "terms",
    "open source licenses",
  ],
} satisfies Partial<Record<SettingsPageTarget | "account", readonly string[]>>;
const termsById: ReadonlyMap<string, readonly string[]> = new Map(
  Object.entries(SETTINGS_SEARCH_TERMS),
);

export interface SettingsSearchRow {
  readonly id: string;
  readonly label: string;
}

export interface SettingsSearchSection<Row extends SettingsSearchRow> {
  readonly title?: string;
  readonly rows: readonly Row[];
}

/**
 * Keeps the rows whose label, section, or page contents match `query`, in list order, and drops
 * sections left empty. Matching is the command palette's, so both searches agree.
 */
export function filterSettingsSections<
  Row extends SettingsSearchRow,
  Section extends SettingsSearchSection<Row>,
>(sections: readonly Section[], query: string): Section[] {
  const normalizedQuery = foldSearchQuery(query);
  const rows = sections.flatMap((section) =>
    section.rows.map((row) => ({ row, section: section.title })),
  );
  const matched = normalizedQuery
    ? new Set(
        rankSearchItems(rows, ({ row, section }, options) =>
          scoreSearchTerms(
            normalizedQuery,
            [row.label, ...(section ? [section] : []), ...(termsById.get(row.id) ?? [])],
            options,
          ),
        ).map(({ item }) => item.row),
      )
    : null;
  return sections.flatMap((section) => {
    const kept = matched ? section.rows.filter((row) => matched.has(row)) : section.rows;
    return kept.length ? [{ ...section, rows: kept }] : [];
  });
}
