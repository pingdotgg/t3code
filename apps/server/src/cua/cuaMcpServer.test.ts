import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import {
  CUA_MCP_SERVER_NAME,
  cuaAcpMcpServer,
  cuaClaudeMcpServer,
  cuaOpenCodeMcpConfig,
} from "./cuaMcpServer.ts";

const descriptor = {
  command: "/opt/cua/cua-driver",
  args: ["mcp", "--proxy"],
  environment: [{ name: "CUA_SOCKET_PATH", value: "/tmp/cua.sock" }],
};

describe("cuaMcpServer", () => {
  it("maps the driver descriptor onto each provider's stdio shape", () => {
    NodeAssert.deepEqual(cuaAcpMcpServer(descriptor), {
      name: CUA_MCP_SERVER_NAME,
      command: descriptor.command,
      args: ["mcp", "--proxy"],
      env: [{ name: "CUA_SOCKET_PATH", value: "/tmp/cua.sock" }],
    });
    NodeAssert.deepEqual(cuaClaudeMcpServer(descriptor), {
      type: "stdio",
      command: descriptor.command,
      args: ["mcp", "--proxy"],
      env: { CUA_SOCKET_PATH: "/tmp/cua.sock" },
    });
    NodeAssert.deepEqual(cuaOpenCodeMcpConfig(descriptor), {
      type: "local",
      command: [descriptor.command, "mcp", "--proxy"],
      environment: { CUA_SOCKET_PATH: "/tmp/cua.sock" },
    });
  });

  it("copies arguments so callers cannot mutate the shared descriptor", () => {
    const server = cuaAcpMcpServer(descriptor);
    server.args.push("--extra");
    NodeAssert.deepEqual(descriptor.args, ["mcp", "--proxy"]);
  });
});
