import {
  PluginCommandName,
  PluginId,
  PluginSourceId,
  type PluginCatalog,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import { findPluginPage, pluginPageContributions } from "./pluginCatalog";

const catalog: PluginCatalog = {
  pluginsDirectory: "/tmp/plugins",
  issues: [],
  sources: [
    {
      id: PluginSourceId.make("team-tools"),
      gitUrl: "https://example.com/team-tools.git",
      directory: "/tmp/plugins/.sources/team-tools",
      pluginIds: [PluginId.make("sourced")],
    },
  ],
  plugins: [
    {
      schemaVersion: 1,
      id: PluginId.make("enabled"),
      name: "Enabled",
      enabled: true,
      commands: [
        {
          name: PluginCommandName.make("home"),
          title: "Home",
          entry: "dist/home.html",
        },
        {
          name: PluginCommandName.make("logs"),
          title: "Logs",
          entry: "dist/logs.html",
        },
      ],
    },
    {
      schemaVersion: 1,
      id: PluginId.make("disabled"),
      name: "Disabled",
      enabled: false,
      commands: [
        {
          name: PluginCommandName.make("home"),
          title: "Home",
          entry: "dist/home.html",
        },
      ],
    },
    {
      schemaVersion: 1,
      id: PluginId.make("sourced"),
      name: "Sourced",
      enabled: true,
      sourceId: PluginSourceId.make("team-tools"),
      commands: [
        {
          name: PluginCommandName.make("home"),
          title: "Shared home",
          entry: "dist/home.html",
        },
      ],
    },
  ],
};

describe("pluginPageContributions", () => {
  it("flattens enabled view commands and omits disabled plugins", () => {
    expect(
      pluginPageContributions(catalog).map((page) => `${page.plugin.id}:${page.command.name}`),
    ).toEqual(["enabled:home", "enabled:logs", "sourced:home"]);
  });

  it("contributes pages for plugins provided by a source repository", () => {
    const page = findPluginPage(catalog, "sourced", "home");
    expect(page?.command.title).toBe("Shared home");
    expect(page?.plugin.sourceId).toBe("team-tools");
  });

  it("finds a page by plugin and command", () => {
    expect(findPluginPage(catalog, "enabled", "logs")?.command.title).toBe("Logs");
    expect(findPluginPage(catalog, "disabled", "home")).toBeNull();
  });
});
