import { PluginId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { EMPTY_PLUGIN_UI_REGISTRY_SNAPSHOT } from "./PluginUiHost";
import { getVisiblePluginSidebarSections } from "./PluginSidebarSections";

describe("PluginSidebarSections", () => {
  it("renders no sidebar sections for the zero-plugin registry", () => {
    expect(getVisiblePluginSidebarSections(EMPTY_PLUGIN_UI_REGISTRY_SNAPSHOT)).toEqual([]);
  });

  it("returns registered sidebar sections in registry order", () => {
    const pluginId = PluginId.make("fixture-plugin");

    expect(
      getVisiblePluginSidebarSections({
        ...EMPTY_PLUGIN_UI_REGISTRY_SNAPSHOT,
        sidebarSections: [
          {
            pluginId,
            id: "main",
            title: "Fixture",
            render: () => null,
          },
        ],
      }),
    ).toEqual([
      {
        pluginId,
        id: "main",
        title: "Fixture",
        render: expect.any(Function),
      },
    ]);
  });
});
