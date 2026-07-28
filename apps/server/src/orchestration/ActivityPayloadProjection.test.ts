import {
  EventId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { projectActivityEvent, projectActivityPayload } from "./ActivityPayloadProjection.ts";

function activity(
  id: string,
  itemType: string,
  data: Record<string, unknown>,
): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    tone: "tool",
    kind: "tool.completed",
    summary: `Completed ${itemType}`,
    payload: {
      itemType,
      title: itemType,
      detail: `${itemType} detail`,
      status: "completed",
      requestKind: "command",
      data,
    },
    turnId: TurnId.make(`turn-${id}`),
    createdAt: "2026-07-27T00:00:00.000Z",
  };
}

describe("projectActivityPayload", () => {
  it("retains compact command, file, correlation, and output fields", () => {
    const source = activity("command", "command_execution", {
      item: {
        command: ["bash", "-lc", "pnpm test"],
        input: { command: "fallback input", ignored: "input bulk" },
        result: { command: "fallback result", aggregatedOutput: "x".repeat(10_000) },
        changes: [{ oldPath: "src/old.ts", newPath: "src/new.ts", patch: "patch".repeat(5_000) }],
      },
      command: "fallback data",
      kind: "execute",
      toolCallId: "tool-command",
      rawOutput: {
        content: "\n```\nfirst useful line\nsecond line",
        ignored: "raw bulk",
      },
      ignored: "top-level bulk",
    });

    expect(projectActivityPayload(source).payload).toEqual({
      itemType: "command_execution",
      title: "command_execution",
      detail: "command_execution detail",
      status: "completed",
      requestKind: "command",
      data: {
        item: {
          command: ["bash", "-lc", "pnpm test"],
          input: { command: "fallback input" },
          result: { command: "fallback result" },
        },
        command: "fallback data",
        files: [{ path: "src/new.ts" }, { path: "src/old.ts" }],
        toolCallId: "tool-command",
        kind: "execute",
        rawOutput: { content: "first useful line" },
      },
    });
  });

  it("cuts large non-MCP activity payloads by more than ninety percent", () => {
    const source = activity("large", "command_execution", {
      item: {
        command: ["bash", "-lc", "pnpm test"],
        aggregatedOutput: "x".repeat(100_000),
      },
      rawOutput: { content: `summary\n${"y".repeat(100_000)}` },
    });
    const originalBytes = JSON.stringify(source).length;
    const projectedBytes = JSON.stringify(projectActivityPayload(source)).length;

    expect(projectedBytes).toBeLessThan(originalBytes / 10);
  });

  it("passes MCP payloads through because clients render their structured data", () => {
    const source = activity("mcp", "mcp_tool_call", {
      item: { server: "repository", tool: "search", arguments: { query: "projection" } },
    });
    expect(projectActivityPayload(source)).toBe(source);
  });

  it("projects activity events without mutating the persisted event value", () => {
    const source = activity("event", "dynamic_tool_call", {
      toolCallId: "tool-event",
      rawOutput: { stdout: `result\n${"z".repeat(10_000)}` },
      ignored: "bulk",
    });
    const event = {
      sequence: 8,
      eventId: EventId.make("event-activity"),
      aggregateKind: "thread",
      aggregateId: ThreadId.make("thread-projection"),
      occurredAt: "2026-07-27T00:00:01.000Z",
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "thread.activity-appended",
      payload: {
        threadId: ThreadId.make("thread-projection"),
        activity: source,
      },
    } as Extract<OrchestrationEvent, { type: "thread.activity-appended" }>;

    const projected = projectActivityEvent(event);
    expect(projected).not.toBe(event);
    expect(event.payload.activity).toBe(source);
    expect(
      projected.type === "thread.activity-appended" ? projected.payload.activity : undefined,
    ).toEqual(projectActivityPayload(source));
  });
});
