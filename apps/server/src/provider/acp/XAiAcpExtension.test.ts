import { describe, expect, it } from "vitest";

import { extractXAiAgentResultText, extractXAiPromptResponseText } from "./XAiAcpExtension.ts";

describe("XAiAcpExtension", () => {
  it("extracts plain agent result text", () => {
    expect(extractXAiAgentResultText(" hello from grok ")).toBe("hello from grok");
  });

  it("extracts text from nested content blocks", () => {
    expect(
      extractXAiAgentResultText({
        message: {
          content: [
            { type: "text", text: "first paragraph" },
            { type: "text", text: "second paragraph" },
          ],
        },
      }),
    ).toBe("first paragraph\nsecond paragraph");
  });

  it("extracts text from OpenAI-style choices", () => {
    expect(
      extractXAiAgentResultText({
        choices: [
          {
            message: {
              content: "choice text",
            },
          },
        ],
      }),
    ).toBe("choice text");
  });

  it("extracts text from JSON-encoded agent result payloads", () => {
    expect(
      extractXAiAgentResultText(
        JSON.stringify({
          output: [{ content: [{ text: "encoded text" }] }],
        }),
      ),
    ).toBe("encoded text");
  });

  it("returns undefined for agent result metadata without answer text", () => {
    expect(
      extractXAiAgentResultText({
        status: "completed",
        usage: { outputTokens: 8 },
      }),
    ).toBeUndefined();
  });

  it("extracts text from prompt response metadata", () => {
    expect(
      extractXAiPromptResponseText({
        stopReason: "end_turn",
        _meta: {
          agentResult: { response: "final response" },
        },
      }),
    ).toBe("final response");
  });
});
