import {
  DEFAULT_SERVER_SETTINGS,
  ServerSettings,
  type ServerConfig,
  type ServerConfigStreamEvent,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { applyServerConfigProjection, reuseUnchanged } from "./serverConfigProjection.ts";

const encodeSettings = Schema.encodeSync(ServerSettings);
const decodeSettings = Schema.decodeSync(ServerSettings);

describe("reuseUnchanged", () => {
  const provider = (checkedAt: string, skills: ReadonlyArray<string>) => ({
    instanceId: "claude",
    checkedAt,
    models: [{ slug: "opus", name: "Opus" }],
    skills: skills.map((name) => ({ name })),
  });

  it("takes the new value when keys or lengths change", () => {
    const previous = [provider("a", ["x"])];
    const next = reuseUnchanged(previous, [provider("a", ["x", "z"])]);
    expect(next[0]!.skills).toHaveLength(2);
    expect(next[0]!.models).toBe(previous[0]!.models);
    const dropped = reuseUnchanged({ a: 1, b: 2 }, { a: 1 });
    expect(dropped).toEqual({ a: 1 });
  });
});

describe("applyServerConfigProjection settingsUpdated", () => {
  it("keeps unchanged settings sections when one field changes", () => {
    const settings = {
      favorites: [{ provider: "claude", model: "opus" }],
      providerInstances: {
        claude: { driver: "claudeAgent", config: { launchArgs: "" } },
        codex: { driver: "codex" },
      },
    };
    const current = Option.some({
      config: { settings } as unknown as ServerConfig,
      latestEvent: {} as ServerConfigStreamEvent,
      source: "live" as const,
    });
    const next = applyServerConfigProjection(current, {
      type: "settingsUpdated",
      payload: {
        settings: {
          favorites: [{ provider: "claude", model: "opus" }],
          providerInstances: {
            claude: { driver: "claudeAgent", config: { launchArgs: "--verbose" } },
            codex: { driver: "codex" },
          },
        },
      },
    } as unknown as ServerConfigStreamEvent);
    const nextSettings = Option.getOrThrow(next).config.settings as unknown as typeof settings;
    expect(nextSettings.favorites).toBe(settings.favorites);
    expect(nextSettings.providerInstances.codex).toBe(settings.providerInstances.codex);
    expect(nextSettings.providerInstances.claude.config.launchArgs).toBe("--verbose");
  });

  it("keeps the settings object when an update repeats the current settings", () => {
    const wire = encodeSettings(DEFAULT_SERVER_SETTINGS);
    const decode = () => decodeSettings(structuredClone(wire));
    const settings = decode();
    const current = Option.some({
      config: { settings } as unknown as ServerConfig,
      latestEvent: {} as ServerConfigStreamEvent,
      source: "live" as const,
    });
    const next = applyServerConfigProjection(current, {
      type: "settingsUpdated",
      payload: { settings: decode() },
    } as ServerConfigStreamEvent);
    expect(Option.getOrThrow(next).config).toBe(Option.getOrThrow(current).config);
  });

  it("follows the new-projects root and keeps it when an update omits it", () => {
    const settings = decodeSettings(encodeSettings(DEFAULT_SERVER_SETTINGS));
    const current = Option.some({
      config: { settings, newProjectsRoot: "/home/me/.t3/projects" } as unknown as ServerConfig,
      latestEvent: {} as ServerConfigStreamEvent,
      source: "live" as const,
    });
    const moved = applyServerConfigProjection(current, {
      type: "settingsUpdated",
      payload: { settings, newProjectsRoot: "/home/me/repos", newProjectsRootIsCustom: true },
    } as ServerConfigStreamEvent);
    expect(Option.getOrThrow(moved).config.newProjectsRoot).toBe("/home/me/repos");
    expect(Option.getOrThrow(moved).config.newProjectsRootIsCustom).toBe(true);
    const fromOlderServer = applyServerConfigProjection(moved, {
      type: "settingsUpdated",
      payload: { settings },
    } as ServerConfigStreamEvent);
    expect(Option.getOrThrow(fromOlderServer).config.newProjectsRoot).toBe("/home/me/repos");
    expect(Option.getOrThrow(fromOlderServer).config.newProjectsRootIsCustom).toBe(true);
  });
});
