import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { CursorCliStreamEvent } from "./CursorAdapter.ts";

describe("CursorCliStreamEvent", () => {
  it("decodes system/init events", () => {
    const decoded = Schema.decodeUnknownSync(CursorCliStreamEvent)({
      type: "system",
      subtype: "init",
      session_id: "sess-1",
      apiKeySource: "login",
      cwd: "/tmp/project",
      model: "Auto",
      permissionMode: "default",
    });

    expect(decoded.type).toBe("system");
    if (decoded.type !== "system") {
      return;
    }
    expect(decoded.subtype).toBe("init");
    expect(decoded.session_id).toBe("sess-1");
  });

  it("decodes thinking delta/completed events", () => {
    const delta = Schema.decodeUnknownSync(CursorCliStreamEvent)({
      type: "thinking",
      subtype: "delta",
      text: "draft",
      session_id: "sess-1",
      timestamp_ms: 123,
    });

    expect(delta.type).toBe("thinking");
    if (delta.type !== "thinking") {
      return;
    }
    expect(delta.subtype).toBe("delta");

    const completed = Schema.decodeUnknownSync(CursorCliStreamEvent)({
      type: "thinking",
      subtype: "completed",
      session_id: "sess-1",
    });

    expect(completed.type).toBe("thinking");
    if (completed.type !== "thinking") {
      return;
    }
    expect(completed.subtype).toBe("completed");
  });

  it("decodes tool_call completed events with rejected results", () => {
    const decoded = Schema.decodeUnknownSync(CursorCliStreamEvent)({
      type: "tool_call",
      subtype: "completed",
      call_id: "tool-1\nline-2",
      session_id: "sess-1",
      tool_call: {
        shellToolCall: {
          args: {
            command: "rm -rf /tmp/nope",
          },
          result: {
            rejected: {
              reason: "approval denied",
            },
          },
        },
      },
    });

    expect(decoded.type).toBe("tool_call");
    if (decoded.type !== "tool_call") {
      return;
    }
    expect(decoded.subtype).toBe("completed");
    expect(decoded.call_id).toContain("\n");
  });

  it("decodes result success events with usage payload", () => {
    const decoded = Schema.decodeUnknownSync(CursorCliStreamEvent)({
      type: "result",
      subtype: "success",
      duration_ms: 100,
      duration_api_ms: 90,
      is_error: false,
      result: "OK",
      session_id: "sess-1",
      request_id: "req-1",
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 2,
        cacheWriteTokens: 1,
      },
    });

    expect(decoded.type).toBe("result");
    if (decoded.type !== "result") {
      return;
    }
    expect(decoded.subtype).toBe("success");
    expect(decoded.is_error).toBe(false);
  });

  it("decodes connection/retry lifecycle events", () => {
    const reconnecting = Schema.decodeUnknownSync(CursorCliStreamEvent)({
      type: "connection",
      subtype: "reconnecting",
      session_id: "sess-1",
    });
    expect(reconnecting.type).toBe("connection");

    const retry = Schema.decodeUnknownSync(CursorCliStreamEvent)({
      type: "retry",
      subtype: "resuming",
      session_id: "sess-1",
    });
    expect(retry.type).toBe("retry");
  });

  it("rejects unsupported stream event types", () => {
    expect(() =>
      Schema.decodeUnknownSync(CursorCliStreamEvent)({
        type: "bogus",
        session_id: "sess-1",
      }),
    ).toThrow();
  });
});
