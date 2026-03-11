/**
 * Resolve enabled Claude Code plugins from settings files to local cache paths.
 *
 * The Claude Agent SDK doesn't auto-load plugins from `enabledPlugins` in
 * settings files. This module bridges that gap by reading the settings,
 * resolving each enabled plugin to its cache directory, and returning
 * paths suitable for the SDK's `plugins: [{ type: 'local', path }]` option.
 *
 * @module claude-plugins
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface ResolvedPlugin {
  readonly pluginId: string;
  readonly marketplaceId: string;
  readonly path: string;
}

export interface PluginResolutionOptions {
  /** Project working directory for project/local settings. */
  readonly cwd?: string;
  /** Override home directory (useful for testing). Defaults to `os.homedir()`. */
  readonly homeDir?: string;
}

/**
 * Read and merge `enabledPlugins` from user, project, and local settings files.
 * Later sources override earlier ones (local > project > user).
 */
export function readEnabledPluginKeys(options?: PluginResolutionOptions): Map<string, boolean> {
  const home = options?.homeDir ?? os.homedir();
  const cwd = options?.cwd;

  const paths: string[] = [
    path.join(home, ".claude", "settings.json"),
    ...(cwd
      ? [
          path.join(cwd, ".claude", "settings.json"),
          path.join(cwd, ".claude", "settings.local.json"),
        ]
      : []),
  ];

  const merged = new Map<string, boolean>();

  for (const filePath of paths) {
    const plugins = readEnabledPluginsFromFile(filePath);
    if (plugins) {
      for (const [key, value] of Object.entries(plugins)) {
        if (typeof value === "boolean") {
          merged.set(key, value);
        }
      }
    }
  }

  return merged;
}

/**
 * Resolve all enabled plugins to their local cache paths.
 * Skips plugins whose cache directory is missing or has no active version.
 */
export function resolveEnabledPlugins(options?: PluginResolutionOptions): ResolvedPlugin[] {
  const home = options?.homeDir ?? os.homedir();
  const cacheRoot = path.join(home, ".claude", "plugins", "cache");
  const enabled = readEnabledPluginKeys(options);
  const results: ResolvedPlugin[] = [];

  for (const [key, isEnabled] of enabled) {
    if (!isEnabled) continue;

    const parsed = parsePluginKey(key);
    if (!parsed) continue;

    const pluginCacheDir = path.join(cacheRoot, parsed.marketplaceId, parsed.pluginId);
    const versionPath = resolveActiveVersion(pluginCacheDir);
    if (versionPath) {
      results.push({
        pluginId: parsed.pluginId,
        marketplaceId: parsed.marketplaceId,
        path: versionPath,
      });
    }
  }

  return results;
}

// ── Internal helpers ────────────────────────────────────────────────

function readEnabledPluginsFromFile(filePath: string): Record<string, unknown> | undefined {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (parsed && typeof parsed === "object" && "enabledPlugins" in parsed) {
      const plugins = parsed.enabledPlugins;
      if (plugins && typeof plugins === "object" && !Array.isArray(plugins)) {
        return plugins as Record<string, unknown>;
      }
    }
  } catch {
    // File missing or malformed — skip silently.
  }
  return undefined;
}

function parsePluginKey(key: string): { pluginId: string; marketplaceId: string } | undefined {
  const atIndex = key.lastIndexOf("@");
  if (atIndex <= 0 || atIndex === key.length - 1) return undefined;
  return {
    pluginId: key.slice(0, atIndex),
    marketplaceId: key.slice(atIndex + 1),
  };
}

/**
 * Find the active (non-orphaned) version directory inside a plugin cache dir.
 * The active version is the one without a `.orphaned_at` sentinel file.
 * If multiple non-orphaned versions exist, pick the newest by mtime.
 */
function resolveActiveVersion(pluginCacheDir: string): string | undefined {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(pluginCacheDir, { withFileTypes: true });
  } catch {
    return undefined;
  }

  let best: { path: string; mtime: number } | undefined;

  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (entry.name.startsWith(".")) continue;

    const versionDir = path.join(pluginCacheDir, entry.name);
    const realDir = safeRealpath(versionDir);
    if (!realDir) continue;

    // Skip orphaned versions.
    if (fs.existsSync(path.join(realDir, ".orphaned_at"))) continue;

    const mtime = safeMtime(realDir);
    if (!best || mtime > best.mtime) {
      best = { path: realDir, mtime };
    }
  }

  return best?.path;
}

function safeRealpath(p: string): string | undefined {
  try {
    return fs.realpathSync(p);
  } catch {
    return undefined;
  }
}

function safeMtime(p: string): number {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}
