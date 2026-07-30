export const SHARED_SETTINGS_TAIL_SECTION_IDS = [
  "general",
  "appearance",
  "beta",
  "archive",
  "app",
] as const;

export type SharedSettingsTailSectionId = (typeof SHARED_SETTINGS_TAIL_SECTION_IDS)[number];

export type SettingsMode = "local" | "configured";

export const SHARED_SETTINGS_TAIL_SECTION_IDS_BY_MODE = {
  local: SHARED_SETTINGS_TAIL_SECTION_IDS,
  configured: SHARED_SETTINGS_TAIL_SECTION_IDS,
} as const;

export function resolveSharedSettingsTailEntries<Component>(
  mode: SettingsMode,
  components: Readonly<Record<SharedSettingsTailSectionId, Component>>,
) {
  return SHARED_SETTINGS_TAIL_SECTION_IDS_BY_MODE[mode].map((id) => ({
    id,
    component: components[id],
  }));
}

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

export type SettingsRouteScreenDefinition<Screen> = {
  readonly screen: Screen;
  readonly linking: string;
  readonly options: {
    readonly title: string;
  };
};

export function createArchiveSettingsRouteScreens<Screen, RegisteredScreen>(input: {
  readonly archiveScreen: Screen;
  readonly waitlistAliasScreen: Screen;
  readonly createScreen: (definition: SettingsRouteScreenDefinition<Screen>) => RegisteredScreen;
}) {
  return {
    [SETTINGS_ARCHIVE_ROUTE_CONTRACT.name]: input.createScreen({
      screen: input.archiveScreen,
      linking: SETTINGS_ARCHIVE_ROUTE_CONTRACT.linking,
      options: {
        title: SETTINGS_ARCHIVE_ROUTE_CONTRACT.title,
      },
    }),
    [SETTINGS_WAITLIST_ALIAS_ROUTE_CONTRACT.name]: input.createScreen({
      screen: input.waitlistAliasScreen,
      linking: SETTINGS_WAITLIST_ALIAS_ROUTE_CONTRACT.linking,
      options: {
        title: SETTINGS_WAITLIST_ALIAS_ROUTE_CONTRACT.title,
      },
    }),
  } as const;
}
