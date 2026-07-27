import { describe, expect, it } from "vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";

import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import {
  COPILOT_AGENT_MODE_ID,
  COPILOT_LEGACY_AGENT_MODE_ID,
  COPILOT_LEGACY_AUTOPILOT_MODE_ID,
  COPILOT_LEGACY_PLAN_MODE_ID,
  COPILOT_PLAN_MODE_ID,
  buildCopilotRuntimeModeArgs,
  buildCopilotAcpSpawnInput,
  buildCopilotMcpServerOptions,
  buildCopilotMcpServers,
  isCopilotPlanModeId,
  normalizeCopilotAcpModeId,
  resolveCopilotAcpModeId,
} from "./CopilotAcpSupport.ts";

describe("buildCopilotAcpSpawnInput", () => {
  it("builds the default GitHub Copilot ACP command", () => {
    expect(buildCopilotAcpSpawnInput(undefined, "/tmp/project", "approval-required")).toEqual({
      command: "copilot",
      args: ["--acp"],
      cwd: "/tmp/project",
    });
  });

  it("uses the configured binary path", () => {
    expect(
      buildCopilotAcpSpawnInput({ binaryPath: "/opt/bin/copilot" }, "/tmp/project", "full-access"),
    ).toEqual({
      command: "/opt/bin/copilot",
      args: ["--acp"],
      cwd: "/tmp/project",
    });
  });

  describe("buildCopilotMcpServers", () => {
    it("exposes the workspace handoff tool by default", () => {
      expect(
        buildCopilotMcpServerOptions(
          "/tmp/project",
          "thread-1",
          "/tmp/t3-dev",
          {},
          {
            execPath: "/usr/bin/node",
            entryPath: "/app/bin.mjs",
          },
        ),
      ).toEqual({
        cwd: "/tmp/project",
        toolsets: new Set(["create_isolated_workspace", "switch_workspace"]),
        threadId: "thread-1",
        cliCommand: "/usr/bin/node",
        cliArgsPrefix: ["/app/bin.mjs"],
        cliBaseDir: "/tmp/t3-dev",
      });

      expect(
        buildCopilotMcpServers({
          url: "http://127.0.0.1:1234/mcp",
          authorization: "Bearer secret",
        }),
      ).toEqual([
        {
          type: "http",
          name: "t3-tools",
          url: "http://127.0.0.1:1234/mcp",
          headers: [{ name: "Authorization", value: "Bearer secret" }],
        },
      ]);
    });

    it("builds env-gated T3 MCP HTTP server options", () => {
      expect(
        buildCopilotMcpServerOptions("/tmp/project", "thread-1", "/tmp/t3-dev", {
          T3_COPILOT_ACP_ENABLE_MCP: "1",
          T3_COPILOT_ACP_MCP_COMMAND: "t3-dev",
          T3_COPILOT_ACP_MCP_TOOLSETS: "read_file,search_files",
        }),
      ).toEqual({
        cwd: "/tmp/project",
        toolsets: new Set([
          "read_file",
          "search_files",
          "create_isolated_workspace",
          "switch_workspace",
        ]),
        threadId: "thread-1",
        cliCommand: "t3-dev",
        cliBaseDir: "/tmp/t3-dev",
      });
    });

    it("appends the provider-scoped browser automation server", () => {
      const threadId = ThreadId.make("thread-1");
      McpProviderSession.setMcpProviderSession({
        environmentId: EnvironmentId.make("environment-1"),
        threadId,
        providerSessionId: "provider-session-1",
        providerInstanceId: ProviderInstanceId.make("copilot"),
        endpoint: "http://127.0.0.1:3000/mcp",
        authorizationHeader: "******",
      });

      expect(
        buildCopilotMcpServers(
          {
            url: "http://127.0.0.1:1234/mcp",
            authorization: "t3-tools-token",
          },
          threadId,
        ),
      ).toEqual([
        {
          type: "http",
          name: "t3-tools",
          url: "http://127.0.0.1:1234/mcp",
          headers: [{ name: "Authorization", value: "t3-tools-token" }],
        },
        {
          type: "http",
          name: "t3-code",
          url: "http://127.0.0.1:3000/mcp",
          headers: [{ name: "Authorization", value: "******" }],
        },
      ]);

      McpProviderSession.clearMcpProviderSession(threadId);
    });
  });
});

describe("buildCopilotRuntimeModeArgs", () => {
  it("keeps ACP permission interception active in full-access mode", () => {
    expect(buildCopilotRuntimeModeArgs("full-access")).toEqual([]);
  });

  it("does not add startup args for stricter runtime modes", () => {
    expect(buildCopilotRuntimeModeArgs("approval-required")).toEqual([]);
    expect(buildCopilotRuntimeModeArgs("auto-accept-edits")).toEqual([]);
  });
});

describe("Copilot ACP mode ids", () => {
  it("maps T3 Code interaction modes to Copilot ACP session mode URIs", () => {
    expect(resolveCopilotAcpModeId("default")).toBe(COPILOT_AGENT_MODE_ID);
    expect(resolveCopilotAcpModeId(undefined)).toBe(COPILOT_AGENT_MODE_ID);
    expect(resolveCopilotAcpModeId("plan")).toBe(COPILOT_PLAN_MODE_ID);
  });

  it("normalizes canonical and legacy Copilot mode URIs", () => {
    expect(normalizeCopilotAcpModeId(COPILOT_AGENT_MODE_ID)).toBe(COPILOT_AGENT_MODE_ID);
    expect(normalizeCopilotAcpModeId(COPILOT_PLAN_MODE_ID)).toBe(COPILOT_PLAN_MODE_ID);
    expect(normalizeCopilotAcpModeId(COPILOT_LEGACY_AGENT_MODE_ID)).toBe(COPILOT_AGENT_MODE_ID);
    expect(normalizeCopilotAcpModeId(COPILOT_LEGACY_AUTOPILOT_MODE_ID)).toBe(COPILOT_AGENT_MODE_ID);
    expect(normalizeCopilotAcpModeId(COPILOT_LEGACY_PLAN_MODE_ID)).toBe(COPILOT_PLAN_MODE_ID);
    expect(normalizeCopilotAcpModeId("custom-mode")).toBe("custom-mode");
    expect(normalizeCopilotAcpModeId("  ")).toBeUndefined();
  });

  it("detects plan mode after legacy URI normalization", () => {
    expect(isCopilotPlanModeId(COPILOT_LEGACY_PLAN_MODE_ID)).toBe(true);
    expect(isCopilotPlanModeId(COPILOT_LEGACY_AGENT_MODE_ID)).toBe(false);
  });
});
