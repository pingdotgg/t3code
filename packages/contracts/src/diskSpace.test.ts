import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { diskSpaceLevel, nextDiskSpaceLevel, type DiskSpaceLevel } from "./diskSpace.ts";
import { ServerConfig } from "./server.ts";

const GiB = 1024 ** 3;
const decodeServerConfig = Schema.decodeSync(ServerConfig);
const disk = (availableGiB: number, totalGiB = 4_000) => ({
  availableBytes: availableGiB * GiB,
  totalBytes: totalGiB * GiB,
});

describe("diskSpaceLevel", () => {
  it.each([
    // 96% used, yet 160 GiB free is plenty.
    { volume: disk(160), level: "ok" },
    { volume: disk(15), level: "low" },
    { volume: disk(4), level: "critical" },
    // A 16 GiB volume scales the floors down to its size.
    { volume: disk(4, 16), level: "ok" },
    { volume: disk(2, 16), level: "low" },
    { volume: disk(0.5, 16), level: "critical" },
    { volume: { availableBytes: 0, totalBytes: 0 }, level: "ok" },
  ] as const)("$volume.availableBytes of $volume.totalBytes is $level", ({ volume, level }) => {
    expect(diskSpaceLevel(volume)).toBe(level);
  });
});

describe("nextDiskSpaceLevel", () => {
  it.each<{ previous: DiskSpaceLevel; availableGiB: number; next: DiskSpaceLevel }>([
    // Worsening applies at once.
    { previous: "ok", availableGiB: 19.9, next: "low" },
    { previous: "low", availableGiB: 4.9, next: "critical" },
    { previous: "ok", availableGiB: 4, next: "critical" },
    // Hovering just above a floor keeps the level it entered.
    { previous: "low", availableGiB: 20.5, next: "low" },
    { previous: "critical", availableGiB: 5.2, next: "critical" },
    // Clearing the floor by the margin leaves it.
    { previous: "low", availableGiB: 22.5, next: "ok" },
    { previous: "critical", availableGiB: 5.6, next: "low" },
    // Clearing both floors at once skips straight to ok.
    { previous: "critical", availableGiB: 100, next: "ok" },
  ])("$previous with $availableGiB GiB free is $next", ({ previous, availableGiB, next }) => {
    expect(nextDiskSpaceLevel(previous, disk(availableGiB))).toBe(next);
  });
});

describe("ServerConfig diskSpace", () => {
  it("decodes a config from a server that never sends it", () => {
    const config = decodeServerConfig({
      environment: {
        environmentId: "env",
        label: "env",
        platform: { os: "linux", arch: "x64" },
        serverVersion: "0.1.0",
        capabilities: { repositoryIdentity: true },
      },
      auth: {
        policy: "loopback-browser",
        bootstrapMethods: [],
        sessionMethods: [],
        sessionCookieName: "test",
      },
      cwd: "/test",
      keybindingsConfigPath: "/test/keybindings.json",
      keybindings: [],
      issues: [],
      providers: [],
      availableEditors: [],
      observability: {
        logsDirectoryPath: "/test/logs",
        localTracingEnabled: false,
        otlpTracesEnabled: false,
        otlpMetricsEnabled: false,
      },
      settings: {},
    });
    expect(config.diskSpace).toBeUndefined();
  });
});
