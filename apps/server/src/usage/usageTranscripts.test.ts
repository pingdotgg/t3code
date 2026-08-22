import { describe, expect, it } from "@effect/vitest";

import {
  GROK_COST_USD_TICKS_PER_DOLLAR,
  initialCodexScanState,
  mightCarryUsage,
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

  // A forked/subagent rollout opens with the parent's history copied in and
  // every line re-stamped to the fork instant, then the ancestors' session
  // metas. Counting those again multiplied usage ~1.85x on real data (#5758).
  describe("forked rollouts", () => {
    const meta = (overrides: {
      id: string;
      timestamp: string;
      forkedFromId?: string;
      spawnParentId?: string;
    }) =>
      JSON.stringify({
        type: "session_meta",
        timestamp: overrides.timestamp,
        payload: {
          type: "session_meta",
          id: overrides.id,
          ...(overrides.forkedFromId === undefined
            ? {}
            : { forked_from_id: overrides.forkedFromId }),
          ...(overrides.spawnParentId === undefined
            ? {}
            : {
                source: {
                  subagent: { thread_spawn: { parent_thread_id: overrides.spawnParentId } },
                },
              }),
        },
      });
    const stamped = (timestamp: string, line: string) => {
      const parsed = JSON.parse(line) as { timestamp: string };
      parsed.timestamp = timestamp;
      return JSON.stringify(parsed);
    };

    it("keeps the child session id over copied ancestor metas", () => {
      const state = initialCodexScanState();
      parseCodexLine(meta({ id: "child", timestamp: "2026-08-01T05:00:00.000Z" }), state);
      parseCodexLine(meta({ id: "parent", timestamp: "2026-08-01T05:00:00.000Z" }), state);
      parseCodexLine(turnContext, state);
      const record = parseCodexLine(tokenCount(100, 0, 10, 0), state);

      expect(record?.sessionId).toBe("child");
    });

    it("drops the re-stamped copied burst and keeps the first real event", () => {
      const state = initialCodexScanState();
      const forkInstant = "2026-08-01T05:00:00.000Z";
      parseCodexLine(meta({ id: "child", timestamp: forkInstant, forkedFromId: "parent" }), state);
      parseCodexLine(meta({ id: "parent", timestamp: forkInstant }), state);
      parseCodexLine(stamped(forkInstant, turnContext), state);

      // Copied history: written in one burst at the fork instant.
      expect(
        parseCodexLine(stamped("2026-08-01T05:00:00.001Z", tokenCount(100, 0, 10, 0)), state),
      ).toBeNull();
      expect(
        parseCodexLine(stamped("2026-08-01T05:00:00.002Z", tokenCount(200, 0, 20, 0)), state),
      ).toBeNull();

      // The child's first genuine turn lands seconds later and must count.
      const real = parseCodexLine(
        stamped("2026-08-01T05:00:06.000Z", tokenCount(300, 0, 30, 0)),
        state,
      );
      expect(real).not.toBeNull();
      expect(real?.totals.outputTokens).toBe(30);

      // Suppression never restarts, even for closely spaced later events.
      const next = parseCodexLine(
        stamped("2026-08-01T05:00:06.100Z", tokenCount(400, 0, 40, 0)),
        state,
      );
      expect(next).not.toBeNull();
    });

    it("recognizes subagent spawns without forked_from_id", () => {
      const state = initialCodexScanState();
      const spawnInstant = "2026-08-01T05:00:00.000Z";
      parseCodexLine(
        meta({ id: "child", timestamp: spawnInstant, spawnParentId: "parent" }),
        state,
      );
      parseCodexLine(stamped(spawnInstant, turnContext), state);
      expect(
        parseCodexLine(stamped("2026-08-01T05:00:00.001Z", tokenCount(100, 0, 10, 0)), state),
      ).toBeNull();
    });

    it("does not suppress anything in a rollout that is not a fork", () => {
      const state = initialCodexScanState();
      parseCodexLine(meta({ id: "root", timestamp: "2026-08-01T05:00:00.000Z" }), state);
      parseCodexLine(stamped("2026-08-01T05:00:00.100Z", turnContext), state);
      const record = parseCodexLine(
        stamped("2026-08-01T05:00:00.200Z", tokenCount(100, 0, 10, 0)),
        state,
      );
      expect(record).not.toBeNull();
    });
  });
});

describe("parseGrokLine", () => {
  function grokTurnCompleted(overrides?: {
    promptId?: string;
    incomplete?: boolean;
    costUsdTicks?: number | null;
  }): string {
    return JSON.stringify({
      timestamp: "2026-08-15T03:57:36.535Z",
      method: "_x.ai/session/update",
      params: {
        sessionId: "sess-1",
        update: {
          sessionUpdate: "turn_completed",
          prompt_id: overrides?.promptId ?? "prompt-1",
          stop_reason: "end_turn",
          usage: {
            inputTokens: 974_514,
            outputTokens: 7_246,
            totalTokens: 981_760,
            cachedReadTokens: 847_360,
            cacheCreationTokens: 0,
            reasoningTokens: 4_743,
            ...(overrides?.incomplete === true ? { usageIsIncomplete: true } : {}),
            ...(overrides?.costUsdTicks === null
              ? {}
              : { costUsdTicks: overrides?.costUsdTicks ?? 1_626_488_800 }),
            modelUsage: {
              "grok-4.6-build": {
                inputTokens: 974_514,
                outputTokens: 7_246,
              },
            },
          },
        },
      },
    });
  }

  it("reads PromptUsage totals, cache, and complete cost ticks", () => {
    const record = parseGrokLine(grokTurnCompleted());
    expect(record).not.toBeNull();
    expect(record?.provider).toBe("grok");
    expect(record?.model).toBe("grok-4.6-build");
    expect(record?.sessionId).toBe("sess-1");
    expect(record?.dedupeKey).toBe("sess-1:prompt-1");
    expect(record?.totals).toEqual({
      uncachedInputTokens: 974_514 - 847_360,
      cachedInputTokens: 847_360,
      cacheCreationTokens: 0,
      outputTokens: 7_246,
      reasoningTokens: 4_743,
    });
    expect(record?.reportedCostUsd).toBeCloseTo(1_626_488_800 / GROK_COST_USD_TICKS_PER_DOLLAR);
  });

  it("does not treat an incomplete bill as $0", () => {
    const record = parseGrokLine(grokTurnCompleted({ incomplete: true, costUsdTicks: 100 }));
    expect(record?.reportedCostUsd).toBeNull();
  });

  it("dedupes the same prompt across ACP method aliases", () => {
    const first = parseGrokLine(grokTurnCompleted({ promptId: "p2" }));
    const second = parseGrokLine(
      grokTurnCompleted({ promptId: "p2" }).replace("_x.ai/session/update", "session/update"),
    );
    expect(first?.dedupeKey).toBe(second?.dedupeKey);
  });

  it("ignores non-turn updates", () => {
    expect(
      parseGrokLine(
        JSON.stringify({
          timestamp: "2026-08-15T03:57:36.535Z",
          params: { update: { sessionUpdate: "agent_message_chunk" } },
        }),
      ),
    ).toBeNull();
  });

  it("merges nested PromptUsage totals before extracting tokens", () => {
    const record = parseGrokLine(
      JSON.stringify({
        timestamp: "2026-08-15T03:57:36.535Z",
        params: {
          sessionId: "sess-1",
          update: {
            sessionUpdate: "turn_completed",
            prompt_id: "nested",
            usage: {
              totals: {
                inputTokens: 40,
                outputTokens: 10,
                cachedReadTokens: 8,
              },
              costUsdTicks: 1_000_000_000,
            },
          },
        },
      }),
    );
    expect(record?.totals).toEqual({
      uncachedInputTokens: 32,
      cachedInputTokens: 8,
      cacheCreationTokens: 0,
      outputTokens: 10,
      reasoningTokens: 0,
    });
    expect(record?.reportedCostUsd).toBeCloseTo(0.1);
  });

  it("does not treat a session id as a turn dedupe key", () => {
    const record = parseGrokLine(grokTurnCompleted({ promptId: "" }));
    expect(record?.dedupeKey).toBeNull();
    expect(record?.sessionId).toBe("sess-1");
  });
});

describe("mightCarryUsage", () => {
  it("accepts camelCase Grok turnCompleted lines", () => {
    expect(mightCarryUsage('{"sessionUpdate":"turnCompleted"}', "grok")).toBe(true);
    expect(mightCarryUsage('{"sessionUpdate":"turn_completed"}', "grok")).toBe(true);
    expect(mightCarryUsage('{"sessionUpdate":"agent_message_chunk"}', "grok")).toBe(false);
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
