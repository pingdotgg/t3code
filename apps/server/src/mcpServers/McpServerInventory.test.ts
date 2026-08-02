import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProviderDriverKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { discoverClaudeMcpServerEntries, remoteDetail, stdioDetail } from "./McpServerInventory.ts";

describe("stdioDetail", () => {
  it("keeps ordinary arguments so servers stay identifiable", () => {
    assert.equal(
      stdioDetail("npx", ["--yes", "xcodebuildmcp@2.6.2", "mcp"]),
      "npx --yes xcodebuildmcp@2.6.2 mcp",
    );
    assert.equal(stdioDetail("codegraph", undefined), "codegraph");
    assert.equal(
      stdioDetail("uvx", ["mcp-server-git", "--repository", "/srv/repo"]),
      "uvx mcp-server-git --repository /srv/repo",
    );
  });

  it("redacts secrets passed as flag values", () => {
    assert.equal(
      stdioDetail("server", ["--token", "abc123", "--port", "8080"]),
      "server --token … --port 8080",
    );
    assert.equal(stdioDetail("server", ["--api-key=abc123"]), "server --api-key=…");
  });

  it("redacts secrets a flag-name blocklist would miss", () => {
    // Positional token: nothing about the previous argument marks it as secret.
    assert.equal(stdioDetail("npx", ["some-mcp", "sk-ant-api03-XYZ$/+"]), "npx some-mcp …");
    // The flag is innocuous; the value carries the credential.
    assert.equal(
      stdioDetail("mcp-remote", ["--header", "Authorization: Bearer ghp_XYZ"]),
      "mcp-remote --header …",
    );
    // Docker-style env injection.
    assert.equal(stdioDetail("docker", ["run", "-e", "GH_PAT=ghp_XYZ"]), "docker run -e GH_PAT=…");
    // Connection string as a positional argument.
    assert.equal(
      stdioDetail("postgres-mcp", ["postgres://user:hunter2@db.example.com/app"]),
      "postgres-mcp …",
    );
  });

  it("ignores non-string arguments", () => {
    assert.equal(stdioDetail("server", ["--flag", 42, null]), "server --flag");
  });
});

describe("remoteDetail", () => {
  it("keeps the addressable part of a URL", () => {
    assert.equal(remoteDetail("https://mcp.example.com/sse"), "https://mcp.example.com/sse");
  });

  it("drops query strings, fragments, and userinfo", () => {
    assert.equal(
      remoteDetail("https://mcp.example.com/sse?api_key=sk-secret"),
      "https://mcp.example.com/sse",
    );
    assert.equal(
      remoteDetail("https://token@mcp.example.com/mcp"),
      "https://…@mcp.example.com/mcp",
    );
  });

  it("redacts anything it cannot parse", () => {
    assert.equal(remoteDetail("not a url"), "…");
    assert.equal(remoteDetail(undefined), undefined);
  });
});

it.layer(NodeServices.layer)("claude inventory entries", (it) => {
  it.effect("flags rows when a config file cannot be read", () =>
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
        entries.map((entry) => ({ name: entry.name, status: entry.status })),
        [{ name: "codegraph", status: "config unreadable" }],
      );
    }).pipe(Effect.scoped),
  );

  it.effect("reports a clean read without a status", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-mcp-inventory-" });
      const workspace = path.join(tempDir, "workspace");
      yield* fs.makeDirectory(workspace, { recursive: true });
      yield* fs.writeFileString(
        path.join(tempDir, ".claude.json"),
        '{ "mcpServers": { "codegraph": { "command": "codegraph", "args": ["--token", "s3cret"] } } }',
      );

      const entries = yield* discoverClaudeMcpServerEntries(
        "claudeAgent",
        { driver: ProviderDriverKind.make("claudeAgent"), config: { homePath: tempDir } },
        {},
        workspace,
      );

      assert.deepEqual(
        entries.map((entry) => ({
          name: entry.name,
          status: entry.status,
          enabled: entry.enabled,
          scope: entry.scope,
          detail: entry.detail,
        })),
        [
          {
            name: "codegraph",
            status: undefined,
            enabled: true,
            scope: "user",
            detail: "codegraph --token …",
          },
        ],
      );
    }).pipe(Effect.scoped),
  );
});
