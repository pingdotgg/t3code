import { describe, expect, it } from "vite-plus/test";

import type * as EffectAcpSchema from "effect-acp/schema";

import {
  embeddedTerminalIdsFromSessionUpdate,
  extractMcpToolCallIdentity,
  extractModelConfigId,
  mergeToolCallState,
  parsePermissionRequest,
  parseSessionModeState,
  parseSessionUpdateEvent,
  sessionUpdateCountsAsLoadReplayActivity,
  sessionUpdateIsReplay,
  syntheticLoadSessionResponseFromInitialize,
} from "./AcpRuntimeModel.ts";

describe("AcpRuntimeModel", () => {
  it("parses session mode state from typed ACP session setup responses", () => {
    const modeState = parseSessionModeState({
      sessionId: "session-1",
      modes: {
        currentModeId: " code ",
        availableModes: [
          { id: " ask ", name: " Ask ", description: " Request approval " },
          { id: " code ", name: " Code " },
        ],
      },
      configOptions: [],
    } satisfies EffectAcpSchema.NewSessionResponse);

    expect(modeState).toEqual({
      currentModeId: "code",
      availableModes: [
        { id: "ask", name: "Ask", description: "Request approval" },
        { id: "code", name: "Code" },
      ],
    });
  });

  it("extracts the model config id from typed ACP config options", () => {
    const modelConfigId = extractModelConfigId({
      sessionId: "session-1",
      configOptions: [
        {
          id: "approval",
          name: "Approval Mode",
          category: "permission",
          type: "select",
          currentValue: "ask",
          options: [{ value: "ask", name: "Ask" }],
        },
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "default",
          options: [{ value: "default", name: "Auto" }],
        },
      ],
    } satisfies EffectAcpSchema.NewSessionResponse);

    expect(modelConfigId).toBe("model");
  });

  it("detects Grok session replay updates from _meta.isReplay", () => {
    expect(
      sessionUpdateIsReplay({
        _meta: { isReplay: true },
        sessionId: "session-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "replayed" },
        },
      } satisfies EffectAcpSchema.SessionNotification),
    ).toBe(true);
    expect(
      sessionUpdateIsReplay({
        sessionId: "session-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "live" },
        },
      } satisfies EffectAcpSchema.SessionNotification),
    ).toBe(false);
  });

  it("ignores Grok keepalive chunks when tracking session/load replay activity", () => {
    expect(
      sessionUpdateCountsAsLoadReplayActivity({
        sessionId: "session-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "" },
        },
      } satisfies EffectAcpSchema.SessionNotification),
    ).toBe(false);
    expect(
      sessionUpdateCountsAsLoadReplayActivity({
        _meta: { isReplay: true },
        sessionId: "session-1",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "replay-tool",
          title: "Replay",
          kind: "search",
          status: "completed",
        },
      } satisfies EffectAcpSchema.SessionNotification),
    ).toBe(true);
  });

  it("ignores load-replay activity from other sessions while a load gate is active", () => {
    expect(
      sessionUpdateCountsAsLoadReplayActivity(
        {
          sessionId: "session-other",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "unrelated" },
          },
        } satisfies EffectAcpSchema.SessionNotification,
        "session-loading",
      ),
    ).toBe(false);
    expect(
      sessionUpdateCountsAsLoadReplayActivity(
        {
          sessionId: "session-loading",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "replay" },
          },
        } satisfies EffectAcpSchema.SessionNotification,
        "session-loading",
      ),
    ).toBe(true);
  });

  it("counts mode/config/session/usage updates as load-replay activity", () => {
    expect(
      sessionUpdateCountsAsLoadReplayActivity({
        sessionId: "session-1",
        update: {
          sessionUpdate: "current_mode_update",
          currentModeId: "code",
        },
      } satisfies EffectAcpSchema.SessionNotification),
    ).toBe(true);
    expect(
      sessionUpdateCountsAsLoadReplayActivity({
        sessionId: "session-1",
        update: {
          sessionUpdate: "config_option_update",
          configOptions: [],
        },
      } satisfies EffectAcpSchema.SessionNotification),
    ).toBe(true);
    expect(
      sessionUpdateCountsAsLoadReplayActivity({
        sessionId: "session-1",
        update: {
          sessionUpdate: "session_info_update",
          title: "Restored",
        },
      } satisfies EffectAcpSchema.SessionNotification),
    ).toBe(true);
    expect(
      sessionUpdateCountsAsLoadReplayActivity({
        sessionId: "session-1",
        update: {
          sessionUpdate: "usage_update",
          used: 1,
          size: 10,
        },
      } satisfies EffectAcpSchema.SessionNotification),
    ).toBe(true);
  });

  it("ignores malformed initialize mode state in synthetic load responses", () => {
    const response = syntheticLoadSessionResponseFromInitialize({
      protocolVersion: 1,
      _meta: {
        modeState: {
          currentModeId: "code",
          availableModes: [{ id: "code", name: 12 }],
        },
      },
    } as EffectAcpSchema.InitializeResponse);

    expect(response.modes).toBeUndefined();
    expect(response._meta).toMatchObject({ t3SessionLoadReady: "replay_idle" });
  });

  it("builds a synthetic load response with initialize mode state", () => {
    const response = syntheticLoadSessionResponseFromInitialize({
      protocolVersion: 1,
      _meta: {
        modeState: {
          currentModeId: "code",
          availableModes: [
            { id: "ask", name: "Ask" },
            { id: "code", name: "Code" },
          ],
        },
      },
    } satisfies EffectAcpSchema.InitializeResponse);

    expect(response.modes?.currentModeId).toBe("code");
    expect(response.modes?.availableModes).toHaveLength(2);
  });

  it("projects typed ACP tool call updates into runtime events", () => {
    const created = parseSessionUpdateEvent({
      sessionId: "session-1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tool-1",
        title: "Terminal",
        kind: "execute",
        status: "pending",
        rawInput: {
          executable: "bun",
          args: ["run", "typecheck"],
        },
        content: [
          {
            type: "content",
            content: {
              type: "text",
              text: "Running checks",
            },
          },
        ],
      },
    } satisfies EffectAcpSchema.SessionNotification);

    expect(created.events).toEqual([
      {
        _tag: "ToolCallUpdated",
        toolCall: {
          toolCallId: "tool-1",
          kind: "execute",
          title: "Ran command",
          status: "pending",
          command: "bun run typecheck",
          detail: "bun run typecheck",
          data: {
            toolCallId: "tool-1",
            kind: "execute",
            title: "Terminal",
            command: "bun run typecheck",
            rawInput: {
              executable: "bun",
              args: ["run", "typecheck"],
            },
            content: [
              {
                type: "content",
                content: {
                  type: "text",
                  text: "Running checks",
                },
              },
            ],
          },
        },
        rawPayload: {
          sessionId: "session-1",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "tool-1",
            title: "Terminal",
            kind: "execute",
            status: "pending",
            rawInput: {
              executable: "bun",
              args: ["run", "typecheck"],
            },
            content: [
              {
                type: "content",
                content: {
                  type: "text",
                  text: "Running checks",
                },
              },
            ],
          },
        },
      },
    ]);

    const updated = parseSessionUpdateEvent({
      sessionId: "session-1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        status: "completed",
        rawOutput: { exitCode: 0 },
      },
    } satisfies EffectAcpSchema.SessionNotification);

    expect(updated.events).toHaveLength(1);
    expect(updated.events[0]?._tag).toBe("ToolCallUpdated");
    const createdEvent = created.events[0];
    const updatedEvent = updated.events[0];
    if (createdEvent?._tag === "ToolCallUpdated" && updatedEvent?._tag === "ToolCallUpdated") {
      expect(mergeToolCallState(createdEvent.toolCall, updatedEvent.toolCall)).toMatchObject({
        toolCallId: "tool-1",
        status: "completed",
        title: "Ran command",
        detail: "bun run typecheck",
        command: "bun run typecheck",
      });
    }
  });

  it("trims padded current mode updates before emitting a mode change", () => {
    const result = parseSessionUpdateEvent({
      sessionId: "session-1",
      update: {
        sessionUpdate: "current_mode_update",
        currentModeId: " code ",
      },
    } satisfies EffectAcpSchema.SessionNotification);

    expect(result.modeId).toBe("code");
    expect(result.events).toEqual([
      {
        _tag: "ModeChanged",
        modeId: "code",
      },
    ]);
  });

  it("projects typed ACP plan and content updates", () => {
    const planResult = parseSessionUpdateEvent({
      sessionId: "session-1",
      update: {
        sessionUpdate: "plan",
        entries: [
          { content: " Inspect state ", priority: "high", status: "completed" },
          { content: "", priority: "medium", status: "in_progress" },
        ],
      },
    } satisfies EffectAcpSchema.SessionNotification);

    expect(planResult.events).toEqual([
      {
        _tag: "PlanUpdated",
        payload: {
          plan: [
            { step: "Inspect state", status: "completed" },
            { step: "Step 2", status: "inProgress" },
          ],
        },
        rawPayload: {
          sessionId: "session-1",
          update: {
            sessionUpdate: "plan",
            entries: [
              { content: " Inspect state ", priority: "high", status: "completed" },
              { content: "", priority: "medium", status: "in_progress" },
            ],
          },
        },
      },
    ]);

    const contentResult = parseSessionUpdateEvent({
      sessionId: "session-1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: "hello from acp",
        },
      },
    } satisfies EffectAcpSchema.SessionNotification);

    expect(contentResult.events).toEqual([
      {
        _tag: "ContentDelta",
        text: "hello from acp",
        rawPayload: {
          sessionId: "session-1",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: "hello from acp",
            },
          },
        },
      },
    ]);
  });

  it("keeps permission request parsing compatible with loose extension payloads", () => {
    const request = parsePermissionRequest({
      sessionId: "session-1",
      options: [
        {
          optionId: "allow-once",
          name: "Allow once",
          kind: "allow_once",
        },
      ],
      toolCall: {
        toolCallId: "tool-1",
        title: "`cat package.json`",
        kind: "execute",
        status: "pending",
        content: [
          {
            type: "content",
            content: {
              type: "text",
              text: "Not in allowlist",
            },
          },
        ],
      },
    });

    expect(request).toMatchObject({
      kind: "execute",
      detail: "cat package.json",
      toolCall: {
        toolCallId: "tool-1",
        kind: "execute",
        status: "pending",
        command: "cat package.json",
      },
    });
  });
});

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
    // Captured verbatim from codex-acp 2026-08-14: MCP calls arrive as kind
    // "execute" with the identity only in rawInput.
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
    ).toEqual({ server: "t3-code", tool: "delegate_task" });
  });

  it("recovers T3 identity from pi-acp title-only fallback execs", () => {
    // Captured verbatim from pi-acp 0.0.33 2026-08-14: rawInput is null and
    // the command line only appears as the verbatim title, which the
    // presentation layer summarizes into "Ran command".
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
    });
  });

  it("recovers T3 identity from server-namespaced titles across titleless updates", () => {
    // Captured verbatim from Kilo 7.4.22 2026-08-15: the initial tool_call
    // titles the MCP function "<server>_<tool>" with kind "other", and the
    // completed update carries no title at all, so the merged presentation
    // title regresses to "Tool" while data.title keeps the wire value.
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

  it("recovers T3 identity from Gemini and qwen MCP-server title templates", () => {
    // Gemini CLI 0.55.1: "<tool> (<server> MCP Server)"; qwen-code 0.21.12
    // appends ": <args json>" to the same template.
    const gemini = toolCallFromUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "gemini-1",
      kind: "other",
      title: "delegate_task (t3-code MCP Server)",
      status: "in_progress",
    });
    const qwen = toolCallFromUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "qwen-1",
      kind: "other",
      title: 'task_status (t3-code MCP Server): {"taskId":"node:delegated-task:1"}',
      status: "pending",
      rawInput: { taskId: "node:delegated-task:1" },
    });

    expect(extractMcpToolCallIdentity(gemini)).toEqual({
      server: "t3-code",
      tool: "delegate_task",
    });
    expect(extractMcpToolCallIdentity(qwen)).toEqual({ server: "t3-code", tool: "task_status" });
  });

  it("recovers T3 identity across the registry agents' naming conventions", () => {
    // One representative per surveyed convention (2026-08 registry builds):
    // droid triple underscore, Copilot hyphen, Amp mangled server + detail
    // tail, cline args tail, Auggie tool-first suffix.
    // One representative per surveyed convention (2026-08 registry builds):
    // droid triple underscore, Copilot hyphen, Amp mangled server + detail
    // tail, cline args tail, Auggie tool-first suffix, fast-agent slash,
    // Kimi bare name with args tail.
    for (const title of [
      "t3-code___delegate_task",
      "t3-code-delegate_task",
      'mcp__t3_code__delegate_task: {"mode":"async"}',
      't3-code__delegate_task: {"mode":"async"}',
      "delegate_task_t3-code",
      "t3-code/delegate_task",
      'delegate_task: {"mode":"async"}',
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

  it("recovers T3 identity from goose _meta despite LLM-rewritten titles", () => {
    // goose enriches titles asynchronously, so only _meta.goose.toolCall is
    // stable; shape from crates/goose/src/acp/server/tool_calls/conversion.rs.
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
    // qwen-code 0.21.12 emits _meta.serverId + _meta.toolName; serverId is an
    // explicit origin assertion, so a known tool suffix suffices even if the
    // prefix format changes.
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

  it("does not brand tools whose meta asserts a foreign server", () => {
    // The foreign assertion vetoes every loose source, including a title
    // that would otherwise match a T3 convention.
    const toolCall = toolCallFromUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "foreign-1",
      kind: "other",
      title: "t3-code_delegate_task",
      status: "pending",
      _meta: { toolName: "delegate_task", serverId: "other-orchestrator" },
    });

    expect(extractMcpToolCallIdentity(toolCall)).toBeUndefined();
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
});

describe("embeddedTerminalIdsFromSessionUpdate", () => {
  it("collects terminal ids from tool_call content before the text rewrite", () => {
    expect(
      embeddedTerminalIdsFromSessionUpdate({
        sessionId: "session-1",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "call_1",
          status: "in_progress",
          content: [
            { type: "terminal", terminalId: "t3-term-9" },
            { type: "content", content: { type: "text", text: "noise" } },
          ],
        },
      }),
    ).toEqual({ toolCallId: "call_1", terminalIds: ["t3-term-9"] });
    expect(
      embeddedTerminalIdsFromSessionUpdate({
        sessionId: "session-1",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "call_2",
          title: "Tool",
          status: "pending",
        },
      }),
    ).toBeUndefined();
  });
});
