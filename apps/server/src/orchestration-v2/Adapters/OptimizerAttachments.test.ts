import { describe, expect, it } from "@effect/vitest";
import { ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as HeadroomRouting from "../../optimizer/HeadroomRouting.ts";
import {
  clearSessionOptimizerAttachments,
  readSessionOptimizerAttachments,
  setSessionOptimizerAttachments,
} from "@t3tools/provider-core/server/sessionOptimizerAttachments";
import { acpMcpContext } from "@t3tools/provider-acp/server/adapter";
import { claudeMcpQueryOverrides } from "./ClaudeAdapterV2.ts";
import { buildCodexTurnStartParams, codexThreadRuntimeParams } from "./CodexAdapterV2.ts";

const threadId = ThreadId.make("thread-optimizer-adapters");

const attachOptimizers = () =>
  setSessionOptimizerAttachments(threadId, {
    projectId: ProjectId.make("project-optimizer-adapters"),
    cwd: "/workspace/repo",
    configured: ["rtk", "headroom", "cbm"],
    attached: ["rtk", "headroom", "cbm"],
    ready: ["rtk", "headroom"],
    rtk: { command: "rtk" },
    headroom: {
      environment: {
        HEADROOM_ACTIVE: "1",
        HEADROOM_PROXY_URL: "http://127.0.0.1:6767",
        OPENAI_BASE_URL: "http://127.0.0.1:6767/v1",
      },
      codexConfig: { openai_base_url: "http://127.0.0.1:6767/v1" },
    },
    cbm: {
      command: "/tools/codebase-memory-mcp",
      args: ["serve"],
      env: { CBM_ALLOWED_ROOT: "/workspace/repo" },
    },
  });

describe("optimizer attachment projections", () => {
  it.effect("adds Codex RTK context and thread config only for attached optimizers", () =>
    Effect.gen(function* () {
      attachOptimizers();
      // Codex shares one app-server across app threads, so CBM and Headroom
      // have to ride in the per-thread config, not the process arguments.
      const threadConfig = codexThreadRuntimeParams({
        threadId,
        mcpSession: undefined,
        runtimePolicy: {
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: "/workspace/repo",
        },
      }).config;
      expect(threadConfig["mcp_servers.codebase-memory"]).toEqual({
        command: "/tools/codebase-memory-mcp",
        args: ["serve"],
        env: { CBM_ALLOWED_ROOT: "/workspace/repo" },
      });
      expect(threadConfig["mcp_servers.t3-code"]).toBeUndefined();
      expect(threadConfig["openai_base_url"]).toEqual("http://127.0.0.1:6767/v1");

      const turn = yield* buildCodexTurnStartParams({
        nativeThreadId: "native-optimizer-adapters",
        codexInput: [{ type: "text", text: "inspect the repository" }],
        runtimePolicy: {
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: "/workspace/repo",
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-6-sol",
        },
        hasT3Mcp: true,
        rtkEnabled: true,
      });
      expect(turn.additionalContext?.t3_code_rtk?.value).toContain("<rtk_instructions>");

      const optimizerOnlyTurn = yield* buildCodexTurnStartParams({
        nativeThreadId: "native-optimizer-only",
        codexInput: [{ type: "text", text: "inspect the repository" }],
        runtimePolicy: {
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: "/workspace/repo",
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-6-sol",
        },
        hasT3Mcp: false,
        rtkEnabled: true,
      });
      expect(optimizerOnlyTurn.additionalContext).toEqual({
        t3_code_rtk: expect.objectContaining({
          value: expect.stringContaining("<rtk_instructions>"),
        }),
      });

      clearSessionOptimizerAttachments(threadId);
      const detachedConfig = codexThreadRuntimeParams({
        threadId,
        mcpSession: undefined,
        runtimePolicy: {
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: "/workspace/repo",
        },
      }).config;
      expect(detachedConfig).not.toHaveProperty("mcp_servers");
      expect(detachedConfig).not.toHaveProperty("openai_base_url");
    }),
  );

  it("adds CBM to Claude and Antigravity MCP servers and Headroom to the ACP environment", () => {
    attachOptimizers();
    try {
      const claude = claudeMcpQueryOverrides({
        threadId,
        mcpSession: undefined,
        readOnlySandbox: false,
      });
      expect(claude.mcpServers?.["codebase-memory"]).toEqual({
        type: "stdio",
        command: "/tools/codebase-memory-mcp",
        args: ["serve"],
        env: { CBM_ALLOWED_ROOT: "/workspace/repo" },
      });

      const antigravity = acpMcpContext(
        undefined,
        { command: "t3", entrypoint: undefined },
        undefined,
        readSessionOptimizerAttachments(threadId),
      );
      expect(antigravity.servers).toContainEqual({
        name: "codebase-memory",
        command: "/tools/codebase-memory-mcp",
        args: ["serve"],
        env: [{ name: "CBM_ALLOWED_ROOT", value: "/workspace/repo" }],
      });
      expect(antigravity.processEnvironment).toMatchObject({
        HEADROOM_ACTIVE: "1",
        HEADROOM_PROXY_URL: "http://127.0.0.1:6767",
      });
    } finally {
      clearSessionOptimizerAttachments(threadId);
    }

    expect(
      claudeMcpQueryOverrides({ threadId, mcpSession: undefined, readOnlySandbox: false }),
    ).toEqual({});
    expect(
      acpMcpContext(
        undefined,
        { command: "t3", entrypoint: undefined },
        undefined,
        readSessionOptimizerAttachments(threadId),
      ),
    ).toEqual({
      servers: [],
      acpServers: [],
      httpServers: [],
    });
  });

  it("builds the generic Headroom routing environment for Antigravity", () => {
    expect(HeadroomRouting.resolveHeadroomEnvironment("http://localhost:6767")).toEqual({
      HEADROOM_ACTIVE: "1",
      HEADROOM_PROXY_URL: "http://localhost:6767",
    });
    expect(HeadroomRouting.resolveHeadroomEnvironment("https://example.com")).toBeUndefined();
  });
});
