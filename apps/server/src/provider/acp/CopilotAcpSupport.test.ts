import { describe, expect, it } from "vitest";

import {
  COPILOT_AGENT_MODE_ID,
  COPILOT_LEGACY_AGENT_MODE_ID,
  COPILOT_LEGACY_AUTOPILOT_MODE_ID,
  COPILOT_LEGACY_PLAN_MODE_ID,
  COPILOT_PLAN_MODE_ID,
  buildCopilotRuntimeModeArgs,
  buildCopilotAcpSpawnInput,
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
      args: ["--acp", "--allow-all"],
      cwd: "/tmp/project",
    });
  });

  describe("buildCopilotMcpServers", () => {
    it("keeps MCP disabled by default", () => {
      expect(buildCopilotMcpServers("/tmp/project", {})).toEqual([]);
    });

    it("builds an env-gated T3 MCP stdio server descriptor", () => {
      expect(
        buildCopilotMcpServers("/tmp/project", {
          T3_COPILOT_ACP_ENABLE_MCP: "1",
          T3_COPILOT_ACP_MCP_COMMAND: "t3-dev",
          T3_COPILOT_ACP_MCP_TOOLSETS: "read_file,search_files",
        }),
      ).toEqual([
        {
          name: "t3-tools",
          command: "t3-dev",
          args: ["mcp", "serve", "--cwd", "/tmp/project", "--toolsets", "read_file,search_files"],
          env: [],
        },
      ]);
    });
  });
});

describe("buildCopilotRuntimeModeArgs", () => {
  it("maps full-access to allow-all startup args", () => {
    expect(buildCopilotRuntimeModeArgs("full-access")).toEqual(["--allow-all"]);
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
