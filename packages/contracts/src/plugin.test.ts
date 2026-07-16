import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  HOST_API_VERSION,
  MarketplaceEntry,
  PluginInstallStaged,
  PluginLockfile,
  PluginManifest,
  compareSemver,
  hostApiSatisfies,
  isPrereleaseVersion,
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
      capabilities: ["agents", "database", "filesystem", "httpClient", "tools"],
      entries: { server: "dist/server.js", web: "web/index.js" },
    });
    expect(decoded.name).toBe("Test Plugin");
    expect(decoded.capabilities).toEqual([
      "agents",
      "database",
      "filesystem",
      "httpClient",
      "tools",
    ]);
  });

  it("accepts the tools capability", () => {
    const decoded = decodeManifest({
      ...minimalManifest,
      capabilities: ["tools"],
    });
    expect(decoded.capabilities).toEqual(["tools"]);
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
        entries: { web: "web/index.js" },
      }),
    ).toThrow();
  });

  it("rejects a non-canonical web entry path", () => {
    expect(() =>
      decodeManifest({ ...minimalManifest, entries: { web: "assets/main.js" } }),
    ).toThrow(/entries\.web must be "web\/index\.js"/);
  });

  it("accepts the canonical web entry path", () => {
    const decoded = decodeManifest({
      ...minimalManifest,
      entries: { server: "server.js", web: "web/index.js" },
    });
    expect(decoded.entries.web).toBe("web/index.js");
  });

  it("rejects a non-canonical styles entry path", () => {
    expect(() =>
      decodeManifest({
        ...minimalManifest,
        entries: { server: "server.js", web: "web/index.js", styles: "assets/main.css" },
      }),
    ).toThrow(/entries\.styles must be "web\/index\.css"/);
  });

  it("accepts the canonical styles entry path", () => {
    const decoded = decodeManifest({
      ...minimalManifest,
      entries: { server: "server.js", web: "web/index.js", styles: "web/index.css" },
    });
    expect(decoded.entries.styles).toBe("web/index.css");
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

  it.each([
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "file:///etc/passwd",
    "not a url",
  ])("rejects non-http(s) author and homepage URLs: %s", (url) => {
    expect(() =>
      decodeManifest({ ...minimalManifest, author: { name: "Mallory", url } }),
    ).toThrow();
    expect(() => decodeManifest({ ...minimalManifest, homepage: url })).toThrow();
  });

  it("accepts http(s) author and homepage URLs", () => {
    const decoded = decodeManifest({
      ...minimalManifest,
      author: { name: "T3", url: "https://example.test/team" },
      homepage: "http://example.test/plugin",
    });
    expect(decoded.author?.url).toBe("https://example.test/team");
    expect(decoded.homepage).toBe("http://example.test/plugin");
  });
});

describe("MarketplaceEntry author url", () => {
  it("rejects javascript: author URLs in marketplace entries", () => {
    expect(() =>
      decodeMarketplaceEntry({
        id: "test-plugin",
        name: "Test Plugin",
        description: "Adds test plugin behavior.",
        author: { name: "Mallory", url: "javascript:alert(1)" },
        capabilities: [],
        versions: [],
      }),
    ).toThrow();
  });
});

describe("compareSemver", () => {
  it("orders by semver precedence with prerelease support", () => {
    expect(compareSemver("1.0.0", "0.9.9")).toBeGreaterThan(0);
    expect(compareSemver("1.0.0-rc.1", "1.0.0")).toBeLessThan(0);
    expect(compareSemver("1.0.0-rc.2", "1.0.0-rc.10")).toBeLessThan(0);
    expect(compareSemver("1.0.0+build1", "1.0.0+build2")).toBe(0);
  });
});

describe("isPrereleaseVersion", () => {
  it("detects prerelease components and ignores build metadata", () => {
    expect(isPrereleaseVersion("1.1.0-rc.1")).toBe(true);
    expect(isPrereleaseVersion("1.1.0")).toBe(false);
    expect(isPrereleaseVersion("1.1.0+build5")).toBe(false);
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
        filesystem:
          "Read and write files in your project workspace and in worktrees this plugin creates",
        httpClient: "Make requests to public external HTTPS services",
      },
    });

    expect(decoded.capabilityDescriptions.agents).toBe("Run AI agents");
    expect(decoded.capabilityDescriptions.filesystem).toContain("Read and write files");
    expect(decoded.capabilityDescriptions.httpClient).toContain("HTTPS services");
  });
});
