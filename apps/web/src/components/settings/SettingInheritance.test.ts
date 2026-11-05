import { DEFAULT_SERVER_SETTINGS, EnvironmentId, ProjectId } from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { describe, expect, it } from "vite-plus/test";

import { settingInheritanceLayers } from "./SettingInheritance";

const environmentId = EnvironmentId.make("laptop");
const projectId = ProjectId.make("project");

describe("settingInheritanceLayers", () => {
  it("identifies the background activity profile supplied by each layer", () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      backgroundActivity: {
        schemaVersion: 1 as const,
        profile: "performance" as const,
        overrides: {},
      },
    };
    const layers = settingInheritanceLayers(
      {
        environmentId,
        label: "Laptop",
        projectId: null,
        ...resolveProjectSettings(settings, projectId),
      },
      settings,
      "backgroundActivity",
    );
    expect(layers.map((layer) => [layer.key, layer.value, layer.effective])).toEqual([
      ["environment", "Performance", true],
      ["built-in", "Balanced", false],
    ]);
  });
});
