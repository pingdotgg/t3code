import { describe, expect, it } from "vitest";

import { classifyCodexSessionKind, parseCodexTranscript } from "./parseCodexTranscript.js";

describe("parseCodexTranscript", () => {
  it("parses importable text messages and transcript context", () => {
    const raw = [
      JSON.stringify({
        type: "turn_context",
        payload: {
          model: "gpt-5-codex",
          sandbox_policy: { type: "danger-full-access" },
          collaboration_mode: { mode: "plan" },
        },
      }),
      JSON.stringify({
        timestamp: "2026-01-01T00:00:00.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: "skip me" }],
        },
      }),
      JSON.stringify({
        timestamp: "2026-01-01T00:00:01.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "Hello" },
            { type: "input_image", data: "ignored" },
          ],
        },
      }),
      JSON.stringify({
        timestamp: "2026-01-01T00:00:02.000Z",
        type: "response_item",
        payload: {
          type: "reasoning",
          role: "assistant",
          content: [{ type: "text", text: "ignored" }],
        },
      }),
      JSON.stringify({
        timestamp: "2026-01-01T00:00:03.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [
            { type: "output_text", text: "Hi" },
            { type: "text", text: " there" },
          ],
        },
      }),
    ].join("\n");

    const parsed = parseCodexTranscript(raw);

    expect(parsed.model).toBe("gpt-5-codex");
    expect(parsed.runtimeMode).toBe("full-access");
    expect(parsed.interactionMode).toBe("plan");
    expect(parsed.messages).toEqual([
      {
        role: "user",
        text: "Hello",
        createdAt: "2026-01-01T00:00:01.000Z",
        updatedAt: "2026-01-01T00:00:01.000Z",
      },
      {
        role: "assistant",
        text: "Hi there",
        createdAt: "2026-01-01T00:00:03.000Z",
        updatedAt: "2026-01-01T00:00:03.000Z",
      },
    ]);
  });

  it("normalizes numeric timestamps to ISO strings", () => {
    const raw = JSON.stringify({
      timestamp: 1_735_689_600,
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Hello" }],
      },
    });

    const parsed = parseCodexTranscript(raw);
    expect(parsed.messages[0]?.createdAt).toBe("2025-01-01T00:00:00.000Z");
  });

  it("classifies direct, subagent-child, and orchestrator sessions", () => {
    expect(
      classifyCodexSessionKind({
        source: "interactive",
        messages: [{ role: "user", text: "plain prompt", createdAt: "1", updatedAt: "1" }],
      }),
    ).toBe("direct");

    expect(
      classifyCodexSessionKind({
        source: "thread_spawn/subagent",
        messages: [{ role: "user", text: "child prompt", createdAt: "1", updatedAt: "1" }],
      }),
    ).toBe("subagent-child");

    expect(
      classifyCodexSessionKind({
        source: "interactive",
        messages: [
          {
            role: "user",
            text: "subagent_notification: child completed",
            createdAt: "1",
            updatedAt: "1",
          },
        ],
      }),
    ).toBe("orchestrator");
  });
});
