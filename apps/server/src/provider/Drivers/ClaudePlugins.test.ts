import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { discoverClaudePluginMcpServers } from "./ClaudePlugins.ts";

const writeJson = Effect.fn(function* (filePath: string, value: unknown) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
  // @effect-diagnostics-next-line preferSchemaOverJson:off - fixture mirrors files the Claude CLI wrote.
  yield* fs.writeFileString(filePath, JSON.stringify(value));
});

/**
 * Lay out a Claude config dir the way the CLI does: `settings.json` decides
 * which plugins are on, `plugins/installed_plugins.json` says where they live,
 * and each install directory carries its own `.mcp.json`.
 */
const writePlugin = Effect.fn(function* (input: {
  readonly configDir: string;
  readonly pluginId: string;
  readonly mcpDocument?: unknown;
}) {
  const path = yield* Path.Path;
  const installPath = path.join(input.configDir, "plugins", "cache", input.pluginId);
  if (input.mcpDocument !== undefined) {
    yield* writeJson(path.join(installPath, ".mcp.json"), input.mcpDocument);
  }
  return installPath;
});

it.layer(NodeServices.layer)("discoverClaudePluginMcpServers", (it) => {
  it.effect("names servers the way the interactive CLI does, across both file shapes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-plugins-" });
      const configDir = path.join(tempDir, "claude-home");

      // Bare map of server name to config, as the official Linear plugin ships.
      const linearInstall = yield* writePlugin({
        configDir,
        pluginId: "linear",
        mcpDocument: { linear: { type: "http", url: "https://mcp.linear.app/mcp" } },
      });
      // Wrapped in `mcpServers`, as the official Vercel plugin ships, with an
      // extra key the CLI tolerates.
      const vercelInstall = yield* writePlugin({
        configDir,
        pluginId: "vercel",
        mcpDocument: {
          mcpServers: {
            vercel: { type: "http", url: "https://mcp.vercel.com", note: "official server" },
          },
        },
      });

      yield* writeJson(path.join(configDir, "settings.json"), {
        enabledPlugins: {
          "linear@claude-plugins-official": true,
          "vercel@claude-plugins-official": true,
        },
      });
      yield* writeJson(path.join(configDir, "plugins", "installed_plugins.json"), {
        version: 2,
        plugins: {
          "linear@claude-plugins-official": [{ scope: "user", installPath: linearInstall }],
          "vercel@claude-plugins-official": [{ scope: "user", installPath: vercelInstall }],
        },
      });

      const servers = yield* discoverClaudePluginMcpServers({ homePath: configDir });

      assert.deepEqual(servers, {
        // Stored MCP OAuth tokens are keyed by server name, so these names are
        // load-bearing, not cosmetic.
        "plugin:linear:linear": { type: "http", url: "https://mcp.linear.app/mcp" },
        "plugin:vercel:vercel": {
          type: "http",
          url: "https://mcp.vercel.com",
          note: "official server",
        },
      });
    }),
  );

  it.effect("expands ${CLAUDE_PLUGIN_ROOT} the way the CLI's plugin loader would", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-plugins-" });
      const configDir = path.join(tempDir, "claude-home");

      const installPath = yield* writePlugin({
        configDir,
        pluginId: "fakechat",
        mcpDocument: {
          mcpServers: {
            fakechat: {
              command: "bun",
              args: ["run", "--cwd", "${CLAUDE_PLUGIN_ROOT}", "--silent", "start"],
              env: { FIXTURES: "${CLAUDE_PLUGIN_ROOT}/fixtures" },
            },
          },
        },
      });
      yield* writeJson(path.join(configDir, "settings.json"), {
        enabledPlugins: { "fakechat@claude-plugins-official": true },
      });
      yield* writeJson(path.join(configDir, "plugins", "installed_plugins.json"), {
        version: 2,
        plugins: {
          "fakechat@claude-plugins-official": [{ scope: "user", installPath }],
        },
      });

      const servers = yield* discoverClaudePluginMcpServers({ homePath: configDir });

      // Registration goes over the control channel, which does no substitution:
      // a placeholder left intact reaches the child verbatim and the server dies.
      assert.deepEqual(servers, {
        "plugin:fakechat:fakechat": {
          command: "bun",
          args: ["run", "--cwd", installPath, "--silent", "start"],
          env: { FIXTURES: `${installPath}/fixtures` },
        },
      });
    }),
  );

  it.effect("skips plugins that are disabled, absent, or declare no servers", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-plugins-" });
      const configDir = path.join(tempDir, "claude-home");

      const disabledInstall = yield* writePlugin({
        configDir,
        pluginId: "linear",
        mcpDocument: { linear: { type: "http", url: "https://mcp.linear.app/mcp" } },
      });
      // Enabled, installed, but ships no `.mcp.json` — most plugins.
      const skillsOnlyInstall = yield* writePlugin({ configDir, pluginId: "ponytail" });

      yield* writeJson(path.join(configDir, "settings.json"), {
        enabledPlugins: {
          "linear@claude-plugins-official": false,
          "ponytail@ponytail": true,
          // Enabled but missing from the install manifest.
          "ghost@marketplace": true,
        },
      });
      yield* writeJson(path.join(configDir, "plugins", "installed_plugins.json"), {
        version: 2,
        plugins: {
          "linear@claude-plugins-official": [{ scope: "user", installPath: disabledInstall }],
          "ponytail@ponytail": [{ scope: "user", installPath: skillsOnlyInstall }],
        },
      });

      const servers = yield* discoverClaudePluginMcpServers({ homePath: configDir });

      assert.deepEqual(servers, {});
    }),
  );

  it.effect("lets project settings turn off a plugin the user enabled", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-plugins-" });
      const configDir = path.join(tempDir, "claude-home");
      const workspace = path.join(tempDir, "workspace");

      const linearInstall = yield* writePlugin({
        configDir,
        pluginId: "linear",
        mcpDocument: { linear: { type: "http", url: "https://mcp.linear.app/mcp" } },
      });
      yield* writeJson(path.join(configDir, "settings.json"), {
        enabledPlugins: { "linear@claude-plugins-official": true },
      });
      yield* writeJson(path.join(configDir, "plugins", "installed_plugins.json"), {
        version: 2,
        plugins: {
          "linear@claude-plugins-official": [{ scope: "user", installPath: linearInstall }],
        },
      });
      yield* writeJson(path.join(workspace, ".claude", "settings.json"), {
        enabledPlugins: { "linear@claude-plugins-official": false },
      });

      const enabled = yield* discoverClaudePluginMcpServers({ homePath: configDir });
      assert.deepEqual(Object.keys(enabled), ["plugin:linear:linear"]);

      const disabledByProject = yield* discoverClaudePluginMcpServers(
        { homePath: configDir },
        workspace,
      );
      assert.deepEqual(disabledByProject, {});
    }),
  );

  it.effect("survives malformed manifests and unreadable config dirs", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-plugins-" });
      const configDir = path.join(tempDir, "claude-home");

      const linearInstall = yield* writePlugin({
        configDir,
        pluginId: "linear",
        mcpDocument: { linear: { type: "http", url: "https://mcp.linear.app/mcp" } },
      });
      yield* writeJson(path.join(configDir, "settings.json"), {
        enabledPlugins: { "linear@claude-plugins-official": true },
      });
      yield* fs.writeFileString(
        path.join(configDir, "plugins", "installed_plugins.json"),
        "{ not json",
      );

      assert.deepEqual(yield* discoverClaudePluginMcpServers({ homePath: configDir }), {});

      // A readable manifest pointing at a malformed `.mcp.json` is also inert.
      yield* writeJson(path.join(configDir, "plugins", "installed_plugins.json"), {
        version: 2,
        plugins: {
          "linear@claude-plugins-official": [{ scope: "user", installPath: linearInstall }],
        },
      });
      yield* fs.writeFileString(path.join(linearInstall, ".mcp.json"), "{{{");
      assert.deepEqual(yield* discoverClaudePluginMcpServers({ homePath: configDir }), {});

      // And a config dir that does not exist at all yields nothing.
      assert.deepEqual(
        yield* discoverClaudePluginMcpServers({ homePath: path.join(tempDir, "missing") }),
        {},
      );
    }),
  );
});
