import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readEnabledPluginKeys, resolveEnabledPlugins } from "./claude-plugins";

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeJson(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data), "utf8");
}

function mkPluginVersion(cacheRoot: string, marketplace: string, plugin: string, version: string) {
  const dir = path.join(cacheRoot, marketplace, plugin, version);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

describe("readEnabledPluginKeys", () => {
  let homeDir: string;
  let cwd: string;

  beforeEach(() => {
    homeDir = makeTempDir("claude-plugin-test-home-");
    cwd = makeTempDir("claude-plugin-test-cwd-");
  });

  afterEach(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("reads enabledPlugins from user settings", () => {
    writeJson(path.join(homeDir, ".claude", "settings.json"), {
      enabledPlugins: { "my-plugin@my-marketplace": true },
    });

    const result = readEnabledPluginKeys({ homeDir, cwd });
    expect(result.get("my-plugin@my-marketplace")).toBe(true);
  });

  it("merges user, project, and local settings", () => {
    writeJson(path.join(homeDir, ".claude", "settings.json"), {
      enabledPlugins: { "a@m": true, "b@m": true },
    });
    writeJson(path.join(cwd, ".claude", "settings.json"), {
      enabledPlugins: { "c@m": true },
    });
    writeJson(path.join(cwd, ".claude", "settings.local.json"), {
      enabledPlugins: { "d@m": true },
    });

    const result = readEnabledPluginKeys({ homeDir, cwd });
    expect([...result.keys()].toSorted()).toEqual(["a@m", "b@m", "c@m", "d@m"]);
  });

  it("later source overrides earlier with false", () => {
    writeJson(path.join(homeDir, ".claude", "settings.json"), {
      enabledPlugins: { "plugin@market": true },
    });
    writeJson(path.join(cwd, ".claude", "settings.json"), {
      enabledPlugins: { "plugin@market": false },
    });

    const result = readEnabledPluginKeys({ homeDir, cwd });
    expect(result.get("plugin@market")).toBe(false);
  });

  it("skips malformed JSON gracefully", () => {
    fs.mkdirSync(path.join(homeDir, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(homeDir, ".claude", "settings.json"), "{ broken", "utf8");

    const result = readEnabledPluginKeys({ homeDir, cwd });
    expect(result.size).toBe(0);
  });

  it("skips missing files gracefully", () => {
    const result = readEnabledPluginKeys({ homeDir, cwd });
    expect(result.size).toBe(0);
  });

  it("ignores non-boolean values in enabledPlugins", () => {
    writeJson(path.join(homeDir, ".claude", "settings.json"), {
      enabledPlugins: { "a@m": true, "b@m": "yes", "c@m": 1 },
    });

    const result = readEnabledPluginKeys({ homeDir, cwd });
    expect(result.size).toBe(1);
    expect(result.get("a@m")).toBe(true);
  });
});

describe("resolveEnabledPlugins", () => {
  let homeDir: string;
  let cwd: string;
  let cacheRoot: string;

  beforeEach(() => {
    homeDir = makeTempDir("claude-plugin-test-home-");
    cwd = makeTempDir("claude-plugin-test-cwd-");
    cacheRoot = path.join(homeDir, ".claude", "plugins", "cache");
  });

  afterEach(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("resolves an enabled plugin to its cache path", () => {
    writeJson(path.join(homeDir, ".claude", "settings.json"), {
      enabledPlugins: { "my-plugin@my-market": true },
    });
    const versionDir = mkPluginVersion(cacheRoot, "my-market", "my-plugin", "1.0.0");

    const result = resolveEnabledPlugins({ homeDir, cwd });
    expect(result).toEqual([
      { pluginId: "my-plugin", marketplaceId: "my-market", path: fs.realpathSync(versionDir) },
    ]);
  });

  it("skips orphaned versions", () => {
    writeJson(path.join(homeDir, ".claude", "settings.json"), {
      enabledPlugins: { "plugin@market": true },
    });
    const oldDir = mkPluginVersion(cacheRoot, "market", "plugin", "1.0.0");
    fs.writeFileSync(path.join(oldDir, ".orphaned_at"), "2025-01-01T00:00:00Z", "utf8");
    const newDir = mkPluginVersion(cacheRoot, "market", "plugin", "2.0.0");

    const result = resolveEnabledPlugins({ homeDir, cwd });
    expect(result).toHaveLength(1);
    expect(result[0]!.path).toBe(fs.realpathSync(newDir));
  });

  it("returns empty array when all versions are orphaned", () => {
    writeJson(path.join(homeDir, ".claude", "settings.json"), {
      enabledPlugins: { "plugin@market": true },
    });
    const dir = mkPluginVersion(cacheRoot, "market", "plugin", "1.0.0");
    fs.writeFileSync(path.join(dir, ".orphaned_at"), "2025-01-01T00:00:00Z", "utf8");

    const result = resolveEnabledPlugins({ homeDir, cwd });
    expect(result).toEqual([]);
  });

  it("skips disabled plugins", () => {
    writeJson(path.join(homeDir, ".claude", "settings.json"), {
      enabledPlugins: { "plugin@market": false },
    });
    mkPluginVersion(cacheRoot, "market", "plugin", "1.0.0");

    const result = resolveEnabledPlugins({ homeDir, cwd });
    expect(result).toEqual([]);
  });

  it("skips plugins with invalid key format", () => {
    writeJson(path.join(homeDir, ".claude", "settings.json"), {
      enabledPlugins: { "no-at-sign": true, "@leading": true, "trailing@": true },
    });

    const result = resolveEnabledPlugins({ homeDir, cwd });
    expect(result).toEqual([]);
  });

  it("skips plugins with missing cache directory", () => {
    writeJson(path.join(homeDir, ".claude", "settings.json"), {
      enabledPlugins: { "missing@market": true },
    });

    const result = resolveEnabledPlugins({ homeDir, cwd });
    expect(result).toEqual([]);
  });

  it("merges plugins from user and project settings", () => {
    writeJson(path.join(homeDir, ".claude", "settings.json"), {
      enabledPlugins: { "user-plugin@market": true },
    });
    writeJson(path.join(cwd, ".claude", "settings.json"), {
      enabledPlugins: { "project-plugin@market": true },
    });
    mkPluginVersion(cacheRoot, "market", "user-plugin", "1.0.0");
    mkPluginVersion(cacheRoot, "market", "project-plugin", "1.0.0");

    const result = resolveEnabledPlugins({ homeDir, cwd });
    const ids = result.map((p) => p.pluginId).sort();
    expect(ids).toEqual(["project-plugin", "user-plugin"]);
  });
});
