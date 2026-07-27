import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProviderDriverKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { discoverClaudeMcpServerEntries, stdioDetail } from "./McpServerInventory.ts";

describe("stdioDetail", () => {
  it("keeps ordinary arguments so servers stay identifiable", () => {
    assert.equal(
      stdioDetail("npx", ["--yes", "xcodebuildmcp@2.6.2", "mcp"]),
      "npx --yes xcodebuildmcp@2.6.2 mcp",
    );
    assert.equal(stdioDetail("codegraph", undefined), "codegraph");
  });

  it("redacts secrets passed as flag values", () => {
    assert.equal(
      stdioDetail("server", ["--token", "abc123", "--port", "8080"]),
      "server --token … --port 8080",
    );
    assert.equal(stdioDetail("server", ["--api-key=abc123"]), "server --api-key=…");
    assert.equal(stdioDetail("server", ["--password", "hunter2"]), "server --password …");
  });

  it("ignores non-string arguments", () => {
    assert.equal(stdioDetail("server", ["--flag", 42, null]), "server --flag");
  });
});

it.layer(NodeServices.layer)("claude inventory entries", (it) => {
  it.effect("marks rows non-toggleable when a config file cannot be read", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-mcp-inventory-" });
      const workspace = path.join(tempDir, "workspace");
      yield* fs.makeDirectory(workspace, { recursive: true });
      yield* fs.writeFileString(
        path.join(tempDir, ".claude.json"),
        '{ "mcpServers": { "codegraph": { "command": "codegraph" } } }',
      );
      // A malformed workspace `.mcp.json` leaves the project scope unknown.
      yield* fs.writeFileString(path.join(workspace, ".mcp.json"), "{ not json");

      const entries = yield* discoverClaudeMcpServerEntries(
        "claudeAgent",
        { driver: ProviderDriverKind.make("claudeAgent"), config: { homePath: tempDir } },
        {},
        workspace,
      );

      assert.deepEqual(
        entries.map((entry) => ({ name: entry.name, toggleable: entry.toggleable })),
        [{ name: "codegraph", toggleable: false }],
      );
    }).pipe(Effect.scoped),
  );
});
