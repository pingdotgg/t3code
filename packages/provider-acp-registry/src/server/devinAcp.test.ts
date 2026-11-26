import { describe, expect, it } from "vite-plus/test";
import type * as AcpSchema from "effect-acp/compat";
import {
  extractMcpToolCallIdentity,
  mergeToolCallState,
  parseSessionUpdateEvent,
  type AcpToolCallState,
} from "@t3tools/provider-acp/server/runtimeModel";

import { normalizeDevinToolCall } from "./devinAcp.ts";

function toolCallOf(update: AcpSchema.SessionNotification["update"]): AcpToolCallState {
  const event = parseSessionUpdateEvent({ sessionId: "session-1", update }).events[0];
  if (event?._tag !== "ToolCallUpdated") throw new Error("expected a tool call update");
  return event.toolCall;
}

// Mirrors the adapter's emitTool: merge with the tracked state, then apply the flavor hook.
function emit(previous: AcpToolCallState | undefined, incoming: AcpToolCallState) {
  return normalizeDevinToolCall(mergeToolCallState(previous, incoming));
}

describe("normalizeDevinToolCall", () => {
  it.each(["html_render", "t3_thread_send"])(
    "resolves Devin's `Called %s from t3-code`",
    (tool) => {
      const started = emit(
        undefined,
        toolCallOf({
          sessionUpdate: "tool_call",
          toolCallId: "call-1",
          title: `Called ${tool} from t3-code`,
          kind: "other",
          status: "pending",
          rawInput: { title: "Chart", height: 200 },
        }),
      );
      expect(extractMcpToolCallIdentity(started)).toEqual({ server: "t3-code", tool });

      const completed = emit(
        started,
        toolCallOf({
          sessionUpdate: "tool_call_update",
          toolCallId: "call-1",
          status: "completed",
        }),
      );
      expect(completed.status).toBe("completed");
      expect(extractMcpToolCallIdentity(completed)).toEqual({ server: "t3-code", tool });
    },
  );

  it("leaves other servers' calls generic", () => {
    const tool = emit(
      undefined,
      toolCallOf({
        sessionUpdate: "tool_call",
        toolCallId: "call-2",
        title: "Called html_render from github",
        kind: "other",
        status: "pending",
        rawInput: { query: "t3" },
      }),
    );
    expect(extractMcpToolCallIdentity(tool)).toBeUndefined();
    expect(tool.data.title).toBe("Called html_render from github");
  });
});
