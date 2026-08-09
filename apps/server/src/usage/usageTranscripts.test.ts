import { describe, expect, it } from "@effect/vitest";

import {
  initialCodexScanState,
  parseClaudeLine,
  parseCodexLine,
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
  interface TokenUsageFixture {
    readonly inputTokens: number;
    readonly cached: number;
    readonly output: number;
    readonly reasoning: number;
  }

  const tokenCount = (
    inputTokens: number,
    cached: number,
    output: number,
    reasoning: number,
    total: TokenUsageFixture = { inputTokens, cached, output, reasoning },
  ) =>
    JSON.stringify({
      type: "event_msg",
      timestamp: "2026-08-01T05:17:49.919Z",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: total.inputTokens,
            cached_input_tokens: total.cached,
            cache_write_input_tokens: 0,
            output_tokens: total.output,
            reasoning_output_tokens: total.reasoning,
            total_tokens: total.inputTokens + total.output,
          },
          last_token_usage: {
            input_tokens: inputTokens,
            cached_input_tokens: cached,
            cache_write_input_tokens: 0,
            output_tokens: output,
            reasoning_output_tokens: reasoning,
            total_tokens: inputTokens + output,
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

  it("skips usage when the cumulative counter did not advance", () => {
    const state = initialCodexScanState();
    parseCodexLine(turnContext, state);
    const total = { inputTokens: 100, cached: 0, output: 10, reasoning: 0 };
    const first = parseCodexLine(tokenCount(100, 0, 10, 0, total), state);
    const rebroadcast = parseCodexLine(tokenCount(50, 0, 5, 0, total), state);

    expect(first).not.toBeNull();
    expect(rebroadcast).toBeNull();
    expect(state.malformedRecords).toBe(0);
  });

  it("keeps identical per-request usage when the cumulative counter advances", () => {
    const state = initialCodexScanState();
    parseCodexLine(turnContext, state);
    const first = parseCodexLine(tokenCount(100, 0, 10, 0), state);
    const second = parseCodexLine(
      tokenCount(100, 0, 10, 0, {
        inputTokens: 200,
        cached: 0,
        output: 20,
        reasoning: 0,
      }),
      state,
    );

    expect(first).not.toBeNull();
    expect(state.malformedRecords).toBe(0);
    expect(second).not.toBeNull();
  });

  it("rejects and reports usage that disagrees with the cumulative advance", () => {
    const state = initialCodexScanState();
    parseCodexLine(turnContext, state);
    parseCodexLine(tokenCount(100, 0, 10, 0), state);
    const inconsistent = parseCodexLine(
      tokenCount(70, 0, 7, 0, {
        inputTokens: 150,
        cached: 0,
        output: 15,
        reasoning: 0,
      }),
      state,
    );

    expect(inconsistent).toBeNull();
    expect(state.malformedRecords).toBe(1);
  });

  it("rejects a first usage event larger than its cumulative counter", () => {
    const state = initialCodexScanState();
    parseCodexLine(turnContext, state);
    const inconsistent = parseCodexLine(
      tokenCount(100, 0, 10, 0, {
        inputTokens: 90,
        cached: 0,
        output: 10,
        reasoning: 0,
      }),
      state,
    );

    expect(inconsistent).toBeNull();
    expect(state.malformedRecords).toBe(1);
  });

  it("accepts a first event when its cumulative counter includes prior usage", () => {
    const state = initialCodexScanState();
    parseCodexLine(turnContext, state);
    const record = parseCodexLine(
      tokenCount(50, 0, 5, 0, {
        inputTokens: 150,
        cached: 0,
        output: 15,
        reasoning: 0,
      }),
      state,
    );

    expect(record?.totals.uncachedInputTokens).toBe(50);
    expect(record?.totals.outputTokens).toBe(5);
    expect(state.malformedRecords).toBe(0);
  });

  it("rejects a first checkpoint whose implied prior usage has impossible subsets", () => {
    const state = initialCodexScanState();
    parseCodexLine(turnContext, state);
    const impossiblePrior = parseCodexLine(
      tokenCount(0, 0, 100, 0, {
        inputTokens: 0,
        cached: 0,
        output: 100,
        reasoning: 100,
      }),
      state,
    );

    expect(impossiblePrior).toBeNull();
    expect(state.malformedRecords).toBe(1);

    const afterResync = parseCodexLine(
      tokenCount(10, 0, 5, 0, {
        inputTokens: 10,
        cached: 0,
        output: 105,
        reasoning: 100,
      }),
      state,
    );
    expect(afterResync).not.toBeNull();
    expect(state.malformedRecords).toBe(1);
  });

  it("accepts a first checkpoint with legitimate total-only context-window residue", () => {
    const state = initialCodexScanState();
    parseCodexLine(turnContext, state);
    const afterUnseenReset = JSON.parse(tokenCount(50, 0, 5, 0)) as {
      payload: { info: { total_token_usage: { total_tokens: number } } };
    };
    afterUnseenReset.payload.info.total_token_usage.total_tokens = 258_455;

    expect(parseCodexLine(JSON.stringify(afterUnseenReset), state)).not.toBeNull();
    expect(state.malformedRecords).toBe(0);
  });

  it("resynchronizes after one inconsistent cumulative checkpoint", () => {
    const state = initialCodexScanState();
    parseCodexLine(turnContext, state);
    parseCodexLine(tokenCount(100, 0, 10, 0), state);
    expect(
      parseCodexLine(
        tokenCount(70, 0, 7, 0, {
          inputTokens: 150,
          cached: 0,
          output: 15,
          reasoning: 0,
        }),
        state,
      ),
    ).toBeNull();

    const next = parseCodexLine(
      tokenCount(50, 0, 5, 0, {
        inputTokens: 200,
        cached: 0,
        output: 20,
        reasoning: 0,
      }),
      state,
    );

    expect(next).not.toBeNull();
    expect(state.malformedRecords).toBe(1);
  });

  it("accepts a corrected re-emission after a structurally invalid last usage", () => {
    const state = initialCodexScanState();
    parseCodexLine(turnContext, state);
    parseCodexLine(tokenCount(100, 0, 10, 0), state);
    const cumulative = {
      inputTokens: 150,
      cached: 0,
      output: 15,
      reasoning: 0,
    };

    expect(parseCodexLine(tokenCount(50, 60, 5, 0, cumulative), state)).toBeNull();
    expect(state.malformedRecords).toBe(1);

    const corrected = tokenCount(50, 0, 5, 0, cumulative);
    expect(parseCodexLine(corrected, state)).not.toBeNull();
    expect(parseCodexLine(corrected, state)).toBeNull();
    expect(state.malformedRecords).toBe(1);
  });

  it("keeps a backward checkpoint as the resync baseline", () => {
    const state = initialCodexScanState();
    parseCodexLine(turnContext, state);
    parseCodexLine(tokenCount(100, 0, 10, 0), state);

    expect(
      parseCodexLine(
        tokenCount(10, 0, 1, 0, {
          inputTokens: 80,
          cached: 0,
          output: 8,
          reasoning: 0,
        }),
        state,
      ),
    ).toBeNull();
    expect(state.malformedRecords).toBe(1);

    expect(
      parseCodexLine(
        tokenCount(20, 0, 2, 0, {
          inputTokens: 100,
          cached: 0,
          output: 10,
          reasoning: 0,
        }),
        state,
      ),
    ).not.toBeNull();
    expect(state.malformedRecords).toBe(1);
  });

  it("resynchronizes a context-window checkpoint without reporting it as malformed", () => {
    const state = initialCodexScanState();
    parseCodexLine(turnContext, state);
    parseCodexLine(tokenCount(100, 0, 10, 0), state);
    const contextFull = JSON.parse(tokenCount(0, 0, 0, 0)) as {
      payload: {
        info: {
          last_token_usage: { total_tokens: number };
          total_token_usage: { total_tokens: number };
        };
      };
    };
    contextFull.payload.info.last_token_usage.total_tokens = 258_290;
    contextFull.payload.info.total_token_usage.total_tokens = 258_400;

    expect(parseCodexLine(JSON.stringify(contextFull), state)).toBeNull();
    expect(state.malformedRecords).toBe(0);

    const afterReset = JSON.parse(tokenCount(50, 0, 5, 0)) as typeof contextFull;
    afterReset.payload.info.total_token_usage.total_tokens = 258_455;
    expect(parseCodexLine(JSON.stringify(afterReset), state)).not.toBeNull();
    expect(state.malformedRecords).toBe(0);
  });

  it("rejects a total-only reset whose delta does not match the previous total", () => {
    const state = initialCodexScanState();
    parseCodexLine(turnContext, state);
    parseCodexLine(tokenCount(100, 0, 10, 0), state);
    const invalidReset = JSON.parse(tokenCount(0, 0, 0, 0)) as {
      payload: {
        info: {
          last_token_usage: { total_tokens: number };
          total_token_usage: { total_tokens: number };
        };
      };
    };
    invalidReset.payload.info.last_token_usage.total_tokens = 1;
    invalidReset.payload.info.total_token_usage.total_tokens = 500;

    expect(parseCodexLine(JSON.stringify(invalidReset), state)).toBeNull();
    expect(state.malformedRecords).toBe(1);

    const afterReset = JSON.parse(tokenCount(50, 0, 5, 0)) as typeof invalidReset;
    afterReset.payload.info.total_token_usage.total_tokens = 555;
    expect(parseCodexLine(JSON.stringify(afterReset), state)).not.toBeNull();
    expect(state.malformedRecords).toBe(1);
  });

  it("reports a token_count without cumulative usage as malformed", () => {
    const state = initialCodexScanState();
    parseCodexLine(turnContext, state);
    const withoutTotal = JSON.parse(tokenCount(100, 0, 10, 0)) as {
      payload: { info: { total_token_usage?: unknown } };
    };
    delete withoutTotal.payload.info.total_token_usage;

    expect(parseCodexLine(JSON.stringify(withoutTotal), state)).toBeNull();
    expect(state.malformedRecords).toBe(1);
  });

  it("rejects reasoning usage that exceeds output usage", () => {
    const state = initialCodexScanState();
    parseCodexLine(turnContext, state);

    expect(parseCodexLine(tokenCount(100, 0, 5, 10), state)).toBeNull();
    expect(state.malformedRecords).toBe(1);
  });

  it("rejects cached input subsets that exceed total input", () => {
    const state = initialCodexScanState();
    parseCodexLine(turnContext, state);
    const invalid = JSON.parse(tokenCount(100, 90, 10, 0)) as {
      payload: {
        info: {
          last_token_usage: { cache_write_input_tokens: number };
          total_token_usage: { cache_write_input_tokens: number };
        };
      };
    };
    invalid.payload.info.last_token_usage.cache_write_input_tokens = 20;
    invalid.payload.info.total_token_usage.cache_write_input_tokens = 20;

    expect(parseCodexLine(JSON.stringify(invalid), state)).toBeNull();
    expect(state.malformedRecords).toBe(1);
  });

  it("rejects an impossible cached subset in the cumulative checkpoint", () => {
    const state = initialCodexScanState();
    parseCodexLine(turnContext, state);

    expect(
      parseCodexLine(
        tokenCount(50, 0, 5, 0, {
          inputTokens: 100,
          cached: 110,
          output: 10,
          reasoning: 0,
        }),
        state,
      ),
    ).toBeNull();
    expect(state.malformedRecords).toBe(1);
  });

  it("reports non-numeric usage counters as malformed", () => {
    const state = initialCodexScanState();
    parseCodexLine(turnContext, state);
    const invalid = JSON.parse(tokenCount(100, 0, 10, 0)) as {
      payload: { info: { last_token_usage: { output_tokens: unknown } } };
    };
    invalid.payload.info.last_token_usage.output_tokens = "10";

    expect(parseCodexLine(JSON.stringify(invalid), state)).toBeNull();
    expect(state.malformedRecords).toBe(1);
  });

  it("rejects a per-request total that excludes or double-counts tokens", () => {
    const state = initialCodexScanState();
    parseCodexLine(turnContext, state);
    const invalid = JSON.parse(tokenCount(100, 0, 10, 0)) as {
      payload: {
        info: {
          last_token_usage: { total_tokens: number };
          total_token_usage: { total_tokens: number };
        };
      };
    };
    invalid.payload.info.last_token_usage.total_tokens = 999;
    invalid.payload.info.total_token_usage.total_tokens = 999;

    expect(parseCodexLine(JSON.stringify(invalid), state)).toBeNull();
    expect(state.malformedRecords).toBe(1);
  });

  it("accepts older counters that predate cache-write reporting", () => {
    const state = initialCodexScanState();
    parseCodexLine(turnContext, state);
    const legacy = JSON.parse(tokenCount(100, 0, 10, 0)) as {
      payload: {
        info: {
          last_token_usage: { cache_write_input_tokens?: number };
          total_token_usage: { cache_write_input_tokens?: number };
        };
      };
    };
    delete legacy.payload.info.last_token_usage.cache_write_input_tokens;
    delete legacy.payload.info.total_token_usage.cache_write_input_tokens;

    expect(parseCodexLine(JSON.stringify(legacy), state)).not.toBeNull();
    expect(state.malformedRecords).toBe(0);
  });

  it("drops usage that arrives before any model is known", () => {
    const state = initialCodexScanState();
    expect(parseCodexLine(tokenCount(100, 0, 10, 0), state)).toBeNull();
  });

  it("does not let a pre-model event consume the cumulative checkpoint", () => {
    // A token_count before its turn_context is dropped; its re-emitted copy
    // after the model is known must still be counted.
    const state = initialCodexScanState();
    expect(parseCodexLine(tokenCount(100, 0, 10, 0), state)).toBeNull();
    parseCodexLine(turnContext, state);
    expect(parseCodexLine(tokenCount(100, 0, 10, 0), state)).not.toBeNull();
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
