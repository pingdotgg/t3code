import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { readClaudeMcpServers, resolveClaudeMcpConfigFilePath } from "./ClaudeMcpConfig.ts";

const writeClaudeConfig = Effect.fn(function* (homeDir: string, contents: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(homeDir, { recursive: true });
  yield* fs.writeFileString(path.join(homeDir, ".claude.json"), contents);
});

it.layer(NodeServices.layer)("readClaudeMcpServers", (it) => {
  it.effect("reads declared servers from the instance config directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-mcp-" });
      yield* writeClaudeConfig(
        tempDir,
        `{
          "mcpServers": {
            "codegraph": { "type": "stdio", "command": "codegraph", "args": ["serve", "--mcp"] },
            "remote": { "type": "http", "url": "https://example.com/mcp" }
          }
        }`,
      );

      const servers = yield* readClaudeMcpServers({ homePath: tempDir }, {});

      assert.deepEqual(
        servers.map((server) => server.name),
        ["codegraph", "remote"],
      );
      assert.deepEqual(servers[0]?.definition, {
        type: "stdio",
        command: "codegraph",
        args: ["serve", "--mcp"],
      });
    }).pipe(Effect.scoped),
  );

  it.effect("returns nothing for a missing or malformed config", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-mcp-" });

      const missing = yield* readClaudeMcpServers({ homePath: path.join(tempDir, "absent") }, {});
      assert.deepEqual(missing, []);

      yield* writeClaudeConfig(tempDir, "{ not json");
      const malformed = yield* readClaudeMcpServers({ homePath: tempDir }, {});
      assert.deepEqual(malformed, []);
    }).pipe(Effect.scoped),
  );

  it.effect("falls back to CLAUDE_CONFIG_DIR when the instance sets no home", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-mcp-" });
      yield* writeClaudeConfig(tempDir, '{ "mcpServers": { "alpaca": { "command": "uvx" } } }');

      const configPath = yield* resolveClaudeMcpConfigFilePath(
        { homePath: "" },
        { CLAUDE_CONFIG_DIR: tempDir },
      );
      assert.equal(configPath, path.join(tempDir, ".claude.json"));

      const servers = yield* readClaudeMcpServers({ homePath: "" }, { CLAUDE_CONFIG_DIR: tempDir });
      assert.deepEqual(
        servers.map((server) => server.name),
        ["alpaca"],
      );
    }).pipe(Effect.scoped),
  );

  it.effect("resolves a relative CLAUDE_CONFIG_DIR against the workspace cwd", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-mcp-" });
      const workspace = path.join(tempDir, "workspace");
      yield* writeClaudeConfig(
        path.join(workspace, "nested-home"),
        '{ "mcpServers": { "codegraph": { "command": "codegraph" } } }',
      );

      const servers = yield* readClaudeMcpServers(
        { homePath: "" },
        { CLAUDE_CONFIG_DIR: "nested-home" },
        workspace,
      );

      assert.deepEqual(
        servers.map((server) => server.name),
        ["codegraph"],
      );
    }).pipe(Effect.scoped),
  );

  it.effect("adds local servers and only approved project servers", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-mcp-" });
      const workspace = path.join(tempDir, "workspace");
      yield* fs.makeDirectory(workspace, { recursive: true });
      yield* fs.writeFileString(
        path.join(workspace, ".mcp.json"),
        [
          "{",
          '  "mcpServers": {',
          '    "approved": { "command": "approved-server" },',
          '    "unapproved": { "command": "unapproved-server" },',
          '    "rejected": { "command": "rejected-server" }',
          "  }",
          "}",
        ].join("\n"),
      );
      yield* writeClaudeConfig(
        tempDir,
        [
          "{",
          '  "mcpServers": { "codegraph": { "command": "codegraph" } },',
          '  "projects": {',
          `    "${workspace.replaceAll("\\", "\\\\")}": {`,
          '      "mcpServers": { "scratch": { "command": "scratch-server" } },',
          '      "enabledMcpjsonServers": ["approved"],',
          '      "disabledMcpjsonServers": ["rejected"]',
          "    }",
          "  }",
          "}",
        ].join("\n"),
      );

      const servers = yield* readClaudeMcpServers({ homePath: tempDir }, {}, workspace);

      assert.deepEqual(servers.map((server) => `${server.name}:${server.scope}`).sort(), [
        "approved:project",
        "codegraph:user",
        "scratch:local",
      ]);
    }).pipe(Effect.scoped),
  );
});
