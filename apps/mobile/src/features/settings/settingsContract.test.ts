import { describe, expect, it } from "vite-plus/test";

import {
  createArchiveSettingsRouteScreens,
  resolveSharedSettingsTailEntries,
  SETTINGS_ARCHIVE_ROUTE_CONTRACT,
  SETTINGS_WAITLIST_ALIAS_ROUTE_CONTRACT,
  SHARED_SETTINGS_TAIL_SECTION_IDS_BY_MODE,
} from "./settingsContract";

describe("native settings contract", () => {
  it.each(["local", "configured"] as const)("exposes archived threads in %s settings", (mode) => {
    expect(SHARED_SETTINGS_TAIL_SECTION_IDS_BY_MODE[mode]).toEqual([
      "general",
      "appearance",
      "beta",
      "archive",
      "app",
    ]);
  });

  it.each(["local", "configured"] as const)(
    "keeps the Archive section wired ahead of the upstream App update section in %s settings",
    (mode) => {
      expect(
        resolveSharedSettingsTailEntries(mode, {
          general: "GeneralSettingsSection",
          appearance: "AppearanceSettingsSection",
          beta: "BetaSettingsSection",
          archive: "ArchivedThreadsSettingsSection",
          app: "AppSettingsSection",
        }),
      ).toEqual([
        { id: "general", component: "GeneralSettingsSection" },
        { id: "appearance", component: "AppearanceSettingsSection" },
        { id: "beta", component: "BetaSettingsSection" },
        { id: "archive", component: "ArchivedThreadsSettingsSection" },
        { id: "app", component: "AppSettingsSection" },
      ]);
    },
  );

  it("keeps the archive route registered", () => {
    expect(SETTINGS_ARCHIVE_ROUTE_CONTRACT).toEqual({
      name: "SettingsArchive",
      linking: "archive",
      title: "Archived Threads",
    });
  });

  it("keeps the legacy waitlist alias alongside the archive route", () => {
    expect(SETTINGS_WAITLIST_ALIAS_ROUTE_CONTRACT).toEqual({
      name: "SettingsWaitlist",
      linking: "waitlist",
      title: "Sign in",
    });
    expect(SETTINGS_WAITLIST_ALIAS_ROUTE_CONTRACT.name).not.toBe(
      SETTINGS_ARCHIVE_ROUTE_CONTRACT.name,
    );
  });

  it("wires the Archive screen separately from the legacy waitlist alias", () => {
    const archiveScreen = Symbol("ArchivedThreadsRouteScreen");
    const authScreen = Symbol("SettingsAuthRouteScreen");
    const registrations = createArchiveSettingsRouteScreens({
      archiveScreen,
      waitlistAliasScreen: authScreen,
      createScreen: (definition) => definition,
    });

    expect(registrations).toEqual({
      SettingsArchive: {
        screen: archiveScreen,
        linking: "archive",
        options: {
          title: "Archived Threads",
        },
      },
      SettingsWaitlist: {
        screen: authScreen,
        linking: "waitlist",
        options: {
          title: "Sign in",
        },
      },
    });
    expect(registrations.SettingsArchive.screen).not.toBe(registrations.SettingsWaitlist.screen);
  });
});
