import { describe, expect, it } from "vite-plus/test";

import {
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
});
