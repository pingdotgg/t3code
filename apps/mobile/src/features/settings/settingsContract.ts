export const SHARED_SETTINGS_TAIL_SECTION_IDS = [
  "general",
  "appearance",
  "legacy",
  "archive",
  "app",
] as const;

export type SharedSettingsTailSectionId = (typeof SHARED_SETTINGS_TAIL_SECTION_IDS)[number];

export type SettingsMode = "local" | "configured";

export const SHARED_SETTINGS_TAIL_SECTION_IDS_BY_MODE = {
  local: SHARED_SETTINGS_TAIL_SECTION_IDS,
  configured: SHARED_SETTINGS_TAIL_SECTION_IDS,
} as const;

export const SETTINGS_ARCHIVE_ROUTE_CONTRACT = {
  name: "SettingsArchive",
  linking: "archive",
  title: "Archived Threads",
} as const;

export const SETTINGS_WAITLIST_ALIAS_ROUTE_CONTRACT = {
  name: "SettingsWaitlist",
  linking: "waitlist",
  title: "Sign in",
} as const;
