import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  HOST_API_VERSION,
  MarketplaceEntry,
  PluginInstallStaged,
  PluginLockfile,
  PluginManifest,
  hostApiSatisfies,
} from "./plugin.ts";

const decodeManifest = Schema.decodeUnknownSync(PluginManifest);
const decodeLockfile = Schema.decodeUnknownSync(PluginLockfile);
const encodeLockfile = Schema.encodeSync(PluginLockfile);
const decodeMarketplaceEntry = Schema.decodeUnknownSync(MarketplaceEntry);
const decodeInstallStaged = Schema.decodeUnknownSync(PluginInstallStaged);

const minimalManifest = {
  id: "test-plugin",
  name: "Test Plugin",
  version: "1.2.3",
  hostApi: "^1.0.0",
  entries: { server: "server.js" },
};

describe("PluginManifest", () => {
  it("decodes a minimal server manifest and defaults capabilities", () => {
    const decoded = decodeManifest(minimalManifest);
    expect(decoded.id).toBe("test-plugin");
    expect(decoded.capabilities).toEqual([]);
  });

  it("decodes a full manifest", () => {
    const decoded = decodeManifest({
      ...minimalManifest,
      name: "  Test Plugin  ",
      description: "Adds test plugin behavior.",
      author: { name: "T3", url: "https://example.test" },
      homepage: "https://example.test/plugin",
      license: "MIT",
      minAppVersion: "1.0.0",
      capabilities: ["agents", "database"],
      entries: { server: "dist/server.js", web: "dist/web.js" },
    });
    expect(decoded.name).toBe("Test Plugin");
    expect(decoded.capabilities).toEqual(["agents", "database"]);
  });

  it.each(["x", "1test-plugin", "test_plugin", "Test-Plugin", "a".repeat(42)])(
    "rejects invalid plugin id %s",
    (id) => {
      expect(() => decodeManifest({ ...minimalManifest, id })).toThrow();
    },
  );

  it("rejects unknown capabilities", () => {
    expect(() => decodeManifest({ ...minimalManifest, capabilities: ["not-real"] })).toThrow();
  });

  it("rejects duplicate capabilities", () => {
    expect(() =>
      decodeManifest({ ...minimalManifest, capabilities: ["agents", "agents"] }),
    ).toThrow();
  });

  it("rejects unknown top-level fields", () => {
    expect(() => decodeManifest({ ...minimalManifest, surprise: true })).toThrow();
  });

  it("rejects manifests without server or web entries", () => {
    expect(() => decodeManifest({ ...minimalManifest, entries: {} })).toThrow();
  });

  it("rejects web-only manifests with server capabilities", () => {
    expect(() =>
      decodeManifest({
        ...minimalManifest,
        capabilities: ["agents"],
        entries: { web: "web.js" },
      }),
    ).toThrow();
  });

  it("rejects unsafe entry paths", () => {
    expect(() =>
      decodeManifest({ ...minimalManifest, entries: { server: "../server.js" } }),
    ).toThrow();
    expect(() =>
      decodeManifest({ ...minimalManifest, entries: { server: "/server.js" } }),
    ).toThrow();
  });

  it("rejects bad hostApi ranges", () => {
    expect(() => decodeManifest({ ...minimalManifest, hostApi: ">=1.0.0" })).toThrow();
  });
});

describe("hostApiSatisfies", () => {
  it("matches exact, caret, and tilde ranges", () => {
    expect(hostApiSatisfies("1.0.0", HOST_API_VERSION)).toBe(true);
    expect(hostApiSatisfies("^1.0.0", "1.9.9")).toBe(true);
    expect(hostApiSatisfies("~1.0.0", "1.0.5")).toBe(true);
  });

  it("rejects versions outside the supported range", () => {
    expect(hostApiSatisfies("1.0.0", "1.0.1")).toBe(false);
    expect(hostApiSatisfies("^1.0.0", "2.0.0")).toBe(false);
    expect(hostApiSatisfies("~1.0.0", "1.1.0")).toBe(false);
    expect(hostApiSatisfies("^1.2.0", "1.1.9")).toBe(false);
  });
});

describe("PluginLockfile", () => {
  it("round-trips a decoded lockfile", () => {
    const decoded = decodeLockfile({
      sources: [{ id: "local", url: "file:///plugins", addedAt: "2026-07-03T00:00:00.000Z" }],
      plugins: {
        "test-plugin": {
          version: "1.2.3",
          sha256: "abc123",
          sourceId: "local",
          enabled: true,
          state: "active",
          activation: { activatingSince: null, crashCount: 0 },
          installedAt: "2026-07-03T00:00:00.000Z",
          lastError: null,
        },
      },
    });

    expect(encodeLockfile(decoded)).toEqual(decoded);
  });
});

describe("MarketplaceEntry", () => {
  it("decodes marketplace plugin versions", () => {
    const decoded = decodeMarketplaceEntry({
      id: "test-plugin",
      name: "Test Plugin",
      description: "Adds test plugin behavior.",
      capabilities: ["agents"],
      versions: [
        {
          version: "1.0.0",
          tarball: "https://example.test/plugin.tgz",
          sha256: "a".repeat(64),
          hostApi: "^1.0.0",
          minAppVersion: "0.0.1",
          publishedAt: "2026-07-03T00:00:00.000Z",
        },
      ],
    });

    expect(decoded.id).toBe("test-plugin");
    expect(decoded.versions[0]?.sha256).toBe("a".repeat(64));
  });
});

describe("PluginInstallStaged", () => {
  it("decodes staged install metadata with capability descriptions", () => {
    const decoded = decodeInstallStaged({
      stageToken: "token",
      manifest: {
        ...minimalManifest,
        capabilities: ["agents"],
      },
      capabilityDescriptions: {
        agents: "Run AI agents",
      },
    });

    expect(decoded.capabilityDescriptions.agents).toBe("Run AI agents");
  });
});
