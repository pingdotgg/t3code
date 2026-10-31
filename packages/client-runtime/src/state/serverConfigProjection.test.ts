import type { ServerConfig, ServerConfigStreamEvent } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import { applyServerConfigProjection, reuseUnchanged } from "./serverConfigProjection.ts";

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
});

describe("applyServerConfigProjection memoryPressureUpdated", () => {
  it("keeps pressure and quiet runs across a reconnect snapshot from a server that sends them, and drops them once they end", () => {
    const pressure = (level: "none" | "severe") =>
      ({
        type: "memoryPressureUpdated",
        version: 1,
        payload: { level, heaviestAgents: [] },
      }) as ServerConfigStreamEvent;
    const snapshotFrom = (sendsEvents: boolean) =>
      ({
        type: "snapshot",
        version: 1,
        config: {
          environment: {
            capabilities: { memoryPressure: sendsEvents, quietRuns: sendsEvents },
          },
        },
      }) as ServerConfigStreamEvent;
    const snapshot = snapshotFrom(true);
    const calm = applyServerConfigProjection(
      applyServerConfigProjection(Option.none(), snapshot),
      pressure("none"),
    );
    expect(Option.isNone(calm)).toBe(true);
    const quietRuns = (threadIds: ReadonlyArray<string>) =>
      ({
        type: "quietRunsUpdated",
        version: 1,
        payload: { runs: threadIds.map((threadId) => ({ threadId, quietSince: 0 })) },
      }) as unknown as ServerConfigStreamEvent;
    const severe = applyServerConfigProjection(
      applyServerConfigProjection(
        applyServerConfigProjection(Option.none(), snapshot),
        pressure("severe"),
      ),
      quietRuns(["thread-a"]),
    );
    const reconnected = Option.getOrThrow(applyServerConfigProjection(severe, snapshot));
    expect(reconnected.config.memoryPressure?.level).toBe("severe");
    expect(reconnected.config.quietRuns?.map((run) => run.threadId)).toEqual(["thread-a"]);
    const olderServer = Option.getOrThrow(applyServerConfigProjection(severe, snapshotFrom(false)));
    expect(olderServer.config.memoryPressure).toBeUndefined();
    expect(olderServer.config.quietRuns).toBeUndefined();
    const ended = applyServerConfigProjection(
      applyServerConfigProjection(Option.some(reconnected), pressure("none")),
      quietRuns([]),
    );
    expect(Option.getOrThrow(ended).config.memoryPressure).toBeUndefined();
    expect(Option.getOrThrow(ended).config.quietRuns).toBeUndefined();
  });
});
