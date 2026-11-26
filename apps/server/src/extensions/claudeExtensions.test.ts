import { describe, expect, it } from "@effect/vitest";

import {
  claudeAddJson,
  parseClaudeMcpList,
  parseClaudePluginList,
  readClaudeUserMcpServers,
  withClaudeHealth,
} from "./claudeExtensions.ts";

const MCP_LIST = [
  "Checking MCP server health…",
  "",
  "claude.ai Trello: https://mcp.trello.com/v1 - ✔ Connected",
  "agent-browser: agent-browser mcp - ✔ Connected",
  "docs: https://example.com/a - b/mcp (HTTP) - ! Needs authentication",
  "broken server: npx -y broken - ✗ Failed to connect",
  "    spawn npx ENOENT",
  "tools: node tools.js - ! Connected · tools fetch failed",
  "plugin:thing:srv: node srv.js - ✔ Connected",
].join("\n");

describe("parseClaudeMcpList", () => {
  it("reads names with spaces, targets containing ' - ', statuses and failure notes", () => {
    expect(parseClaudeMcpList(MCP_LIST)).toEqual([
      {
        name: "claude.ai Trello",
        target: "https://mcp.trello.com/v1",
        health: "ok",
        detail: null,
      },
      { name: "agent-browser", target: "agent-browser mcp", health: "ok", detail: null },
      {
        name: "docs",
        target: "https://example.com/a - b/mcp",
        health: "needsAuth",
        detail: "Needs authentication",
      },
      {
        name: "broken server",
        target: "npx -y broken",
        health: "failing",
        detail: "Failed to connect: spawn npx ENOENT",
      },
      {
        name: "tools",
        target: "node tools.js",
        health: "failing",
        detail: "Connected, but listing its tools failed",
      },
      { name: "plugin:thing:srv", target: "node srv.js", health: "ok", detail: null },
    ]);
  });
});

const ACCOUNT_CONFIG = JSON.stringify({
  oauthAccount: { emailAddress: "someone@example.com" },
  mcpServers: {
    runpod: {
      type: "stdio",
      command: "npx",
      args: ["-y", "runpod-mcp", "--api-key", "rp_secret_value"],
      env: { RUNPOD_API_KEY: "rp_env_secret" },
    },
    paperslk: {
      type: "http",
      url: "https://mcp.example.com/mcp?token=url_secret",
      headers: { Authorization: "Bearer header_secret" },
    },
    socket: { type: "ws", url: "wss://example.com" },
  },
  projects: {
    "/work/app": { mcpServers: { projectOnly: { command: "node", args: ["p.js"] } } },
  },
});

describe("readClaudeUserMcpServers", () => {
  it("lists only user-scope servers, with secret names and no secret values", () => {
    const read = readClaudeUserMcpServers(ACCOUNT_CONFIG);
    expect(
      read?.servers.map((server) => [server.name, server.transport, server.secretNames]),
    ).toEqual([
      ["runpod", "stdio", ["RUNPOD_API_KEY"]],
      ["paperslk", "http", ["Authorization"]],
    ]);
    expect(read?.skipped).toEqual(["socket"]);
    const reported = JSON.stringify(read?.servers);
    for (const secret of ["rp_secret_value", "rp_env_secret", "url_secret", "header_secret"]) {
      expect(reported).not.toContain(secret);
    }
    expect(read?.servers[0]?.target).toBe("npx -y runpod-mcp --api-key ***");
    // The full spec, values included, stays server-side for copies.
    expect(read?.specs.get("runpod")).toEqual({
      _tag: "stdio",
      command: "npx",
      args: ["-y", "runpod-mcp", "--api-key", "rp_secret_value"],
      env: { RUNPOD_API_KEY: "rp_env_secret" },
    });
  });

  it("treats a missing file as empty and reports unreadable JSON", () => {
    expect(readClaudeUserMcpServers("")?.servers).toEqual([]);
    expect(readClaudeUserMcpServers("{not json")).toBeUndefined();
  });

  it("adds health by name and lists claude.ai connectors as managed elsewhere", () => {
    const read = readClaudeUserMcpServers(
      JSON.stringify({
        mcpServers: { docs: { type: "http", url: "https://example.com/a - b/mcp" } },
      }),
    );
    const servers = withClaudeHealth(read?.servers ?? [], parseClaudeMcpList(MCP_LIST));
    expect(servers.map((server) => [server.name, server.health, server.managedElsewhere])).toEqual([
      ["docs", "needsAuth", false],
      ["claude.ai Trello", "ok", true],
    ]);
  });

  it("builds add-json input from a spec", () => {
    expect(
      JSON.parse(
        claudeAddJson({ _tag: "remote", transport: "sse", url: "https://x.dev/sse", headers: {} }),
      ),
    ).toEqual({ type: "sse", url: "https://x.dev/sse", headers: {} });
  });
});

describe("parseClaudePluginList", () => {
  it("maps user-scope plugins and their errors", () => {
    const output = JSON.stringify([
      { id: "review@official", version: "1.2.0", scope: "user", enabled: true },
      { id: "lint@official", version: "unknown", scope: "user", enabled: false },
      { id: "broken@market", scope: "user", enabled: true, errors: ["Manifest is invalid"] },
      { id: "local@market", scope: "project", enabled: true },
    ]);
    expect(parseClaudePluginList(output)).toEqual([
      {
        id: "review@official",
        name: "review",
        marketplace: "official",
        version: "1.2.0",
        description: null,
        enabled: true,
        health: "ok",
        detail: null,
      },
      {
        id: "lint@official",
        name: "lint",
        marketplace: "official",
        version: null,
        description: null,
        enabled: false,
        health: "disabled",
        detail: null,
      },
      {
        id: "broken@market",
        name: "broken",
        marketplace: "market",
        version: null,
        description: null,
        enabled: true,
        health: "failing",
        detail: "Manifest is invalid",
      },
    ]);
    expect(parseClaudePluginList("Installed plugins:")).toBeUndefined();
  });
});
