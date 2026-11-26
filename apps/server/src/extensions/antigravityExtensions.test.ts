import { describe, expect, it } from "@effect/vitest";

import { editAntigravityMcpConfig, readAntigravityMcpServers } from "./antigravityExtensions.ts";

const CONFIG = JSON.stringify({
  futureKey: { keep: true },
  mcpServers: {
    fs: {
      command: "npx",
      args: ["-y", "server-fs"],
      env: { TOKEN: "env_secret" },
      trust: true,
    },
    api: {
      serverUrl: "https://example.com/mcp",
      headers: { Authorization: "Bearer header_secret" },
      disabled: true,
    },
  },
});

const changedText = (result: ReturnType<typeof editAntigravityMcpConfig>) => {
  if (result._tag !== "changed") throw new Error(`refused: ${result.message}`);
  return JSON.parse(result.text) as Record<string, unknown> & {
    mcpServers: Record<string, Record<string, unknown>>;
  };
};

describe("Antigravity mcp_config.json", () => {
  it("reads servers, their enabled state and secret names without values", () => {
    const read = readAntigravityMcpServers(CONFIG);
    expect(read?.servers.map((server) => [server.name, server.enabled, server.health])).toEqual([
      ["fs", true, "unknown"],
      ["api", false, "disabled"],
    ]);
    expect(read?.servers.map((server) => server.secretNames)).toEqual([
      ["TOKEN"],
      ["Authorization"],
    ]);
    expect(JSON.stringify(read?.servers)).not.toMatch(/env_secret|header_secret/);
    expect(readAntigravityMcpServers("")?.servers).toEqual([]);
    expect(readAntigravityMcpServers("[1, 2]")).toBeUndefined();
  });

  it("adds, toggles and removes one server, keeping every other key", () => {
    const added = changedText(
      editAntigravityMcpConfig(CONFIG, {
        _tag: "add",
        name: "remote",
        spec: { _tag: "remote", transport: "http", url: "https://r.dev/mcp", headers: {} },
      }),
    );
    expect(added.futureKey).toEqual({ keep: true });
    expect(added.mcpServers.fs?.trust).toBe(true);
    expect(added.mcpServers.remote).toEqual({
      serverUrl: "https://r.dev/mcp",
      headers: {},
      disabled: false,
    });

    const enabled = changedText(
      editAntigravityMcpConfig(CONFIG, { _tag: "setEnabled", name: "api", enabled: true }),
    );
    expect(enabled.mcpServers.api).toEqual({
      serverUrl: "https://example.com/mcp",
      headers: { Authorization: "Bearer header_secret" },
      disabled: false,
    });

    const removed = changedText(editAntigravityMcpConfig(CONFIG, { _tag: "remove", name: "fs" }));
    expect(Object.keys(removed.mcpServers)).toEqual(["api"]);
    expect(removed.futureKey).toEqual({ keep: true });
  });

  it("adds to an empty file and refuses what it can't do", () => {
    const fromEmpty = changedText(
      editAntigravityMcpConfig("", {
        _tag: "add",
        name: "fs",
        spec: { _tag: "stdio", command: "npx", args: [], env: {} },
      }),
    );
    expect(fromEmpty).toEqual({
      mcpServers: { fs: { command: "npx", args: [], env: {}, disabled: false } },
    });
    const spec = { _tag: "stdio", command: "x", args: [], env: {} } as const;
    expect(editAntigravityMcpConfig(CONFIG, { _tag: "add", name: "fs", spec })._tag).toBe(
      "refused",
    );
    expect(editAntigravityMcpConfig(CONFIG, { _tag: "remove", name: "missing" })._tag).toBe(
      "refused",
    );
    expect(editAntigravityMcpConfig("{broken", { _tag: "remove", name: "fs" })._tag).toBe(
      "refused",
    );
    expect(
      editAntigravityMcpConfig(CONFIG, {
        _tag: "add",
        name: "sse",
        spec: { _tag: "remote", transport: "sse", url: "https://s.dev", headers: {} },
      })._tag,
    ).toBe("refused");
  });
});
