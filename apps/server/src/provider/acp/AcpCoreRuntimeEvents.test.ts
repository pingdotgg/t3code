import { ProviderDriverKind, RuntimeRequestId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  makeAcpToolCallEvent,
} from "./AcpCoreRuntimeEvents.ts";

describe("AcpCoreRuntimeEvents", () => {
  it("maps ACP permission requests to canonical runtime events", () => {
    const stamp = { eventId: "event-1" as never, createdAt: "2026-03-27T00:00:00.000Z" };
    const turnId = TurnId.make("turn-1");
    const permissionRequest = {
      kind: "execute" as const,
      detail: "cat package.json",
      toolCall: {
        toolCallId: "tool-1",
        kind: "execute",
        status: "pending" as const,
        command: "cat package.json",
        detail: "cat package.json",
        data: { toolCallId: "tool-1", kind: "execute" },
      },
    };

    const openedEvent = makeAcpRequestOpenedEvent({
      stamp,
      provider: ProviderDriverKind.make("cursor"),
      threadId: "thread-1" as never,
      turnId,
      requestId: RuntimeRequestId.make("request-1"),
      permissionRequest,
      detail: "cat package.json",
      args: { command: ["cat", "package.json"] },
      source: "acp.jsonrpc",
      method: "session/request_permission",
      rawPayload: { sessionId: "session-1" },
    });
    expect(openedEvent).toMatchObject({
      type: "request.opened",
      payload: {
        requestType: "exec_command_approval",
        detail: "cat package.json",
      },
    });
    expect(openedEvent).not.toHaveProperty("payload.options");

    expect(
      makeAcpRequestResolvedEvent({
        stamp,
        provider: ProviderDriverKind.make("cursor"),
        threadId: "thread-1" as never,
        turnId,
        requestId: RuntimeRequestId.make("request-1"),
        permissionRequest,
        decision: "accept",
      }),
    ).toMatchObject({
      type: "request.resolved",
      payload: {
        requestType: "exec_command_approval",
        decision: "accept",
      },
    });
  });

  it("preserves a native file approval without a remembered-allow choice", () => {
    const event = makeAcpRequestOpenedEvent({
      stamp: { eventId: "approval-1" as never, createdAt: "2026-09-02T00:00:00.000Z" },
      provider: ProviderDriverKind.make("antigravity"),
      threadId: "thread-1" as never,
      turnId: TurnId.make("turn-1"),
      requestId: RuntimeRequestId.make("request-1"),
      permissionRequest: { kind: "edit" },
      approvalOptions: [
        { decision: "accept", label: "Allow once" },
        { decision: "decline", label: "Reject" },
      ],
      detail: "Edit package.json",
      args: {},
      source: "acp.jsonrpc",
      method: "session/request_permission",
      rawPayload: { sessionId: "session-1" },
    });

    expect(event.payload).toEqual({
      requestType: "file_change_approval",
      detail: "Edit package.json",
      args: {},
      options: [
        { decision: "accept", label: "Allow once" },
        { decision: "decline", label: "Reject" },
      ],
    });
  });

  it("maps generic ACP permission kinds to dynamic tool approvals", () => {
    const stamp = { eventId: "event-1" as never, createdAt: "2026-03-27T00:00:00.000Z" };

    for (const kind of ["search", "fetch", "other", "unknown", "future-tool-kind"]) {
      const permissionRequest = { kind };
      const request = {
        stamp,
        provider: ProviderDriverKind.make("cursor"),
        threadId: "thread-1" as never,
        turnId: TurnId.make("turn-1"),
        requestId: RuntimeRequestId.make(`request-${kind}`),
        permissionRequest,
      };

      expect(
        makeAcpRequestOpenedEvent({
          ...request,
          detail: kind,
          args: {},
          source: "acp.jsonrpc",
          method: "session/request_permission",
          rawPayload: { sessionId: "session-1" },
        }),
      ).toMatchObject({
        type: "request.opened",
        payload: { requestType: "dynamic_tool_call" },
      });

      expect(
        makeAcpRequestResolvedEvent({
          ...request,
          decision: "accept",
        }),
      ).toMatchObject({
        type: "request.resolved",
        payload: { requestType: "dynamic_tool_call" },
      });
    }
  });

  it("maps ACP core plan, tool-call, and content updates", () => {
    const stamp = { eventId: "event-1" as never, createdAt: "2026-03-27T00:00:00.000Z" };
    const turnId = TurnId.make("turn-1");

    expect(
      makeAcpPlanUpdatedEvent({
        stamp,
        provider: ProviderDriverKind.make("cursor"),
        threadId: "thread-1" as never,
        turnId,
        payload: {
          plan: [{ step: "Inspect state", status: "inProgress" }],
        },
        source: "acp.cursor.extension",
        method: "cursor/update_todos",
        rawPayload: { todos: [] },
      }),
    ).toMatchObject({
      type: "turn.plan.updated",
      raw: {
        method: "cursor/update_todos",
      },
    });

    expect(
      makeAcpToolCallEvent({
        stamp,
        provider: ProviderDriverKind.make("cursor"),
        threadId: "thread-1" as never,
        turnId,
        toolCall: {
          toolCallId: "tool-1",
          kind: "execute",
          status: "completed",
          title: "Terminal",
          detail: "bun run test",
          data: { command: "bun run test" },
        },
        rawPayload: { sessionId: "session-1" },
      }),
    ).toMatchObject({
      type: "item.completed",
      payload: {
        itemType: "command_execution",
        status: "completed",
      },
    });

    expect(
      makeAcpContentDeltaEvent({
        stamp,
        provider: ProviderDriverKind.make("cursor"),
        threadId: "thread-1" as never,
        turnId,
        itemId: "assistant:session-1:segment:0",
        text: "hello",
        rawPayload: { sessionId: "session-1" },
      }),
    ).toMatchObject({
      type: "content.delta",
      itemId: "assistant:session-1:segment:0",
      payload: {
        delta: "hello",
      },
    });

    expect(
      makeAcpAssistantItemEvent({
        stamp,
        provider: ProviderDriverKind.make("cursor"),
        threadId: "thread-1" as never,
        turnId,
        itemId: "assistant:session-1:segment:0",
        lifecycle: "item.started",
      }),
    ).toMatchObject({
      type: "item.started",
      itemId: "assistant:session-1:segment:0",
      payload: {
        itemType: "assistant_message",
        status: "inProgress",
      },
    });
  });

  it("maps thoughts to the reasoning stream", () => {
    expect(
      makeAcpContentDeltaEvent({
        stamp: { eventId: "thought-1" as never, createdAt: "2026-09-02T00:00:00.000Z" },
        provider: ProviderDriverKind.make("cursor"),
        threadId: "thread-1" as never,
        turnId: TurnId.make("turn-1"),
        streamKind: "reasoning_text",
        text: "Inspect the current implementation first.",
        rawPayload: { sessionId: "session-1" },
      }),
    ).toMatchObject({
      type: "content.delta",
      payload: {
        streamKind: "reasoning_text",
        delta: "Inspect the current implementation first.",
      },
    });
  });
});
