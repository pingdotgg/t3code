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

      const { definitions: servers } = yield* readClaudeMcpServers({ homePath: tempDir }, {});

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

  it.effect("reports an incomplete read for a malformed config", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-mcp-" });
      const workspace = path.join(tempDir, "workspace");
      yield* fs.makeDirectory(workspace, { recursive: true });

      // An absent config is a complete read of "no servers"...
      const missing = yield* readClaudeMcpServers(
        { homePath: path.join(tempDir, "absent") },
        {},
        workspace,
      );
      assert.deepEqual(missing.definitions, []);
      assert.equal(missing.complete, true);

      // ...but a file that exists and cannot be parsed leaves the list unknown,
      // which is what stops a caller from taking over MCP resolution.
      yield* writeClaudeConfig(tempDir, "{ not json");
      const malformed = yield* readClaudeMcpServers({ homePath: tempDir }, {}, workspace);
      assert.deepEqual(malformed.definitions, []);
      assert.equal(malformed.complete, false);
      assert.deepEqual(malformed.unreadablePaths, [path.join(tempDir, ".claude.json")]);
    }).pipe(Effect.scoped),
  );

  it.effect("treats a config that is not a regular file as unreadable", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-mcp-" });
      const workspace = path.join(tempDir, "workspace");
      yield* fs.makeDirectory(workspace, { recursive: true });
      // A directory where the config should be: Claude cannot read it either,
      // so the server list is unknown rather than empty.
      yield* fs.makeDirectory(path.join(tempDir, ".claude.json"), { recursive: true });

      const read = yield* readClaudeMcpServers({ homePath: tempDir }, {}, workspace);
      assert.equal(read.complete, false);
      assert.deepEqual(read.unreadablePaths, [path.join(tempDir, ".claude.json")]);
    }).pipe(Effect.scoped),
  );

  it.effect("names the workspace config when only it is malformed", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-mcp-" });
      const workspace = path.join(tempDir, "workspace");
      yield* fs.makeDirectory(workspace, { recursive: true });
      yield* writeClaudeConfig(tempDir, '{ "mcpServers": { "codegraph": { "command": "cg" } } }');
      yield* fs.writeFileString(path.join(workspace, ".mcp.json"), "{ not json");

      const read = yield* readClaudeMcpServers({ homePath: tempDir }, {}, workspace);
      assert.equal(read.complete, false);
      // Blaming `.claude.json` here would send the reader to a file that parsed.
      const resolvedWorkspace = yield* fs.realPath(workspace);
      assert.deepEqual(read.unreadablePaths, [path.join(resolvedWorkspace, ".mcp.json")]);
    }).pipe(Effect.scoped),
  );

  it.effect("reports an incomplete read when no workspace is supplied", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-mcp-" });
      yield* writeClaudeConfig(tempDir, '{ "mcpServers": { "codegraph": { "command": "cg" } } }');

      // Without a cwd the `local` and `project` scopes cannot be read at all,
      // so the user-scope list on its own is knowingly partial.
      const read = yield* readClaudeMcpServers({ homePath: tempDir }, {});
      assert.deepEqual(
        read.definitions.map((definition) => definition.name),
        ["codegraph"],
      );
      assert.equal(read.complete, false);
    }).pipe(Effect.scoped),
  );

  it.effect("finds the local scope when the workspace is reached through a symlink", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-mcp-" });
      const realWorkspace = path.join(tempDir, "real-workspace");
      const linkedWorkspace = path.join(tempDir, "linked-workspace");
      yield* fs.makeDirectory(realWorkspace, { recursive: true });
      yield* fs.symlink(realWorkspace, linkedWorkspace);

      // Claude Code keys `projects` by the resolved real path, so a cwd that
      // arrives through a symlink must still match.
      const resolvedWorkspace = yield* fs.realPath(realWorkspace);
      yield* writeClaudeConfig(
        tempDir,
        [
          "{",
          '  "projects": {',
          `    "${resolvedWorkspace.replaceAll("\\", "\\\\")}": {`,
          '      "mcpServers": { "scratch": { "command": "scratch-server" } }',
          "    }",
          "  }",
          "}",
        ].join("\n"),
      );

      const { definitions } = yield* readClaudeMcpServers(
        { homePath: tempDir },
        {},
        linkedWorkspace,
      );

      assert.deepEqual(
        definitions.map((definition) => `${definition.name}:${definition.scope}`),
        ["scratch:local"],
      );
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

      const { definitions: servers } = yield* readClaudeMcpServers(
        { homePath: "" },
        { CLAUDE_CONFIG_DIR: tempDir },
      );
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

      const { definitions: servers } = yield* readClaudeMcpServers(
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

      const { definitions: servers } = yield* readClaudeMcpServers(
        { homePath: tempDir },
        {},
        workspace,
      );

      assert.deepEqual(servers.map((server) => `${server.name}:${server.scope}`).sort(), [
        "approved:project",
        "codegraph:user",
        "scratch:local",
      ]);
    }).pipe(Effect.scoped),
  );
});
