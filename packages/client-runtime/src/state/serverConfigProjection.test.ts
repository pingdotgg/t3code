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
});

describe("applyServerConfigProjection provider catalogs", () => {
  const provider = (fields: Record<string, unknown>) =>
    ({
      instanceId: "claude",
      checkedAt: "a",
      models: [],
      ...fields,
    }) as unknown as ServerConfig["providers"][number];
  const projection = (providers: ServerConfig["providers"]) =>
    Option.some({
      config: { providers } as unknown as ServerConfig,
      latestEvent: {} as ServerConfigStreamEvent,
      source: "cache" as const,
    });
  const apply = (current: ReturnType<typeof projection>, event: unknown) =>
    Option.getOrThrow(applyServerConfigProjection(current, event as ServerConfigStreamEvent)).config
      .providers[0]!;

  it("keeps held slash commands and skills when the server sends a digest in their place", () => {
    const slashCommands = [{ name: "compact" }];
    const skills = [{ name: "review", path: "/skills/review", enabled: true }];
    const held = provider({
      slashCommands,
      skills,
      catalogDigest: "d1",
      loadedCatalogDigest: "d1",
    });
    const sent = (fields: Record<string, unknown>) =>
      provider({ slashCommands: [], skills: [], catalogDigest: "d1", ...fields });

    const reconnected = apply(projection([held]), {
      type: "snapshot",
      config: { providers: [sent({ checkedAt: "b" })] },
    });
    expect(reconnected).toMatchObject({ checkedAt: "b", loadedCatalogDigest: "d1" });
    expect(reconnected.slashCommands).toBe(slashCommands);
    expect(reconnected.skills).toBe(skills);

    // A changed catalog keeps the stale lists; the old marker says they need a reload.
    const { slashCommands: _c, skills: _s, ...delta } = sent({ catalogDigest: "d2" });
    const changed = apply(projection([held]), {
      type: "providerStatusDeltas",
      payload: { providers: [delta] },
    });
    expect(changed).toMatchObject({ catalogDigest: "d2", loadedCatalogDigest: "d1" });
    expect(changed.skills).toBe(skills);

    // Lists cached before digests existed carry over without a marker.
    const legacy = apply(projection([provider({ slashCommands, skills })]), {
      type: "providerStatuses",
      payload: { providers: [sent({})] },
    });
    expect(legacy.slashCommands).toBe(slashCommands);
    expect(legacy.loadedCatalogDigest).toBeUndefined();
  });
});
