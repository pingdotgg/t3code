import { describe, expect, it } from "vite-plus/test";

import type * as EffectAcpSchema from "effect-acp/compat";

import {
  decideToolCallUpdateEmission,
  applyAcpAgentTerminalUpdate,
  acpContentBlockDisplayText,
  embeddedTerminalIdsFromSessionUpdate,
  extractMcpToolCallIdentity,
  mergeToolCallState,
  parsePermissionRequest,
  parseSessionModeState,
  parseSessionUpdateEvent,
  sessionModelStateFromInitialize,
  sessionUpdateCountsAsLoadReplayActivity,
  sessionUpdateIsReplay,
  syntheticLoadSessionResponseFromInitialize,
  toolCallProgressLength,
  withTrackedPermissionToolCall,
  type AcpToolCallState,
} from "./runtimeModel.ts";





describe("extractMcpToolCallIdentity", () => {
  function toolCallFromUpdate(
    update: EffectAcpSchema.SessionNotification["update"],
  ): NonNullable<ReturnType<typeof parsePermissionRequest>["toolCall"]> {
    const parsed = parseSessionUpdateEvent({ sessionId: "session-1", update });
    const event = parsed.events.find(
      (
        candidate,
      ): candidate is Extract<(typeof parsed.events)[number], { _tag: "ToolCallUpdated" }> =>
        candidate._tag === "ToolCallUpdated",
    );
    if (event === undefined) throw new Error("expected a tool call event");
    return event.toolCall;
  }

  it("recovers server and tool from codex-acp tagged execute calls", () => {
    const toolCall = toolCallFromUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "exec-f4591587-0754-4bb4-990b-f2767894ba93",
      kind: "execute",
      title: "mcp.t3-code.orchestrator_capabilities",
      status: "in_progress",
      rawInput: { server: "t3-code", tool: "orchestrator_capabilities", arguments: {} },
      _meta: { is_mcp_tool_call: true },
    });

    expect(extractMcpToolCallIdentity(toolCall)).toEqual({
      server: "t3-code",
      tool: "orchestrator_capabilities",
    });
  });

  it("recovers T3 identity from acp-mcp-call fallback commands", () => {
    const toolCall = toolCallFromUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "exec-1",
      kind: "execute",
      title: "Ran command",
      status: "in_progress",
    });

    expect(
      extractMcpToolCallIdentity(toolCall, {
        embeddedTerminalCommands: [
          '/usr/bin/node /srv/t3/bin.ts acp-mcp-call delegate_task {"task":"x"}',
        ],
      }),
    ).toEqual({ server: "t3-code", tool: "delegate_task", input: { task: "x" } });
  });

  it("recovers T3 identity from pi-acp title-only fallback execs", () => {
    const toolCall = toolCallFromUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "call_JdxnvzjHHrbvyASTLVekLYWV|fc_08f5a805a7159aa6016a7ec4afad548191",
      kind: "execute",
      title:
        '"$T3_ACP_MCP_NODE" "$T3_ACP_MCP_ENTRYPOINT" acp-mcp-call orchestrator_capabilities \'{}\'',
      status: "in_progress",
      rawInput: null,
      content: [
        {
          type: "terminal",
          terminalId: "call_JdxnvzjHHrbvyASTLVekLYWV|fc_08f5a805a7159aa6016a7ec4afad548191",
        },
      ],
    });

    expect(toolCall.title).toBe("Ran command");
    expect(extractMcpToolCallIdentity(toolCall)).toEqual({
      server: "t3-code",
      tool: "orchestrator_capabilities",
      input: {},
    });
  });

  it("recovers T3 identity from server-namespaced titles across titleless updates", () => {
    const created = toolCallFromUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "chatcmpl-tool-b2a6142ee1a510a5",
      kind: "other",
      title: "t3-code_orchestrator_capabilities",
      status: "pending",
      locations: [],
      rawInput: {},
    });
    const completed = toolCallFromUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "chatcmpl-tool-b2a6142ee1a510a5",
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: '{"ok":true}' } }],
    });
    const merged = mergeToolCallState(created, completed);

    expect(extractMcpToolCallIdentity(merged)).toEqual({
      server: "t3-code",
      tool: "orchestrator_capabilities",
    });
  });

  it("recovers T3 identity across the registry agents' naming conventions", () => {
    for (const title of [
      "t3-code___delegate_task",
      "t3-code-delegate_task",
      'mcp__t3_code__delegate_task: {"mode":"async"}',
      't3-code__delegate_task: {"mode":"async"}',
      "delegate_task_t3-code",
      "t3-code/delegate_task",
      "delegate_task",
      'delegate_task: {"mode":"async"}',
      // Kimi retitles with partial JSON and middle-truncates args over 50 characters.
      'delegate_task: {"mode":"async","task":"Ru',
      'delegate_task: {"mode":"async","task":"Ru...cho child-result-42\'"}',
    ]) {
      const toolCall = toolCallFromUpdate({
        sessionUpdate: "tool_call",
        toolCallId: "convention-1",
        kind: "other",
        title,
        status: "pending",
      });
      expect(extractMcpToolCallIdentity(toolCall), title).toEqual({
        server: "t3-code",
        tool: "delegate_task",
      });
    }
  });

  it("recovers T3 identity from Kiro's @-scoped titles", () => {
    for (const tool of ["html_render", "t3_thread_read", "delegate_task"]) {
      const toolCall = toolCallFromUpdate({
        sessionUpdate: "tool_call",
        toolCallId: "kiro-1",
        kind: "other",
        title: `@t3-code/${tool}`,
        status: "pending",
        rawInput: { tool_id: `t3-code::${tool}`, arguments: { threadId: "thread-1" } },
      });
      expect(extractMcpToolCallIdentity(toolCall), tool).toEqual({ server: "t3-code", tool });
    }
  });

  it("does not claim an agent's own tool that shares a T3 tool name", () => {
    const toolCall = toolCallFromUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "own-delegate-1",
      kind: "execute",
      title: "delegate_task: 1 tasks: Run the terminal command 'echo child-result-42'",
      status: "pending",
    });
    expect(extractMcpToolCallIdentity(toolCall)).toBeUndefined();
  });

  it("recovers T3 identity from goose _meta despite LLM-rewritten titles", () => {
    // goose titles change asynchronously; only _meta.goose.toolCall is stable.
    const toolCall = toolCallFromUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "goose-1",
      title: "Checking on the delegated task",
      status: "in_progress",
      _meta: {
        goose: {
          toolCall: { toolName: "t3-code__task_status", extensionName: "t3-code" },
          messageId: "message-1",
        },
      },
    });

    expect(extractMcpToolCallIdentity(toolCall)).toEqual({
      server: "t3-code",
      tool: "task_status",
    });
  });

  it("recovers T3 identity from qwen serverId meta regardless of prefix format", () => {
    // qwen-code 0.21.12 serverId asserts MCP origin even when tool prefixes change.
    const toolCall = toolCallFromUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "qwen-meta-1",
      kind: "other",
      title: "unrelated display title",
      status: "pending",
      _meta: { toolName: "mcp::t3-code::t3_thread_send", serverId: "t3-code", provenance: "mcp" },
    });

    expect(extractMcpToolCallIdentity(toolCall)).toEqual({
      server: "t3-code",
      tool: "t3_thread_send",
    });
  });

  it.each([
    { _meta: { claudeCode: { toolName: "mcp__weather__get_weather" } } },
    { _meta: { toolName: "mcp::weather::get_weather", serverId: "weather" } },
  ])("recovers external MCP identity from provider metadata", (metadata) => {
    const toolCall = toolCallFromUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "weather-call",
      title: "Checking the forecast",
      status: "in_progress",
      ...metadata,
    });
    expect(extractMcpToolCallIdentity(toolCall)).toEqual({
      server: "weather",
      tool: "get_weather",
    });
  });

  it.each([
    { kind: "execute", toolName: "developer__shell", extensionName: "developer" },
    { kind: "edit", toolName: "developer__edit", extensionName: "developer" },
    { kind: "other", toolName: "weather__get_weather", extensionName: "weather" },
  ] as const)(
    "leaves goose $toolName unclassified so built-ins keep their projection",
    ({ kind, toolName, extensionName }) => {
      // goose tags built-in extensions exactly like user MCP servers.
      const toolCall = toolCallFromUpdate({
        sessionUpdate: "tool_call",
        toolCallId: "goose-builtin",
        kind,
        title: "developer: shell",
        status: "in_progress",
        _meta: { goose: { toolCall: { toolName, extensionName } } },
      });
      expect(extractMcpToolCallIdentity(toolCall)).toBeUndefined();
    },
  );

  it("uses the asserted server instead of a misleading T3 title", () => {
    const toolCall = toolCallFromUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "foreign-1",
      kind: "other",
      title: "t3-code_delegate_task",
      status: "pending",
      _meta: { toolName: "delegate_task", serverId: "other-orchestrator" },
    });

    expect(extractMcpToolCallIdentity(toolCall)).toEqual({
      server: "other-orchestrator",
      tool: "delegate_task",
    });
  });

  it("does not brand path-like or unknown-tool titles", () => {
    for (const title of ["t3-code/README.md", "t3-code_not_a_real_tool"]) {
      const toolCall = toolCallFromUpdate({
        sessionUpdate: "tool_call",
        toolCallId: "path-1",
        kind: "other",
        title,
        status: "pending",
      });
      expect(extractMcpToolCallIdentity(toolCall), title).toBeUndefined();
    }
  });

  it("leaves ordinary execute calls unidentified", () => {
    const toolCall = toolCallFromUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "exec-2",
      kind: "execute",
      title: "cat package.json",
      status: "in_progress",
      rawInput: { command: "cat package.json" },
    });

    expect(extractMcpToolCallIdentity(toolCall)).toBeUndefined();
    expect(
      extractMcpToolCallIdentity(toolCall, { embeddedTerminalCommands: ["bash -lc ls"] }),
    ).toBeUndefined();
  });

  it("does not treat generic raw server and tool fields as MCP provenance", () => {
    const toolCall = toolCallFromUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "generic-1",
      kind: "other",
      title: "Deploy",
      status: "pending",
      rawInput: { server: "production", tool: "deploy" },
    });

    expect(extractMcpToolCallIdentity(toolCall)).toBeUndefined();
  });
});

