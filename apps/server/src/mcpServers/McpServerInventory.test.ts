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

  it("keeps scoped package specifiers, the usual shape of an MCP command", () => {
    assert.equal(
      stdioDetail("npx", ["-y", "@modelcontextprotocol/server-filesystem"]),
      "npx -y @modelcontextprotocol/server-filesystem",
    );
    assert.equal(
      stdioDetail("npx", ["@modelcontextprotocol/server-memory@2025.8.5"]),
      "npx @modelcontextprotocol/server-memory@2025.8.5",
    );
    // A leading `@` alone is not package-shaped: no slash, no scope.
    assert.equal(stdioDetail("server", ["@hunter2"]), "server …");
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

  it("redacts a flag value that itself looks like a flag", () => {
    // A credential can start with `-`, so "it parses as a flag" is not evidence
    // that it is one.
    assert.equal(stdioDetail("server", ["--token", "-secret"]), "server --token …");
    // Redacting the middle argument must not disarm the next one: whichever of
    // the two flags owns it, `hunter2` is still a credential value.
    assert.equal(stdioDetail("server", ["--token", "--api-key", "hunter2"]), "server --token … …");
  });

  it("redacts a command that carries a credential", () => {
    assert.equal(stdioDetail("postgres://user:hunter2@db.example.com/app", []), "…");
    assert.equal(
      stdioDetail("/opt/mcp/bin/serve", ["--port", "8080"]),
      "/opt/mcp/bin/serve --port 8080",
    );
  });

  it("ignores non-string arguments", () => {
    assert.equal(stdioDetail("server", ["--flag", 42, null]), "server --flag");
  });
});

describe("remoteDetail", () => {
  it("keeps the origin, which is what identifies the server", () => {
    assert.equal(remoteDetail("https://mcp.example.com/sse"), "https://mcp.example.com");
  });

  it("drops paths, query strings, fragments, and userinfo", () => {
    assert.equal(
      remoteDetail("https://mcp.example.com/sse?api_key=sk-secret"),
      "https://mcp.example.com",
    );
    // A token in the path is just as much a credential as one in the query.
    assert.equal(remoteDetail("https://mcp.example.com/mcp/sk-secret"), "https://mcp.example.com");
    assert.equal(remoteDetail("https://token@mcp.example.com/mcp"), "https://…@mcp.example.com");
  });

  it("redacts anything it cannot parse", () => {
    assert.equal(remoteDetail("not a url"), "…");
    assert.equal(remoteDetail(undefined), undefined);
  });
});

it.layer(NodeServices.layer)("claude inventory entries", (it) => {
  it.effect("blames the config that actually failed, not the one it resolved first", () =>
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

      const { entries, unreadable } = yield* discoverClaudeMcpServerEntries(
        "claudeAgent",
        { driver: ProviderDriverKind.make("claudeAgent"), config: { homePath: tempDir } },
        {},
        workspace,
      );

      // The user-scope row came out of a `.claude.json` that parsed, so it is
      // not suspect; only the project scope is unknown.
      assert.deepEqual(
        entries.map((entry) => entry.name),
        ["codegraph"],
      );
      assert.equal(entries[0]?.status, undefined);
      const resolvedWorkspace = yield* fs.realPath(workspace);
      assert.deepEqual(
        unreadable.map((item) => item.configPath),
        [path.join(resolvedWorkspace, ".mcp.json")],
      );
    }).pipe(Effect.scoped),
  );

  it.effect("reports an unreadable config even when it yields no rows at all", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-mcp-inventory-" });
      const workspace = path.join(tempDir, "workspace");
      yield* fs.makeDirectory(workspace, { recursive: true });
      // The whole file is garbage, so not a single server can be recovered.
      yield* fs.writeFileString(path.join(tempDir, ".claude.json"), "{ not json");

      const { entries, unreadable } = yield* discoverClaudeMcpServerEntries(
        "claudeAgent",
        { driver: ProviderDriverKind.make("claudeAgent"), config: { homePath: tempDir } },
        {},
        workspace,
      );

      // Without the separate channel this is indistinguishable from "nothing
      // configured", and the empty state would claim there are no servers.
      assert.deepEqual(entries, []);
      assert.deepEqual(
        unreadable.map((item) => item.harnessDisplayName),
        ["Claude"],
      );
      assert.equal(unreadable[0]?.configPath, path.join(tempDir, ".claude.json"));
    }).pipe(Effect.scoped),
  );

  it.effect("strips control characters and bounds absurd server names", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-mcp-inventory-" });
      const workspace = path.join(tempDir, "workspace");
      yield* fs.makeDirectory(workspace, { recursive: true });
      // Written as raw text so the control character survives verbatim.
      const rtl = `rtl‮evil`;
      const long = "a".repeat(5000);
      yield* fs.writeFileString(
        path.join(tempDir, ".claude.json"),
        `{"mcpServers":{"${rtl}":{"command":"x"},"${long}":{"command":"y"}}}`,
      );

      const { entries } = yield* discoverClaudeMcpServerEntries(
        "claudeAgent",
        { driver: ProviderDriverKind.make("claudeAgent"), config: { homePath: tempDir } },
        {},
        workspace,
      );

      const names = entries.map((entry) => entry.name).sort();
      // The RTL override would otherwise reorder how the row reads on screen.
      assert.equal(
        names.some((name) => /[\p{Cc}\p{Cf}]/u.test(name)),
        false,
      );
      assert.equal(
        names.every((name) => name.length <= 121),
        true,
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

      const { entries } = yield* discoverClaudeMcpServerEntries(
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
