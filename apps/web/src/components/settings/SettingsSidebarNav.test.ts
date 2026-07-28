import { describe, expect, it } from "@effect/vitest";

import { SETTINGS_NAV_GROUPS } from "./SettingsSidebarNav";

describe("settings navigation ownership", () => {
  it("separates client-owned pages from environment-owned pages", () => {
    expect(
      SETTINGS_NAV_GROUPS.map((group) => ({
        label: group.label,
        routes: group.items.map((item) => item.to),
      })),
    ).toEqual([
      {
        label: "Client",
        routes: [
          "/settings/general",
          "/settings/connections",
          "/settings/beta",
          "/settings/archived",
        ],
      },
      {
        label: "Environment",
        routes: [
          "/settings/environment",
          "/settings/keybindings",
          "/settings/providers",
          "/settings/source-control",
        ],
      },
    ]);
  });
});
