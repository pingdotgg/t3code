import { describe, expect, it, vi } from "vite-plus/test";

const routeScreens = vi.hoisted(() => ({
  archive: Symbol("ArchivedThreadsRouteScreen"),
  waitlistAlias: Symbol("SettingsAuthRouteScreen"),
}));

vi.mock("@react-navigation/native-stack", () => ({
  createNativeStackScreen: vi.fn((definition: unknown) => definition),
}));

vi.mock("../archive/ArchivedThreadsRouteScreen", () => ({
  ArchivedThreadsRouteScreen: routeScreens.archive,
}));

vi.mock("./SettingsAuthRouteScreen", () => ({
  SettingsAuthRouteScreen: routeScreens.waitlistAlias,
}));

import {
  SETTINGS_ARCHIVE_ROUTE_CONTRACT,
  SETTINGS_WAITLIST_ALIAS_ROUTE_CONTRACT,
  SHARED_SETTINGS_TAIL_SECTION_IDS_BY_MODE,
} from "./settingsContract";
import { SETTINGS_CUSTOM_ROUTE_SCREENS_BY_STACK } from "./settingsRouteScreens";

describe("native settings contract", () => {
  it.each(["local", "configured"] as const)("exposes archived threads in %s settings", (mode) => {
    expect(SHARED_SETTINGS_TAIL_SECTION_IDS_BY_MODE[mode]).toEqual([
      "general",
      "appearance",
      "legacy",
      "archive",
      "app",
    ]);
  });

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

  it("keeps Archive in the content stack and the waitlist alias in the auth stack", () => {
    expect(SETTINGS_CUSTOM_ROUTE_SCREENS_BY_STACK).toEqual({
      content: {
        [SETTINGS_ARCHIVE_ROUTE_CONTRACT.name]: {
          screen: routeScreens.archive,
          linking: SETTINGS_ARCHIVE_ROUTE_CONTRACT.linking,
          options: {
            title: SETTINGS_ARCHIVE_ROUTE_CONTRACT.title,
          },
        },
      },
      auth: {
        [SETTINGS_WAITLIST_ALIAS_ROUTE_CONTRACT.name]: {
          screen: routeScreens.waitlistAlias,
          linking: SETTINGS_WAITLIST_ALIAS_ROUTE_CONTRACT.linking,
          options: {
            title: SETTINGS_WAITLIST_ALIAS_ROUTE_CONTRACT.title,
          },
        },
      },
    });
  });
});
