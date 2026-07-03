import { PluginId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { EMPTY_PLUGIN_UI_REGISTRY_SNAPSHOT } from "../../plugins/PluginUiHost";
import { getSettingsNavItems } from "./SettingsSidebarNav";

describe("SettingsSidebarNav plugin entries", () => {
  it("keeps the core settings navigation unchanged when no plugins register pages", () => {
    expect(getSettingsNavItems(EMPTY_PLUGIN_UI_REGISTRY_SNAPSHOT).map((item) => item.to)).toEqual([
      "/settings/general",
      "/settings/keybindings",
      "/settings/providers",
      "/settings/source-control",
      "/settings/connections",
      "/settings/archived",
    ]);
  });

  it("adds registered plugin settings pages after core items", () => {
    expect(
      getSettingsNavItems({
        ...EMPTY_PLUGIN_UI_REGISTRY_SNAPSHOT,
        settingsPages: [
          {
            pluginId: PluginId.make("fixture-plugin"),
            id: "general",
            title: "Fixture",
            component: () => null,
          },
        ],
      }).map((item) => item.to),
    ).toEqual([
      "/settings/general",
      "/settings/keybindings",
      "/settings/providers",
      "/settings/source-control",
      "/settings/connections",
      "/settings/archived",
      "/settings/fixture-plugin/general",
    ]);
  });
});
