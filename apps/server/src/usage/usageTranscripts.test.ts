import { describe, expect, it } from "@effect/vitest";

import {
  initialCodexScanState,
  parseClaudeLine,
  parseCodexLine,
  parseGrokLine,
  totalTokens,
} from "./usageTranscripts.ts";

/** Shaped after a real Claude Code assistant record. */
function claudeLine(overrides: {
  messageId: string;
  contentType: string;
  model?: string;
  outputTokens?: number;
}): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: "2026-08-07T04:05:13.944Z",
    sessionId: "5a128faa-8253-489e-b935-6c08e8e670c0",
    cwd: "/home/theo/project",
    message: {
      id: overrides.messageId,
      role: "assistant",
      model: overrides.model ?? "claude-fable-5",
      content: [{ type: overrides.contentType }],
      usage: {
        input_tokens: 2,
        cache_creation_input_tokens: 66818,
        cache_read_input_tokens: 1000,
        output_tokens: overrides.outputTokens ?? 286,
      },
    },
  });
}

describe("parseClaudeLine", () => {
  it("extracts token totals and a dedupe key", () => {
    const record = parseClaudeLine(claudeLine({ messageId: "msg_1", contentType: "text" }));

    expect(record).not.toBeNull();
    expect(record?.provider).toBe("claude");
    expect(record?.model).toBe("claude-fable-5");
    expect(record?.totals).toEqual({
      uncachedInputTokens: 2,
      cachedInputTokens: 1000,
      cacheCreationTokens: 66818,
      outputTokens: 286,
      reasoningTokens: 0,
    });
    expect(record?.dedupeKey).toBe("msg_1:");
  });

  it("gives every content block of one message the same dedupe key", () => {
    // T3 Code writes one record per content block, each repeating the parent
    // message's full usage. Summing them would overcount ~2.4x on real data.
    const text = parseClaudeLine(claudeLine({ messageId: "msg_2", contentType: "text" }));
    const toolUse = parseClaudeLine(claudeLine({ messageId: "msg_2", contentType: "tool_use" }));

    expect(text?.dedupeKey).toBe(toolUse?.dedupeKey);
    expect(text?.totals).toEqual(toolUse?.totals);
  });

  it("ignores records that are not assistant messages", () => {
    expect(parseClaudeLine(JSON.stringify({ type: "user", message: {} }))).toBeNull();
    expect(parseClaudeLine("not json")).toBeNull();
  });
});

describe("parseCodexLine", () => {
  const sessionMeta = JSON.stringify({
    type: "session_meta",
    timestamp: "2026-08-01T05:17:41.289Z",
    payload: { type: "session_meta", id: "019fbbc1-b12c-7360-a685-28c181f0025f" },
  });
  const turnContext = JSON.stringify({
    type: "turn_context",
    timestamp: "2026-08-01T05:17:42.694Z",
    payload: { type: "turn_context", model: "gpt-5.6-sol" },
  });
  const tokenCount = (inputTokens: number, cached: number, output: number, reasoning: number) =>
    JSON.stringify({
      type: "event_msg",
      timestamp: "2026-08-01T05:17:49.919Z",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: inputTokens,
            cached_input_tokens: cached,
            cache_write_input_tokens: 0,
            output_tokens: output,
            reasoning_output_tokens: reasoning,
          },
        },
      },
    });

  it("attributes usage to the model from the preceding turn context", () => {
    const state = initialCodexScanState();
    parseCodexLine(sessionMeta, state);
    parseCodexLine(turnContext, state);
    const record = parseCodexLine(tokenCount(19239, 11008, 299, 116), state);

    expect(record?.provider).toBe("codex");
    expect(record?.model).toBe("gpt-5.6-sol");
    expect(record?.sessionId).toBe("019fbbc1-b12c-7360-a685-28c181f0025f");
    // Codex reports input_tokens inclusive of the cached portion.
    expect(record?.totals.uncachedInputTokens).toBe(19239 - 11008);
    expect(record?.totals.cachedInputTokens).toBe(11008);
    expect(record?.totals.reasoningTokens).toBe(116);
  });

  it("skips a repeated token_count so deltas are not double counted", () => {
    const state = initialCodexScanState();
    parseCodexLine(turnContext, state);
    const first = parseCodexLine(tokenCount(100, 0, 10, 0), state);
    const repeat = parseCodexLine(tokenCount(100, 0, 10, 0), state);

    expect(first).not.toBeNull();
    expect(repeat).toBeNull();
  });

  it("drops usage that arrives before any model is known", () => {
    const state = initialCodexScanState();
    expect(parseCodexLine(tokenCount(100, 0, 10, 0), state)).toBeNull();
  });

  it("does not let a pre-model event poison the duplicate signature", () => {
    // A token_count before its turn_context is dropped; the identical event
    // re-emitted once the model is known must still be counted.
    const state = initialCodexScanState();
    expect(parseCodexLine(tokenCount(100, 0, 10, 0), state)).toBeNull();
    parseCodexLine(turnContext, state);
    expect(parseCodexLine(tokenCount(100, 0, 10, 0), state)).not.toBeNull();
  });
});

describe("parseGrokLine", () => {
  const turnCompleted = (overrides: {
    promptId?: string;
    modelUsage?: Record<
      string,
      {
        inputTokens: number;
        cachedReadTokens?: number;
        cacheCreationTokens?: number;
        outputTokens: number;
        reasoningTokens?: number;
        costUsdTicks?: number;
      }
    >;
    usage?: {
      inputTokens: number;
      cachedReadTokens?: number;
      cacheCreationTokens?: number;
      outputTokens: number;
      reasoningTokens?: number;
      costUsdTicks?: number;
      modelUsage?: Record<string, unknown>;
    };
  }) =>
    JSON.stringify({
      timestamp: 1784125066,
      method: "_x.ai/session/update",
      params: {
        sessionId: "019f6623-f83c-70f2-b847-b4c000ab1588",
        update: {
          sessionUpdate: "turn_completed",
          prompt_id: overrides.promptId ?? "prompt-1",
          stop_reason: "end_turn",
          usage: overrides.usage ?? {
            inputTokens: 37650,
            outputTokens: 134,
            totalTokens: 37784,
            cachedReadTokens: 29568,
            reasoningTokens: 60,
            costUsdTicks: 100_000_000,
            modelUsage: overrides.modelUsage ?? {
              "grok-4.5": {
                inputTokens: 37650,
                outputTokens: 134,
                totalTokens: 37784,
                cachedReadTokens: 29568,
                reasoningTokens: 60,
                costUsdTicks: 100_000_000,
              },
            },
          },
        },
      },
    });

  it("extracts per-model totals and converts cost ticks to USD", () => {
    const records = parseGrokLine(turnCompleted({}));
    expect(records).toHaveLength(1);
    expect(records[0]?.provider).toBe("grok");
    expect(records[0]?.model).toBe("grok-4.5");
    expect(records[0]?.sessionId).toBe("019f6623-f83c-70f2-b847-b4c000ab1588");
    expect(records[0]?.totals).toEqual({
      uncachedInputTokens: 37650 - 29568,
      cachedInputTokens: 29568,
      cacheCreationTokens: 0,
      outputTokens: 134,
      reasoningTokens: 60,
    });
    expect(records[0]?.reportedCostUsd).toBeCloseTo(0.1, 9);
    expect(records[0]?.dedupeKey).toBe("grok:prompt-1:grok-4.5");
  });

  it("emits one record per model in modelUsage", () => {
    const records = parseGrokLine(
      turnCompleted({
        modelUsage: {
          "grok-4.5": {
            inputTokens: 100,
            outputTokens: 10,
            costUsdTicks: 50_000_000,
          },
          "grok-build": {
            inputTokens: 200,
            cachedReadTokens: 50,
            outputTokens: 20,
            costUsdTicks: 75_000_000,
          },
        },
      }),
    );
    expect(records.map((record) => record.model).sort()).toEqual(["grok-4.5", "grok-build"]);
    expect(
      records.find((record) => record.model === "grok-build")?.totals.uncachedInputTokens,
    ).toBe(150);
  });

  it("ignores non turn_completed updates", () => {
    expect(
      parseGrokLine(
        JSON.stringify({
          timestamp: 1784125066,
          params: {
            sessionId: "s",
            update: { sessionUpdate: "agent_message_chunk" },
          },
        }),
      ),
    ).toEqual([]);
  });
});

describe("totalTokens", () => {
  it("does not add reasoning on top of output", () => {
    expect(
      totalTokens({
        uncachedInputTokens: 10,
        cachedInputTokens: 20,
        cacheCreationTokens: 30,
        outputTokens: 40,
        reasoningTokens: 25,
      }),
    ).toBe(100);
  });
});
