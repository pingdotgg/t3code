import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import type { McpProviderSessionConfig } from "@t3tools/provider-core/server/mcpSession";

import { acpMcpContext } from "./adapter.ts";

const self = { command: "/usr/local/bin/t3", entrypoint: undefined };
const session: McpProviderSessionConfig = {
  environmentId: EnvironmentId.make("environment-acp-upstream"),
  threadId: ThreadId.make("thread-acp-upstream"),
  providerSessionId: "mcp-session-acp-upstream",
  providerInstanceId: ProviderInstanceId.make("grok"),
  endpoint: "http://127.0.0.1:43123/mcp",
  authorizationHeader: "Bearer thread-token",
  browserToolsAvailable: true,
  upstreamServers: [
    { name: "notion", endpoint: "http://127.0.0.1:43123/mcp/upstream/server-notion" },
  ],
};
const runtimePolicy = {
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: null,
} as const;

describe("acpMcpContext", () => {
  it("bridges each configured server over stdio to its upstream route", () => {
    const context = acpMcpContext(session, self, runtimePolicy, undefined, undefined, undefined);
    const notion = {
      name: "notion",
      command: "/usr/local/bin/t3",
      args: ["acp-mcp-bridge"],
      env: [
        { name: "ELECTRON_RUN_AS_NODE", value: "1" },
        { name: "T3_ACP_MCP_ENDPOINT", value: "http://127.0.0.1:43123/mcp/upstream/server-notion" },
        { name: "T3_ACP_MCP_AUTHORIZATION", value: "Bearer thread-token" },
      ],
    };

    expect(context.servers.map((server) => server.name)).toEqual(["t3-code", "notion"]);
    expect(context.servers[1]).toEqual(notion);
    // MCP-over-ACP reaches only T3's own endpoint, so agents using it still get the stdio bridge.
    expect(context.acpServers).toEqual([
      { type: "acp", name: "t3-code", serverId: "t3-code" },
      notion,
    ]);
  });

  it("keeps configured servers in the list an HTTP flavor receives", () => {
    const context = acpMcpContext(session, self, runtimePolicy, true, undefined, undefined);

    expect(context.httpServers.map((server) => server.name)).toEqual(["t3-code", "notion"]);
  });

  it("offers no configured servers to a read-only sandbox", () => {
    const context = acpMcpContext(
      session,
      self,
      {
        ...runtimePolicy,
        sandboxPolicy: { type: "readOnly" },
      },
      undefined,
      undefined,
      undefined,
    );

    expect(context.servers.map((server) => server.name)).toEqual(["t3-code"]);
    expect(context.acpServers.map((server) => server.name)).toEqual(["t3-code"]);
  });
});
