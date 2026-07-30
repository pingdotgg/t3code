import { describe, expect, it } from "vite-plus/test";

import {
  SETTINGS_DEFAULT_PATH,
  SETTINGS_NAV_ITEMS,
  resolveSettingsPathname,
} from "./settingsNavigation";

describe("Forma settings navigation", () => {
  it("uses Interface as the default and does not expose upstream Appearance", () => {
    expect(SETTINGS_DEFAULT_PATH).toBe("/settings/interface");
    expect(SETTINGS_NAV_ITEMS.map((item) => item.label)).toEqual([
      "Interface",
      "Threads",
      "Notifications",
      "Providers",
      "Safety",
      "Source Control",
      "Connections",
      "Advanced",
    ]);
  });

  it("maps legacy General and Archive routes into the Forma sections", () => {
    expect(resolveSettingsPathname("/settings/general")).toBe("/settings/interface");
    expect(resolveSettingsPathname("/settings/archived")).toBe("/settings/threads");
  });
});
