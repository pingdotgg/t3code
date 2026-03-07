import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  CursorAcpPermissionRequest,
  CursorAcpSessionPromptResult,
  CursorAcpSessionUpdateNotification,
} from "./CursorAdapter.ts";

describe("Cursor ACP schemas", () => {
  it("decodes session/update thought and message chunks", () => {
    const thought = Schema.decodeUnknownSync(CursorAcpSessionUpdateNotification)({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess-1",
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: {
            type: "text",
            text: "thinking",
          },
        },
      },
    });

    expect(thought.params.update.sessionUpdate).toBe("agent_thought_chunk");

    const message = Schema.decodeUnknownSync(CursorAcpSessionUpdateNotification)({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: "hello",
          },
        },
      },
    });

    expect(message.params.update.sessionUpdate).toBe("agent_message_chunk");
  });

  it("decodes tool call lifecycle updates", () => {
    const started = Schema.decodeUnknownSync(CursorAcpSessionUpdateNotification)({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess-1",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "tool-1",
          title: "Terminal",
          kind: "execute",
          status: "pending",
          rawInput: { command: "pwd" },
        },
      },
    });

    expect(started.params.update.sessionUpdate).toBe("tool_call");

    const completed = Schema.decodeUnknownSync(CursorAcpSessionUpdateNotification)({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess-1",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "tool-1",
          status: "completed",
          rawOutput: {
            exitCode: 0,
            stdout: "ok",
            stderr: "",
          },
        },
      },
    });

    expect(completed.params.update.sessionUpdate).toBe("tool_call_update");
  });

  it("decodes permission requests", () => {
    const decoded = Schema.decodeUnknownSync(CursorAcpPermissionRequest)({
      jsonrpc: "2.0",
      id: 9,
      method: "session/request_permission",
      params: {
        sessionId: "sess-1",
        toolCall: {
          toolCallId: "tool-1",
          kind: "execute",
        },
        options: [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "reject-once", name: "Reject", kind: "reject_once" },
        ],
      },
    });

    expect(decoded.method).toBe("session/request_permission");
    expect(decoded.params.options).toHaveLength(2);
  });

  it("decodes prompt completion result payload", () => {
    const decoded = Schema.decodeUnknownSync(CursorAcpSessionPromptResult)({
      stopReason: "end_turn",
    });

    expect(decoded.stopReason).toBe("end_turn");
  });

  it("rejects unsupported update types", () => {
    expect(() =>
      Schema.decodeUnknownSync(CursorAcpSessionUpdateNotification)({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "sess-1",
          update: {
            sessionUpdate: "unknown_update",
          },
        },
      }),
    ).toThrow();
  });
});
