// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { describe, expect, it } from "vite-plus/test";

import {
  PiResumeCursor,
  cumulativeToolOutputDelta,
  decodePiRpcMessage,
  encodePiRpcCommand,
  makePiJsonlDecoder,
} from "./PiRpcProtocol.ts";

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));

describe("Pi RPC protocol", () => {
  it("frames only on LF across split UTF-8 chunks and accepts CRLF", () => {
    const decoder = makePiJsonlDecoder();
    const encoded = new TextEncoder().encode(
      `${JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "left\u2028middle\u2029right" } })}\r\n${JSON.stringify({ type: "agent_settled" })}\n`,
    );

    const messages = [
      ...decoder.push(encoded.slice(0, 17)),
      ...decoder.push(encoded.slice(17, 53)),
      ...decoder.push(encoded.slice(53)),
      ...decoder.end(),
    ];

    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      type: "message_update",
      assistantMessageEvent: { delta: "left\u2028middle\u2029right" },
    });
    expect(messages[1]).toEqual({ type: "agent_settled" });
  });

  it("decodes interleaved responses, lifecycle events, tools, and dialogs", () => {
    const fixture = NodeFS.readFileSync(
      NodePath.join(__dirname, "testFixtures/turn-lifecycle.jsonl"),
    );
    const decoder = makePiJsonlDecoder();
    const messages = [
      ...decoder.push(fixture.subarray(0, 97)),
      ...decoder.push(fixture.subarray(97, 421)),
      ...decoder.push(fixture.subarray(421)),
      ...decoder.end(),
    ];

    expect(messages.map((message) => message.type)).toEqual([
      "response",
      "agent_start",
      "message_update",
      "message_update",
      "tool_execution_start",
      "tool_execution_update",
      "tool_execution_update",
      "extension_ui_request",
      "tool_execution_end",
      "agent_end",
      "compaction_start",
      "compaction_end",
      "agent_start",
      "agent_end",
      "agent_settled",
    ]);
    expect(messages.filter((message) => message.type === "agent_settled")).toHaveLength(1);
  });

  it("bounds cumulative tool output while emitting only new suffixes when possible", () => {
    const first = cumulativeToolOutputDelta(undefined, "hel", 8);
    const second = cumulativeToolOutputDelta(first.state, "hello", 8);
    const oversizedAppend = cumulativeToolOutputDelta(second.state, `hello${"x".repeat(20)}`, 8);
    const appendAfterTruncation = cumulativeToolOutputDelta(
      oversizedAppend.state,
      `hello${"x".repeat(20)}y`,
      8,
    );
    const replacement = cumulativeToolOutputDelta(second.state, "different output", 8);

    expect(first).toEqual({
      delta: "hel",
      state: { length: 3, tail: "hel" },
      replaced: false,
    });
    expect(second).toEqual({
      delta: "lo",
      state: { length: 5, tail: "hello" },
      replaced: false,
    });
    expect(oversizedAppend).toEqual({
      delta: "xxxxxxxx",
      state: { length: 25, tail: "xxxxxxxx" },
      replaced: true,
    });
    expect(appendAfterTruncation).toEqual({
      delta: "xxxxxxxy",
      state: { length: 26, tail: "xxxxxxxy" },
      replaced: true,
    });
    expect(replacement.replaced).toBe(true);
    expect(replacement.state).toEqual({ length: 16, tail: "t output" });
    expect(replacement.delta.length).toBeLessThanOrEqual(8);
  });

  it("validates dialog round-trips and a versioned durable resume cursor", () => {
    expect(
      decodePiRpcMessage({
        type: "extension_ui_request",
        id: "dialog-1",
        method: "select",
        title: "Choose",
        options: ["A", "B"],
      }),
    ).toMatchObject({ method: "select", options: ["A", "B"] });
    expect(
      encodePiRpcCommand({
        type: "extension_ui_response",
        id: "dialog-1",
        value: "B",
      }),
    ).toBe('{"type":"extension_ui_response","id":"dialog-1","value":"B"}\n');
    expect(
      PiResumeCursor.make({
        schemaVersion: 1,
        sessionFile: "/tmp/pi/session.jsonl",
        sessionId: "session-1",
        lastEntryId: "entry-9",
      }),
    ).toEqual({
      schemaVersion: 1,
      sessionFile: "/tmp/pi/session.jsonl",
      sessionId: "session-1",
      lastEntryId: "entry-9",
    });
  });

  it("rejects malformed JSON and oversized unterminated records", () => {
    const malformed = makePiJsonlDecoder();
    expect(() => malformed.push(new TextEncoder().encode("{nope}\n"))).toThrow(/invalid JSON/i);

    const oversized = makePiJsonlDecoder({ maxLineBytes: 8 });
    expect(() => oversized.push(new TextEncoder().encode("123456789"))).toThrow(/exceeded 8/i);
  });
});
