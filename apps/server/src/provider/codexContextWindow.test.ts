import { describe, expect, it } from "vitest";

import {
  normalizeCodexContextWindow,
  normalizeCodexContextWindowFromRuntimeDetail,
} from "./codexContextWindow.ts";

describe("normalizeCodexContextWindow", () => {
  it("parses the observed Codex token-count shape", () => {
    expect(
      normalizeCodexContextWindow(
        {
          info: {
            last_token_usage: {
              input_tokens: 124862,
              cached_input_tokens: 92672,
              output_tokens: 1654,
              reasoning_output_tokens: 277,
              total_tokens: 126516,
            },
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
      usedPercent: 46,
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
          lastTokenUsage: {
            totalTokens: 119000,
            inputTokens: 110000,
            cachedInputTokens: 60000,
            outputTokens: 9000,
          },
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
      usedPercent: 43,
    });
  });

  it("uses last token usage for the Codex context indicator instead of cumulative totals", () => {
    expect(
      normalizeCodexContextWindow(
        {
          threadId: "019cca93-40c0-7801-9c4e-818a6f7b8a49",
          turnId: "019cca93-40f6-7de3-985e-83e2c6fdf35d",
          tokenUsage: {
            total: {
              totalTokens: 231706,
              inputTokens: 227739,
              cachedInputTokens: 171264,
              outputTokens: 3967,
              reasoningOutputTokens: 898,
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
      remainingTokens: 246400,
      usedPercent: 0,
      inputTokens: 11321,
      cachedInputTokens: 4864,
      outputTokens: 26,
      reasoningOutputTokens: 0,
      updatedAt: "2026-03-07T00:00:00.000Z",
    });
  });

  it("accepts root-level snake_case token_usage totals objects", () => {
    expect(
      normalizeCodexContextWindow(
        {
          token_usage: {
            total_tokens: 100,
            model_context_window: 258400,
          },
        },
        "2026-03-07T00:00:00.000Z",
      ),
    ).toEqual({
      provider: "codex",
      usedTokens: 100,
      maxTokens: 258400,
      remainingTokens: 246400,
      usedPercent: 0,
      updatedAt: "2026-03-07T00:00:00.000Z",
    });
  });

  it("accepts root-level camelCase tokenUsage totals objects", () => {
    expect(
      normalizeCodexContextWindow(
        {
          tokenUsage: {
            totalTokens: 100,
            modelContextWindow: 258400,
          },
        },
        "2026-03-07T00:00:00.000Z",
      ),
    ).toEqual({
      provider: "codex",
      usedTokens: 100,
      maxTokens: 258400,
      remainingTokens: 246400,
      usedPercent: 0,
      updatedAt: "2026-03-07T00:00:00.000Z",
    });
  });

  it("carries bucket fields from root-level totals objects", () => {
    expect(
      normalizeCodexContextWindow(
        {
          token_usage: {
            total_tokens: 100,
            input_tokens: 80,
            cached_input_tokens: 20,
            output_tokens: 15,
            reasoning_output_tokens: 5,
            model_context_window: 258400,
          },
        },
        "2026-03-07T00:00:00.000Z",
      ),
    ).toEqual({
      provider: "codex",
      usedTokens: 100,
      maxTokens: 258400,
      remainingTokens: 246400,
      usedPercent: 0,
      inputTokens: 80,
      cachedInputTokens: 20,
      outputTokens: 15,
      reasoningOutputTokens: 5,
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

  it("parses compaction detail payloads that carry fresh usage snapshots", () => {
    expect(
      normalizeCodexContextWindowFromRuntimeDetail(
        {
          thread: {
            usage: {
              tokenUsage: {
                total: {
                  totalTokens: 43083,
                  inputTokens: 42950,
                  cachedInputTokens: 42240,
                  outputTokens: 133,
                  reasoningOutputTokens: 53,
                },
                modelContextWindow: 258400,
              },
            },
          },
        },
        "2026-03-07T00:00:00.000Z",
      ),
    ).toEqual({
      provider: "codex",
      usedTokens: 43083,
      maxTokens: 258400,
      remainingTokens: 215317,
      usedPercent: 13,
      inputTokens: 42950,
      cachedInputTokens: 42240,
      outputTokens: 133,
      reasoningOutputTokens: 53,
      updatedAt: "2026-03-07T00:00:00.000Z",
    });
  });

  it("returns null for compaction detail payloads without usable usage data", () => {
    expect(
      normalizeCodexContextWindowFromRuntimeDetail(
        {
          thread: {
            state: "compacted",
          },
        },
        "2026-03-07T00:00:00.000Z",
      ),
    ).toBeNull();
  });
});
