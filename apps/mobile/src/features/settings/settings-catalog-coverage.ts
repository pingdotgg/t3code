import type { SettingsSectionId } from "@t3tools/client-runtime/settings/catalog";

import type { SettingsPageTarget } from "./components/settings-page-targets";

/** Maps catalog section ids to the mobile route that implements them. */
export const MOBILE_SETTINGS_PAGE_BY_SECTION = {
  general: "SettingsOrganization",
  appearance: "SettingsAppearance",
  chat: "SettingsFollowUp",
  diffs: "SettingsDiffs",
  voice: "SettingsVoice",
  navigation: "SettingsNavigation",
  keyboard: "SettingsKeyboard",
  notifications: "SettingsNotifications",
  providers: "SettingsProviderAccounts",
  threads: "SettingsThreads",
  browser: "SettingsBrowser",
  devices: "SettingsDevices",
  "scheduled-tasks": "SettingsScheduledTasks",
  projects: "SettingsProjectOverview",
  "source-control": "SettingsEnvironmentSourceControl",
  worktrees: "SettingsWorktrees",
  connections: "SettingsEnvironments",
  access: "SettingsAccess",
  secrets: "SettingsSecrets",
  maintenance: "SettingsEnvironmentMaintenance",
  labs: "SettingsLabs",
  about: "SettingsAbout",
  archived: "SettingsArchive",
  diagnostics: "SettingsDiagnostics",
} as const satisfies Partial<Record<SettingsSectionId, SettingsPageTarget>>;

export const MOBILE_IMPLEMENTED_SETTINGS_SECTIONS = new Set<SettingsSectionId>(
  Object.keys(MOBILE_SETTINGS_PAGE_BY_SECTION) as SettingsSectionId[],
);
