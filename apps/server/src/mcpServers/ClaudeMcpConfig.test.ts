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
});
