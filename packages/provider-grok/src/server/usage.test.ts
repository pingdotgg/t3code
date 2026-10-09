import { describe, expect, it } from "@effect/vitest";

import { GROK_COST_USD_TICKS_PER_DOLLAR, parseGrokLine } from "./usage.ts";

describe("parseGrokLine", () => {
  /** Shaped after a real Grok Build `turn_completed` session update. */
  function turnCompleted(overrides?: {
    sessionId?: string;
    promptId?: string;
    timestamp?: number;
    agentTimestampMs?: number;
    usage?: Record<string, unknown>;
    modelUsage?: Record<string, Record<string, unknown>> | null;
  }): string {
    const modelUsage =
      overrides && "modelUsage" in overrides
        ? overrides.modelUsage
        : {
            "grok-4.5-build": {
              inputTokens: 20_272,
              outputTokens: 272,
              totalTokens: 20_544,
              cachedReadTokens: 11_264,
              cacheCreationTokens: 0,
              reasoningTokens: 180,
              costUsdTicks: 230_272_000,
            },
          };

    return JSON.stringify({
      timestamp: overrides?.timestamp ?? 1_786_372_566,
      method: "_x.ai/session/update",
      params: {
        sessionId: overrides?.sessionId ?? "019fec1a-12f7-72f2-9b1f-7778a00aea3c",
        update: {
          sessionUpdate: "turn_completed",
          prompt_id: overrides?.promptId ?? "prompt-1",
          stop_reason: "end_turn",
          usage: {
            inputTokens: 20_272,
            outputTokens: 272,
            totalTokens: 20_544,
            cachedReadTokens: 11_264,
            cacheCreationTokens: 0,
            reasoningTokens: 180,
            costUsdTicks: 230_272_000,
            ...(modelUsage === null ? {} : { modelUsage }),
            ...overrides?.usage,
          },
        },
        _meta: {
          eventId: "event-1",
          agentTimestampMs: overrides?.agentTimestampMs ?? 1_786_372_566_485,
        },
      },
    });
  }

  it("extracts per-model totals and provider-reported cost ticks", () => {
    const records = parseGrokLine(turnCompleted());

    expect(records).toHaveLength(1);
    const [record] = records;
    expect(record?.provider).toBe("grok");
    expect(record?.model).toBe("grok-4.5-build");
    expect(record?.sessionId).toBe("019fec1a-12f7-72f2-9b1f-7778a00aea3c");
    expect(record?.timestampMs).toBe(1_786_372_566_485);
    expect(record?.totals).toEqual({
      uncachedInputTokens: 20_272 - 11_264,
      cachedInputTokens: 11_264,
      cacheCreationTokens: 0,
      outputTokens: 272,
      reasoningTokens: 180,
    });
    expect(record?.reportedCostUsd).toBeCloseTo(230_272_000 / GROK_COST_USD_TICKS_PER_DOLLAR, 12);
    expect(record?.dedupeKey).toBe("019fec1a-12f7-72f2-9b1f-7778a00aea3c:prompt-1:grok-4.5-build");
  });

  it("emits one record per model when modelUsage has several entries", () => {
    const records = parseGrokLine(
      turnCompleted({
        modelUsage: {
          "grok-4.5": {
            inputTokens: 1000,
            outputTokens: 50,
            cachedReadTokens: 400,
            reasoningTokens: 20,
            costUsdTicks: 50_000_000,
          },
          "grok-composer-2.5-fast": {
            inputTokens: 200,
            outputTokens: 30,
            cachedReadTokens: 100,
            reasoningTokens: 0,
            costUsdTicks: 10_000_000,
          },
        },
      }),
    );

    expect(records.map((record) => record.model).toSorted()).toEqual([
      "grok-4.5",
      "grok-composer-2.5-fast",
    ]);
    expect(records.every((record) => record.provider === "grok")).toBe(true);
    expect(records.find((record) => record.model === "grok-4.5")?.reportedCostUsd).toBeCloseTo(
      0.005,
      12,
    );
  });

  it("inherits top-level cost ticks for a single model without its own ticks", () => {
    const records = parseGrokLine(
      turnCompleted({
        modelUsage: {
          "grok-4.5-build": {
            inputTokens: 1000,
            outputTokens: 10,
            cachedReadTokens: 0,
            reasoningTokens: 0,
          },
        },
        usage: { costUsdTicks: GROK_COST_USD_TICKS_PER_DOLLAR },
      }),
    );

    expect(records).toHaveLength(1);
    expect(records[0]?.reportedCostUsd).toBe(1);
  });

  it("falls back to a generic grok model when modelUsage is absent", () => {
    const records = parseGrokLine(turnCompleted({ modelUsage: null }));

    expect(records).toHaveLength(1);
    const [record] = records;
    expect(record?.provider).toBe("grok");
    expect(record?.model).toBe("grok");
    expect(record?.totals).toEqual({
      uncachedInputTokens: 20_272 - 11_264,
      cachedInputTokens: 11_264,
      cacheCreationTokens: 0,
      outputTokens: 272,
      reasoningTokens: 180,
    });
    expect(record?.reportedCostUsd).toBeCloseTo(230_272_000 / GROK_COST_USD_TICKS_PER_DOLLAR, 12);
    expect(record?.dedupeKey).toBe("019fec1a-12f7-72f2-9b1f-7778a00aea3c:prompt-1:grok");
  });

  it("pro-rates top-level cost ticks across multi-model turns without per-model ticks", () => {
    const records = parseGrokLine(
      turnCompleted({
        modelUsage: {
          "grok-4.5": {
            inputTokens: 300,
            outputTokens: 0,
            cachedReadTokens: 0,
            reasoningTokens: 0,
          },
          "grok-composer-2.5-fast": {
            inputTokens: 100,
            outputTokens: 0,
            cachedReadTokens: 0,
            reasoningTokens: 0,
          },
        },
        usage: { costUsdTicks: GROK_COST_USD_TICKS_PER_DOLLAR },
      }),
    );

    expect(records).toHaveLength(2);
    const byModel = Object.fromEntries(records.map((record) => [record.model, record]));
    expect(byModel["grok-4.5"]?.reportedCostUsd).toBeCloseTo(0.75, 12);
    expect(byModel["grok-composer-2.5-fast"]?.reportedCostUsd).toBeCloseTo(0.25, 12);
    const sum =
      (byModel["grok-4.5"]?.reportedCostUsd ?? 0) +
      (byModel["grok-composer-2.5-fast"]?.reportedCostUsd ?? 0);
    expect(sum).toBeCloseTo(1, 12);
  });

  it("pro-rates aggregate cost when a zero-token sibling carries costUsdTicks: 0", () => {
    const records = parseGrokLine(
      turnCompleted({
        modelUsage: {
          "grok-4.5": {
            inputTokens: 300,
            outputTokens: 0,
            cachedReadTokens: 0,
            reasoningTokens: 0,
          },
          "grok-composer-2.5-fast": {
            inputTokens: 100,
            outputTokens: 0,
            cachedReadTokens: 0,
            reasoningTokens: 0,
          },
          "empty-sibling": {
            inputTokens: 0,
            outputTokens: 0,
            cachedReadTokens: 0,
            reasoningTokens: 0,
            costUsdTicks: 0,
          },
        },
        usage: { costUsdTicks: GROK_COST_USD_TICKS_PER_DOLLAR },
      }),
    );

    expect(records).toHaveLength(2);
    expect(records.every((record) => record.model !== "empty-sibling")).toBe(true);
    const byModel = Object.fromEntries(records.map((record) => [record.model, record]));
    expect(byModel["grok-4.5"]?.reportedCostUsd).toBeCloseTo(0.75, 12);
    expect(byModel["grok-composer-2.5-fast"]?.reportedCostUsd).toBeCloseTo(0.25, 12);
    const sum =
      (byModel["grok-4.5"]?.reportedCostUsd ?? 0) +
      (byModel["grok-composer-2.5-fast"]?.reportedCostUsd ?? 0);
    expect(sum).toBeCloseTo(1, 12);
  });

  it("allocates leftover aggregate ticks to models that omit per-model ticks", () => {
    const records = parseGrokLine(
      turnCompleted({
        modelUsage: {
          "grok-4.5": {
            inputTokens: 300,
            outputTokens: 0,
            cachedReadTokens: 0,
            reasoningTokens: 0,
            costUsdTicks: 0.4 * GROK_COST_USD_TICKS_PER_DOLLAR,
          },
          "grok-composer-2.5-fast": {
            inputTokens: 100,
            outputTokens: 0,
            cachedReadTokens: 0,
            reasoningTokens: 0,
          },
        },
        usage: { costUsdTicks: GROK_COST_USD_TICKS_PER_DOLLAR },
      }),
    );

    expect(records).toHaveLength(2);
    const byModel = Object.fromEntries(records.map((record) => [record.model, record]));
    expect(byModel["grok-4.5"]?.reportedCostUsd).toBeCloseTo(0.4, 12);
    expect(byModel["grok-composer-2.5-fast"]?.reportedCostUsd).toBeCloseTo(0.6, 12);
    const sum =
      (byModel["grok-4.5"]?.reportedCostUsd ?? 0) +
      (byModel["grok-composer-2.5-fast"]?.reportedCostUsd ?? 0);
    expect(sum).toBeCloseTo(1, 12);
  });

  it("does not invent a colliding dedupe key when prompt_id is missing", () => {
    const line = JSON.stringify({
      timestamp: 1_786_372_566,
      method: "_x.ai/session/update",
      params: {
        sessionId: "s1",
        update: {
          sessionUpdate: "turn_completed",
          usage: {
            inputTokens: 10,
            outputTokens: 2,
            modelUsage: {
              "grok-4.5": { inputTokens: 10, outputTokens: 2 },
            },
          },
        },
      },
    });

    expect(parseGrokLine(line)[0]?.dedupeKey).toBeNull();
  });

  it("ignores non-turn lines and empty usage", () => {
    expect(parseGrokLine(JSON.stringify({ method: "session/update", params: {} }))).toEqual([]);
    expect(parseGrokLine("not json")).toEqual([]);
    expect(
      parseGrokLine(
        turnCompleted({
          modelUsage: {
            "grok-4.5-build": {
              inputTokens: 0,
              outputTokens: 0,
              cachedReadTokens: 0,
              reasoningTokens: 0,
              costUsdTicks: 0,
            },
          },
        }),
      ),
    ).toEqual([]);
  });

  it("falls back to the outer unix-seconds timestamp when agent meta is missing", () => {
    const line = JSON.stringify({
      timestamp: 1_786_372_566,
      method: "_x.ai/session/update",
      params: {
        sessionId: "s1",
        update: {
          sessionUpdate: "turn_completed",
          prompt_id: "p1",
          usage: {
            inputTokens: 10,
            outputTokens: 2,
            modelUsage: {
              "grok-4.5": { inputTokens: 10, outputTokens: 2 },
            },
          },
        },
      },
    });

    const records = parseGrokLine(line);
    expect(records[0]?.timestampMs).toBe(1_786_372_566_000);
  });
});
