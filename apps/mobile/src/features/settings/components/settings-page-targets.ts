/** Settings pages a Settings row opens. */
export const SETTINGS_PAGE_TARGETS = [
  "SettingsEnvironments",
  "SettingsNotifications",
  "SettingsThreads",
  "SettingsAbout",
  "SettingsArchive",
  "SettingsAppearance",
  "SettingsNavigation",
  "SettingsOrganization",
  "SettingsProjectOverview",
  "SettingsEnvironmentSourceControl",
  "SettingsWorktrees",
  "SettingsLabs",
  "SettingsEnvironmentMaintenance",
  "SettingsProviderAccounts",
  "SettingsKeyboard",
  "SettingsMicrophone",
  "SettingsFollowUp",
  "SettingsScheduledTasks",
  "SettingsProjectGrouping",
  "SettingsClientStorage",
  "SettingsDiagnostics",
  "SettingsOpenSourceLicenses",
  "SettingsUsage",
] as const;

export type SettingsPageTarget = (typeof SETTINGS_PAGE_TARGETS)[number];

export type SettingsLegalDocumentTarget = "SettingsLegal";
