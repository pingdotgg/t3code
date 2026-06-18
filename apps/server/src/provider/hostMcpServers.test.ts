import { describe, expect, it } from "@effect/vitest";

import {
  hostMcpServersToOpenCodeConfigContent,
  hostMcpServersToStdioServers,
} from "./hostMcpServers.ts";

const relayCommandForCurrentProcess = (socketPath: string) => {
  const entrypoint = process.argv[1];
  if (!entrypoint || !/(?:^|[/\\])(?:bin|cli)\.(?:[cm]?js|ts)$/u.test(entrypoint)) {
    return { command: "t3", args: ["stdio-to-uds", socketPath], env: {} };
  }
  return {
    command: process.execPath,
    args: [entrypoint, "stdio-to-uds", socketPath],
    env: { ELECTRON_RUN_AS_NODE: "1" },
  };
};

describe("host MCP server adapters", () => {
  it("converts VS Code host MCP sockets to stdio relay server configs", () => {
    const relay = relayCommandForCurrentProcess("/tmp/t3code-vscode-test/mcp.sock");
    const [server] = hostMcpServersToStdioServers([
      {
        name: "t3code-vscode-test",
        socketPath: "/tmp/t3code-vscode-test/mcp.sock",
        toolTimeoutSec: 120,
      },
    ]);

    expect(server).toMatchObject({
      name: "t3code-vscode-test",
      command: relay.command,
      args: relay.args,
      env: relay.env,
      toolTimeoutSec: 120,
    });
  });

  it("builds OpenCode local MCP config with timeout in milliseconds", () => {
    const relay = relayCommandForCurrentProcess("/tmp/t3code-vscode-test/mcp.sock");
    const raw = hostMcpServersToOpenCodeConfigContent([
      {
        name: "t3code-vscode-test",
        socketPath: "/tmp/t3code-vscode-test/mcp.sock",
        toolTimeoutSec: 120,
      },
    ]);

    expect(JSON.parse(raw)).toEqual({
      mcp: {
        "t3code-vscode-test": {
          type: "local",
          command: [relay.command, ...relay.args],
          ...(Object.keys(relay.env).length > 0 ? { environment: relay.env } : {}),
          enabled: true,
          timeout: 120_000,
        },
      },
    });
  });

  it("omits invalid OpenCode MCP timeouts and clamps overly large values", () => {
    const raw = hostMcpServersToOpenCodeConfigContent([
      {
        name: "invalid-timeout",
        socketPath: "/tmp/t3code-vscode-test/invalid.sock",
        toolTimeoutSec: Number.NaN,
      },
      {
        name: "too-small-timeout",
        socketPath: "/tmp/t3code-vscode-test/too-small.sock",
        toolTimeoutSec: 0,
      },
      {
        name: "fractional-timeout",
        socketPath: "/tmp/t3code-vscode-test/fractional.sock",
        toolTimeoutSec: 10.5,
      },
      {
        name: "large-timeout",
        socketPath: "/tmp/t3code-vscode-test/large.sock",
        toolTimeoutSec: Number.POSITIVE_INFINITY,
      },
      {
        name: "capped-timeout",
        socketPath: "/tmp/t3code-vscode-test/capped.sock",
        toolTimeoutSec: Number.MAX_SAFE_INTEGER,
      },
    ]);

    const parsed = JSON.parse(raw);
    expect(parsed.mcp["invalid-timeout"].timeout).toBeUndefined();
    expect(parsed.mcp["too-small-timeout"].timeout).toBeUndefined();
    expect(parsed.mcp["fractional-timeout"].timeout).toBeUndefined();
    expect(parsed.mcp["large-timeout"].timeout).toBeUndefined();
    expect(parsed.mcp["capped-timeout"].timeout).toBe(2_147_483_647);
  });
});
