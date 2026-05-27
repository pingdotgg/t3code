import { describe, expect, it } from "vitest";

import { extractAssistantText, readPiAssistantTextDelta, type PiRpcLine } from "./PiRpc.ts";

describe("extractAssistantText", () => {
  it("prefers the final assistant message over streamed reasoning and tool-call deltas", () => {
    const events: PiRpcLine[] = [
      {
        type: "message_update",
        assistantMessageEvent: {
          type: "thinking_delta",
          delta: "Considering scanning options\n",
        },
      },
      {
        type: "message_update",
        assistantMessageEvent: {
          type: "toolcall_delta",
          delta: '{"command":"pwd; ls -la","timeout":10}',
        },
      },
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              name: "bash",
              arguments: { command: "pwd; ls -la", timeout: 10 },
            },
          ],
        },
      },
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "This project folder is a fresh agent workspace.",
            },
          ],
        },
      },
    ];

    expect(extractAssistantText(events)).toBe("This project folder is a fresh agent workspace.");
  });

  it("falls back to streamed deltas when no final assistant message is available", () => {
    const events: PiRpcLine[] = [
      {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "partial " },
      },
      {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "answer" },
      },
    ];

    expect(extractAssistantText(events)).toBe("partial answer");
  });

  it("streams only text_delta events as visible assistant text", () => {
    expect(
      readPiAssistantTextDelta({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "visible" },
      }),
    ).toBe("visible");
    expect(
      readPiAssistantTextDelta({
        type: "message_update",
        assistantMessageEvent: { type: "thinking_delta", delta: "hidden" },
      }),
    ).toBe("");
    expect(
      readPiAssistantTextDelta({
        type: "message_update",
        assistantMessageEvent: { type: "toolcall_delta", delta: '{"path":"SOUL.md"}' },
      }),
    ).toBe("");
  });
});
