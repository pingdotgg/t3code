import { describe, expect, it } from "vitest";

import { normalizeCodexContextWindow } from "./codexContextWindow.ts";

describe("normalizeCodexContextWindow", () => {
  it("parses the observed Codex token-count shape", () => {
    expect(
      normalizeCodexContextWindow(
        {
          info: {
            total_token_usage: {
              input_tokens: 124862,
              cached_input_tokens: 92672,
              output_tokens: 1654,
              reasoning_output_tokens: 277,
              total_tokens: 126516,
            },
            model_context_window: 258400,
          },
        },
        "2026-03-07T00:00:00.000Z",
      ),
    ).toEqual({
      provider: "codex",
      usedTokens: 126516,
      maxTokens: 258400,
      remainingTokens: 131884,
      usedPercent: 49,
      inputTokens: 124862,
      cachedInputTokens: 92672,
      outputTokens: 1654,
      reasoningOutputTokens: 277,
      updatedAt: "2026-03-07T00:00:00.000Z",
    });
  });

  it("accepts camelCase payload variants", () => {
    expect(
      normalizeCodexContextWindow(
        {
          totalTokenUsage: {
            totalTokens: 119000,
            inputTokens: 110000,
            cachedInputTokens: 60000,
            outputTokens: 9000,
          },
          modelContextWindow: 258000,
        },
        "2026-03-07T00:00:00.000Z",
      ),
    ).toMatchObject({
      usedTokens: 119000,
      maxTokens: 258000,
      remainingTokens: 139000,
      usedPercent: 46,
    });
  });

  it("parses the live thread token-usage payload shape from Codex notifications", () => {
    expect(
      normalizeCodexContextWindow(
        {
          threadId: "019cca93-40c0-7801-9c4e-818a6f7b8a49",
          turnId: "019cca93-40f6-7de3-985e-83e2c6fdf35d",
          tokenUsage: {
            total: {
              totalTokens: 11347,
              inputTokens: 11321,
              cachedInputTokens: 4864,
              outputTokens: 26,
              reasoningOutputTokens: 0,
            },
            last: {
              totalTokens: 11347,
              inputTokens: 11321,
              cachedInputTokens: 4864,
              outputTokens: 26,
              reasoningOutputTokens: 0,
            },
            modelContextWindow: 258400,
          },
        },
        "2026-03-07T00:00:00.000Z",
      ),
    ).toEqual({
      provider: "codex",
      usedTokens: 11347,
      maxTokens: 258400,
      remainingTokens: 247053,
      usedPercent: 4,
      inputTokens: 11321,
      cachedInputTokens: 4864,
      outputTokens: 26,
      reasoningOutputTokens: 0,
      updatedAt: "2026-03-07T00:00:00.000Z",
    });
  });

  it("ignores malformed or incomplete payloads", () => {
    expect(normalizeCodexContextWindow({}, "2026-03-07T00:00:00.000Z")).toBeNull();
    expect(
      normalizeCodexContextWindow(
        { info: { total_token_usage: { total_tokens: 100 } } },
        "2026-03-07T00:00:00.000Z",
      ),
    ).toBeNull();
    expect(
      normalizeCodexContextWindow(
        { info: { total_token_usage: { total_tokens: -1 }, model_context_window: 258400 } },
        "2026-03-07T00:00:00.000Z",
      ),
    ).toBeNull();
  });

  it("clamps derived values when usage exceeds the model limit", () => {
    expect(
      normalizeCodexContextWindow(
        {
          info: {
            total_token_usage: {
              total_tokens: 300000,
            },
            model_context_window: 258400,
          },
        },
        "2026-03-07T00:00:00.000Z",
      ),
    ).toMatchObject({
      usedTokens: 300000,
      maxTokens: 258400,
      remainingTokens: 0,
      usedPercent: 100,
    });
  });
});
