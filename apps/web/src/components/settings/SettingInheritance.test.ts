import { DEFAULT_SERVER_SETTINGS, EnvironmentId, ProjectId } from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { describe, expect, it } from "vite-plus/test";

import { settingInheritanceLayers } from "./SettingInheritance";

const environmentId = EnvironmentId.make("laptop");
const projectId = ProjectId.make("project");

describe("settingInheritanceLayers", () => {
  it("marks the built-in default effective when nothing is set", () => {
    const resolved = resolveProjectSettings(DEFAULT_SERVER_SETTINGS, null);
    const layers = settingInheritanceLayers(
      { environmentId, label: "Laptop", projectId: null, ...resolved },
      DEFAULT_SERVER_SETTINGS,
      "defaultAutoPull",
    );
    expect(layers.map((layer) => [layer.label, layer.value, layer.effective])).toEqual([
      ["Laptop", "Inherits", false],
      ["Default", "Off", true],
    ]);
  });

  it("walks project override, environment value, then built-in default", () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      defaultAutoPull: true,
      projectSettingsOverrides: { [projectId]: { defaultAutoPull: false } },
    };
    const resolved = resolveProjectSettings(settings, projectId);
    const layers = settingInheritanceLayers(
      { environmentId, label: "Laptop", projectId, ...resolved },
      settings,
      "defaultAutoPull",
    );
    expect(layers.map((layer) => [layer.label, layer.value, layer.effective])).toEqual([
      ["Project", "Off", true],
      ["Laptop", "On", false],
      ["Default", "Off", false],
    ]);
    const inherited = settingInheritanceLayers(
      {
        environmentId,
        label: "Laptop",
        projectId,
        ...resolveProjectSettings(settings, ProjectId.make("other")),
      },
      settings,
      "defaultAutoPull",
    );
    expect(inherited.map((layer) => [layer.value, layer.effective])).toEqual([
      ["Inherits", false],
      ["On", true],
      ["Off", false],
    ]);
  });

  it("shows the checkout's t3.json as a layer for file-backed keys", () => {
    const file = { defaultThreadEnvMode: "worktree" as const };
    const fromFile = settingInheritanceLayers(
      {
        environmentId,
        label: "Laptop",
        projectId,
        ...resolveProjectSettings(DEFAULT_SERVER_SETTINGS, projectId, null, file),
      },
      DEFAULT_SERVER_SETTINGS,
      "defaultThreadEnvMode",
    );
    expect(fromFile.map((layer) => [layer.label, layer.value, layer.effective])).toEqual([
      ["Project", "Inherits", false],
      ["Laptop", "Inherits", false],
      ["t3.json", "New worktree", true],
      ["Default", "Current checkout", false],
    ]);
    const settings = { ...DEFAULT_SERVER_SETTINGS, defaultThreadEnvMode: "local" as const };
    const fromEnvironment = settingInheritanceLayers(
      {
        environmentId,
        label: "Laptop",
        projectId,
        ...resolveProjectSettings(settings, projectId, null, file),
      },
      settings,
      "defaultThreadEnvMode",
    );
    expect(fromEnvironment.map((layer) => [layer.value, layer.effective])).toEqual([
      ["Inherits", false],
      ["Current checkout", true],
      ["Inherits", false],
      ["Current checkout", false],
    ]);
  });

  it("resolves one storage cleanup rule per environment", () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      storageCleanup: { ...DEFAULT_SERVER_SETTINGS.storageCleanup, logsAfterDays: 30 },
    };
    const layers = (field: "logsAfterDays" | "worktreeOnMerge") =>
      settingInheritanceLayers(
        {
          environmentId,
          label: "Laptop",
          projectId: null,
          ...resolveProjectSettings(settings, null),
        },
        settings,
        "storageCleanup",
        field,
      ).map((layer) => [layer.label, layer.value, layer.effective]);
    expect(layers("logsAfterDays")).toEqual([
      ["Laptop", "30 days", true],
      ["Default", "Off", false],
    ]);
    // Another rule on the same environment is still at its default.
    expect(layers("worktreeOnMerge")).toEqual([
      ["Laptop", "Inherits", false],
      ["Default", "Off", true],
    ]);
  });

  it("reads worktree rules through the environment's cleanup policy", () => {
    const layers = (
      worktreeCleanup: (typeof DEFAULT_SERVER_SETTINGS)["worktreeCleanup"],
      field: "worktreeOnMerge" | "worktreeKeepWhen",
    ) => {
      const settings = {
        ...DEFAULT_SERVER_SETTINGS,
        storageCleanup: {
          ...DEFAULT_SERVER_SETTINGS.storageCleanup,
          worktreeOnMerge: true,
          worktreeKeepWhen: "tracked-changes" as const,
        },
        worktreeCleanup,
      };
      return settingInheritanceLayers(
        {
          environmentId,
          label: "Laptop",
          projectId: null,
          ...resolveProjectSettings(settings, null),
        },
        settings,
        "storageCleanup",
        field,
      ).map((layer) => [layer.label, layer.value, layer.effective]);
    };
    expect(layers({ mode: "off" }, "worktreeOnMerge")).toEqual([
      ["Laptop", "Inherits", false],
      ["Default", "Off", true],
    ]);
    expect(
      layers(
        {
          mode: "custom",
          rules: {
            ...DEFAULT_SERVER_SETTINGS.storageCleanup,
            worktreeOnMerge: false,
            worktreeKeepWhen: "any-local-files",
          },
        },
        "worktreeKeepWhen",
      ),
    ).toEqual([
      ["Laptop", "Any local files", true],
      ["Default", "Uncommitted changes", false],
    ]);
  });
});
