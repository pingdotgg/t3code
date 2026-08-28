/**
 * ClaudePlugins — filesystem discovery of MCP servers contributed by enabled
 * Claude Code plugins.
 *
 * The Claude Agent SDK never wires up plugin-provided MCP servers: a spawned
 * CLI reports the plugins themselves in its `system/init` handshake, and loads
 * their skills, commands, and agents, but the servers declared in each
 * plugin's `.mcp.json` are only registered by the interactive TUI. Every SDK
 * consumer therefore sees a Linear or Vercel plugin that looks installed while
 * its tools are absent.
 *
 * The adapter closes the gap by resolving those servers here and handing them
 * to `Query.setMcpServers` once the session is up. Names must match what the
 * TUI would use — `plugin:<plugin>:<server>` — because stored MCP OAuth tokens
 * are keyed by server name, so any other name silently re-prompts for auth.
 * That control-channel path also bypasses the CLI's plugin loader, so the
 * `${CLAUDE_PLUGIN_ROOT}` expansion the loader performs happens here instead.
 *
 * @module provider/Drivers/ClaudePlugins
 */
import type { ClaudeSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { resolveClaudeConfigDirPath } from "./ClaudeHome.ts";

/**
 * One plugin-contributed MCP server config, passed through verbatim from the
 * plugin's `.mcp.json`. Kept opaque on purpose: the CLI owns the schema, and
 * rewriting the config would change the hash its OAuth token is keyed by.
 */
export type ClaudePluginMcpServerConfig = Readonly<Record<string, unknown>>;

function parseJsonObject(contents: string): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return undefined;
  }
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : undefined;
}

const readJsonObject = Effect.fn("readJsonObject")(function* (
  filePath: string,
): Effect.fn.Return<Record<string, unknown> | undefined, never, FileSystem.FileSystem> {
  const fileSystem = yield* FileSystem.FileSystem;
  const contents = yield* fileSystem
    .readFileString(filePath)
    .pipe(Effect.orElseSucceed(() => undefined));
  return contents === undefined ? undefined : parseJsonObject(contents);
});

/**
 * Plugin ids (`<plugin>@<marketplace>`) switched on by `enabledPlugins`, read
 * across the same settings files the CLI merges for the `user`, `project`, and
 * `local` sources. Later files win, so a project can disable a user plugin.
 */
const readEnabledPluginIds = Effect.fn("readEnabledPluginIds")(function* (
  configDirPath: string,
  cwd: string | undefined,
): Effect.fn.Return<ReadonlySet<string>, never, FileSystem.FileSystem | Path.Path> {
  const path = yield* Path.Path;
  const settingsPaths = [
    path.join(configDirPath, "settings.json"),
    path.join(configDirPath, "settings.local.json"),
    ...(cwd
      ? [
          path.join(cwd, ".claude", "settings.json"),
          path.join(cwd, ".claude", "settings.local.json"),
        ]
      : []),
  ];

  const enabledById = new Map<string, boolean>();
  for (const settingsPath of settingsPaths) {
    const settings = yield* readJsonObject(settingsPath);
    const enabledPlugins = settings?.enabledPlugins;
    if (typeof enabledPlugins !== "object" || enabledPlugins === null) {
      continue;
    }
    for (const [pluginId, enabled] of Object.entries(enabledPlugins)) {
      if (typeof enabled === "boolean") {
        enabledById.set(pluginId, enabled);
      }
    }
  }

  return new Set([...enabledById].filter(([, enabled]) => enabled).map(([pluginId]) => pluginId));
});

/**
 * Install directories per plugin id, from the plugin cache manifest. A plugin
 * can be installed at more than one scope, so each id keeps every candidate
 * path in manifest order.
 */
const readPluginInstallPaths = Effect.fn("readPluginInstallPaths")(function* (
  configDirPath: string,
): Effect.fn.Return<
  ReadonlyMap<string, ReadonlyArray<string>>,
  never,
  FileSystem.FileSystem | Path.Path
> {
  const path = yield* Path.Path;
  const manifest = yield* readJsonObject(
    path.join(configDirPath, "plugins", "installed_plugins.json"),
  );
  const plugins = manifest?.plugins;
  const installPathsById = new Map<string, ReadonlyArray<string>>();
  if (typeof plugins !== "object" || plugins === null) {
    return installPathsById;
  }

  for (const [pluginId, installs] of Object.entries(plugins)) {
    if (!Array.isArray(installs)) {
      continue;
    }
    const installPaths = installs.flatMap((install) =>
      typeof install === "object" &&
      install !== null &&
      typeof (install as { installPath?: unknown }).installPath === "string"
        ? [(install as { installPath: string }).installPath]
        : [],
    );
    if (installPaths.length > 0) {
      installPathsById.set(pluginId, installPaths);
    }
  }

  return installPathsById;
});

const PLUGIN_ROOT_PLACEHOLDER = "${CLAUDE_PLUGIN_ROOT}";

/**
 * Expand `${CLAUDE_PLUGIN_ROOT}` in every string the config carries, the way the
 * CLI's own plugin loader does before spawning a server.
 *
 * Registering servers over the control channel skips that loader entirely: a
 * config handed over with the placeholder intact reaches the child process
 * verbatim, so a `bun run --cwd ${CLAUDE_PLUGIN_ROOT}` server starts in a
 * directory that does not exist and dies with "Connection closed". Five of the
 * official marketplace plugins are built this way.
 */
function expandPluginRoot(value: unknown, installPath: string): unknown {
  if (typeof value === "string") {
    return value.replaceAll(PLUGIN_ROOT_PLACEHOLDER, installPath);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => expandPluginRoot(entry, installPath));
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, expandPluginRoot(entry, installPath)]),
    );
  }
  return value;
}

/**
 * Servers declared by one plugin. A plugin `.mcp.json` is accepted both wrapped
 * in `mcpServers` (as the CLI documents it) and as a bare map of server name to
 * config, because official plugins ship both shapes.
 */
function readDeclaredServers(
  document: Record<string, unknown>,
): ReadonlyArray<readonly [string, ClaudePluginMcpServerConfig]> {
  const wrapped = document.mcpServers;
  const servers =
    typeof wrapped === "object" && wrapped !== null && !Array.isArray(wrapped)
      ? (wrapped as Record<string, unknown>)
      : document;

  return Object.entries(servers).flatMap(([serverName, config]) => {
    if (typeof config !== "object" || config === null || Array.isArray(config)) {
      return [];
    }
    // `sdk` servers are in-process objects the CLI cannot reconnect from disk.
    if ((config as { type?: unknown }).type === "sdk") {
      return [];
    }
    return [[serverName, config as ClaudePluginMcpServerConfig] as const];
  });
}

/**
 * Enumerate MCP servers contributed by enabled plugins, keyed by the
 * `plugin:<plugin>:<server>` names the interactive CLI uses. Discovery is
 * best-effort throughout: an unreadable manifest, a missing install directory,
 * or a malformed `.mcp.json` yields no servers for that plugin rather than
 * failing session start.
 */
export const discoverClaudePluginMcpServers = Effect.fn("discoverClaudePluginMcpServers")(
  function* (
    config: Pick<ClaudeSettings, "homePath">,
    cwd?: string,
    environment?: NodeJS.ProcessEnv,
  ): Effect.fn.Return<
    Readonly<Record<string, ClaudePluginMcpServerConfig>>,
    never,
    FileSystem.FileSystem | Path.Path
  > {
    const path = yield* Path.Path;
    const configDirPath = yield* resolveClaudeConfigDirPath(
      config,
      environment ?? process.env,
      cwd,
    );

    const enabledPluginIds = yield* readEnabledPluginIds(configDirPath, cwd);
    if (enabledPluginIds.size === 0) {
      return {};
    }

    const installPathsById = yield* readPluginInstallPaths(configDirPath);
    const servers: Record<string, ClaudePluginMcpServerConfig> = {};

    for (const pluginId of [...enabledPluginIds].sort()) {
      const pluginName = pluginId.split("@")[0]?.trim();
      if (!pluginName) {
        continue;
      }

      for (const installPath of installPathsById.get(pluginId) ?? []) {
        const document = yield* readJsonObject(path.join(installPath, ".mcp.json"));
        if (document === undefined) {
          continue;
        }
        const declared = readDeclaredServers(document);
        if (declared.length === 0) {
          continue;
        }
        for (const [serverName, serverConfig] of declared) {
          servers[`plugin:${pluginName}:${serverName}`] = expandPluginRoot(
            serverConfig,
            installPath,
          ) as ClaudePluginMcpServerConfig;
        }
        // One install per plugin wins; later scopes would only shadow it.
        break;
      }
    }

    return servers;
  },
);
