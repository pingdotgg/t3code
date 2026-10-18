import { MOBILE_THEME_OPTIONS } from "../../lib/mobileTheme";
import {
  SETTINGS_SECTION_LABELS,
  settingsSectionForPage,
  type SettingsSection,
} from "./settings-sections";

export interface SettingsSearchItem {
  readonly id: string;
  readonly title: string;
  /** A section, or a page inside one that is safe to show without its section beneath it. */
  readonly page:
    | SettingsSection
    | "SettingsClientStorage"
    | "SettingsDiagnostics"
    | "SettingsOpenSourceLicenses";
  readonly searchTerms?: string;
}

export const SETTINGS_SEARCH_ITEMS: ReadonlyArray<SettingsSearchItem> = [
  {
    id: "account",
    title: "T3 Account",
    page: "SettingsAuth",
    searchTerms: "sign in sign out profile email clerk login",
  },
  {
    id: "t3-connect-servers",
    title: "Registered servers",
    page: "SettingsAuth",
    searchTerms: "t3 connect relay tunnel remote deregister",
  },
  {
    id: "add-environment",
    title: "Add environment",
    page: "SettingsEnvironments",
    searchTerms: "pair connect server remote host qr code tailscale new",
  },
  {
    id: "environment-connections",
    title: "Environment connections",
    page: "SettingsEnvironments",
    searchTerms: "enable disable servers machines remote saved connected t3 connect cloud",
  },
  {
    id: "github-routing",
    title: "GitHub routing",
    page: "SettingsEnvironments",
    searchTerms: "pull requests off read prs read and act permissions shared credentials",
  },
  {
    id: "server-updates",
    title: "Check for updates",
    page: "SettingsEnvironments",
    searchTerms: "server environment upgrade version restart refresh providers",
  },
  {
    id: "device-notifications",
    title: "Device Notifications",
    page: "SettingsNotifications",
    searchTerms: "push alerts agent activity completion",
  },
  {
    id: "live-activities",
    title: "Live Activity updates",
    page: "SettingsNotifications",
    searchTerms: "live activities lock screen dynamic island live updates ongoing agent activity",
  },
  {
    id: "color-scheme",
    title: "Color scheme",
    page: "SettingsAppearance",
    searchTerms: "system light dark mode",
  },
  {
    id: "theme",
    title: "Themes",
    page: "SettingsAppearance",
    searchTerms: `colors palette accent ${MOBILE_THEME_OPTIONS.map((theme) => theme.label).join(" ")}`,
  },
  {
    id: "text-size",
    title: "Text size",
    page: "SettingsAppearance",
    searchTerms: "font scale larger smaller typography",
  },
  {
    id: "terminal-font-size",
    title: "Terminal font size",
    page: "SettingsAppearance",
    searchTerms: "custom font size typography output",
  },
  {
    id: "code-font-size",
    title: "Code font size",
    page: "SettingsAppearance",
    searchTerms: "custom font size diffs typography",
  },
  {
    id: "word-break",
    title: "Word break",
    page: "SettingsAppearance",
    searchTerms: "wrap long lines code diffs",
  },
  {
    id: "return-key",
    title: "Return key",
    page: "SettingsKeyboard",
    searchTerms: "enter send message insert new line hardware keyboard composer",
  },
  {
    id: "microphone-access",
    title: "Microphone access",
    page: "SettingsMicrophone",
    searchTerms: "permission allow voice input dictation",
  },
  {
    id: "microphone-order",
    title: "Preferred microphone order",
    page: "SettingsMicrophone",
    searchTerms: "wired bluetooth airpods built-in carplay input device",
  },
  {
    id: "scheduled-tasks",
    title: "Scheduled tasks",
    page: "SettingsScheduledTasks",
    searchTerms: "automations recurring schedule cron interval webhook run now pause",
  },
  {
    id: "new-scheduled-task",
    title: "New scheduled task",
    page: "SettingsScheduledTasks",
    searchTerms: "create add automation",
  },
  {
    id: "project-overview",
    title: "Project overview",
    page: "SettingsProjectOverview",
    searchTerms: "project name rename checkouts",
  },
  {
    id: "project-grouping",
    title: "Project grouping",
    page: "SettingsOrganization",
    searchTerms: "group by repository repository path keep separate combine",
  },
  {
    id: "auto-resume-limited-threads",
    title: "Auto-resume limited threads",
    page: "SettingsThreads",
    searchTerms: "usage quota rate limit reset continue",
  },
  {
    id: "snooze-limited-threads",
    title: "Snooze limited threads",
    page: "SettingsThreads",
    searchTerms: "usage quota rate limit reset",
  },
  {
    id: "auto-settle-merged-threads",
    title: "Auto-settle merged threads",
    page: "SettingsThreads",
    searchTerms: "pull request merged closed automatically",
  },
  {
    id: "auto-settle-inactive-threads",
    title: "Auto-settle inactive threads",
    page: "SettingsThreads",
    searchTerms: "inactivity days before auto-settle automatically",
  },
  {
    id: "working-section",
    title: "Working section",
    page: "SettingsThreads",
    searchTerms: "beta running monitoring threads",
  },
  {
    id: "plan-mode",
    title: "Plan Mode",
    page: "SettingsThreads",
    searchTerms: "legacy build plan",
  },
  {
    id: "follow-up-behavior",
    title: "Follow-up behavior",
    page: "SettingsFollowUp",
    searchTerms: "queue steer while the agent is running send",
  },
  {
    id: "archived-threads",
    title: "Archived threads",
    page: "SettingsArchive",
    searchTerms: "restore unarchive delete history",
  },
  {
    id: "provider-accounts",
    title: "Provider accounts",
    page: "SettingsProviderAccounts",
    searchTerms: "sign in sign out login codex claude cursor opencode authentication",
  },
  {
    id: "default-workspace",
    title: "Default workspace",
    page: "SettingsEnvironmentNewThreads",
    searchTerms: "new threads current checkout new worktree inherit",
  },
  {
    id: "worktree-submodules",
    title: "Worktree submodules",
    page: "SettingsEnvironmentNewThreads",
    searchTerms: "git submodule recursive top level only skip",
  },
  {
    id: "default-permissions",
    title: "Default permissions",
    page: "SettingsEnvironmentNewThreads",
    searchTerms: "supervised auto-accept edits auto full access approvals runtime mode",
  },
  {
    id: "worktree-branch-naming",
    title: "Worktree branch naming",
    page: "SettingsEnvironmentSourceControl",
    searchTerms: "static semantic prefix custom instructions branch prefix",
  },
  {
    id: "remove-agent-credits",
    title: "Remove agent credits when merging",
    page: "SettingsEnvironmentSourceControl",
    searchTerms: "pull request github squash co-authored-by attribution",
  },
  {
    id: "automatic-pull",
    title: "Automatically pull",
    page: "SettingsEnvironmentSourceControl",
    searchTerms: "default branch fast forward upstream",
  },
  {
    id: "start-from-origin",
    title: "Start from origin",
    page: "SettingsEnvironmentSourceControl",
    searchTerms: "new worktrees remote branch base",
  },
  {
    id: "response-streaming",
    title: "Response streaming",
    page: "SettingsEnvironmentAgentBehavior",
    searchTerms: "after the turn finished paragraphs output",
  },
  {
    id: "agent-browser-access",
    title: "Agent browser access",
    page: "SettingsEnvironmentAgentBehavior",
    searchTerms: "preview browser in-app tools",
  },
  {
    id: "provider-updates",
    title: "Check provider updates",
    page: "SettingsEnvironmentMaintenance",
    searchTerms: "cli versions codex claude cursor opencode",
  },
  {
    id: "continue-after-restart",
    title: "Continue after restart",
    page: "SettingsEnvironmentMaintenance",
    searchTerms: "resume interrupted threads reboot crash",
  },
  {
    id: "usage",
    title: "Usage",
    page: "SettingsUsage",
    searchTerms: "cost tokens spend time range",
  },
  {
    id: "usage-limits",
    title: "Usage limits",
    page: "SettingsUsage",
    searchTerms: "quota rate limits reset codex claude",
  },
  {
    id: "version",
    title: "Version",
    page: "SettingsAbout",
    searchTerms: "about app build legal privacy terms",
  },
  {
    id: "client-storage",
    title: "Client Storage",
    page: "SettingsClientStorage",
    searchTerms: "cache clear caches disk space",
  },
  {
    id: "diagnostics",
    title: "Diagnostics",
    page: "SettingsDiagnostics",
    searchTerms: "crash report logs debug",
  },
  {
    id: "open-source-licenses",
    title: "Open source licenses",
    page: "SettingsOpenSourceLicenses",
    searchTerms: "acknowledgements third party notices",
  },
];

export function settingsSearchItemSection(item: SettingsSearchItem): SettingsSection {
  return settingsSectionForPage(item.page)!;
}

function normalizeSearchText(value: string) {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Ranked like desktop settings search: every word must match, titles outrank keywords. */
export function searchSettings<Item extends SettingsSearchItem>(
  query: string,
  items: ReadonlyArray<Item>,
): ReadonlyArray<Item> {
  const normalizedQuery = normalizeSearchText(query);
  if (normalizedQuery.length === 0) return [];
  const queryTokens = normalizedQuery.split(" ");
  return items
    .flatMap((item, index) => {
      const title = normalizeSearchText(item.title);
      const fields = [
        title,
        normalizeSearchText(SETTINGS_SECTION_LABELS[settingsSearchItemSection(item)]),
        normalizeSearchText(item.searchTerms ?? ""),
      ];
      if (!queryTokens.every((token) => fields.some((field) => field.includes(token)))) return [];
      const rank =
        title === normalizedQuery
          ? 5
          : title.startsWith(normalizedQuery)
            ? 4
            : title.includes(normalizedQuery)
              ? 3
              : queryTokens.every((token) => title.includes(token))
                ? 2
                : fields.some((field) => field.includes(normalizedQuery))
                  ? 1
                  : 0;
      return [{ item, index, rank }];
    })
    .sort((left, right) => right.rank - left.rank || left.index - right.index)
    .map(({ item }) => item);
}
