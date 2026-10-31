import { describe, expect, it } from "vite-plus/test";

import { agentcastCodexApprovals, agentcastStdioServer } from "./agentcastMcp.ts";

describe("agentcastStdioServer", () => {
  it("is off unless T3CODE_AGENTCAST_MAIN is set", () => {
    expect(agentcastStdioServer("thread-1", {})).toBeUndefined();
  });

  it("runs agentcast mcp with the thread as its client name", () => {
    const server = agentcastStdioServer("thread-1", {
      T3CODE_AGENTCAST_MAIN: "/opt/agentcast/dist/main.js",
    });
    expect(server?.args).toEqual(["/opt/agentcast/dist/main.js", "mcp"]);
    expect(server?.env.AGENTCAST_CLIENT).toBe("t3:thread-1");
  });

  it("passes the ssh agent socket through", () => {
    const server = agentcastStdioServer("t", {
      T3CODE_AGENTCAST_MAIN: "/x/main.js",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
    });
    expect(server?.env.SSH_AUTH_SOCK).toBe("/tmp/agent.sock");
  });
});

describe("agentcastCodexApprovals", () => {
  it("approves everything only in full-access with a sandbox that can write", () => {
    expect(agentcastCodexApprovals({ runtimeMode: "full-access" })).toEqual({
      default_tools_approval_mode: "approve",
    });
  });

  it("asks before write tools in other modes", () => {
    expect(agentcastCodexApprovals({ runtimeMode: "auto" })).toMatchObject({
      default_tools_approval_mode: "prompt",
    });
  });

  it("offers only the read-only tools in a read-only sandbox, in any mode", () => {
    for (const runtimeMode of ["full-access", "auto"]) {
      const config = agentcastCodexApprovals({ runtimeMode, sandboxPolicy: { type: "readOnly" } });
      expect(config.enabled_tools).toContain("read");
      expect(config.enabled_tools).not.toContain("act");
      expect(config.enabled_tools).not.toContain("exec");
    }
  });
});
