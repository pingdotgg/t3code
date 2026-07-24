import { describe, expect, it } from "@effect/vitest";

import {
  canonicalModelId,
  claudeCumulativeByModel,
  codexCumulativeFromSnapshot,
  isZeroUsage,
  usageDelta,
  ZERO_USAGE_COUNTERS,
} from "./usageAccounting.ts";

describe("usageAccounting", () => {
  describe("usageDelta", () => {
    it("computes interval counters from cumulative counters", () => {
      const result = usageDelta(
        {
          inputTokens: 100,
          cachedInputTokens: 20,
          cacheCreationTokens: 10,
          outputTokens: 50,
          reasoningOutputTokens: 5,
          costMicroUsd: 1_000_000,
        },
        {
          inputTokens: 175,
          cachedInputTokens: 35,
          cacheCreationTokens: 18,
          outputTokens: 90,
          reasoningOutputTokens: 12,
          costMicroUsd: 1_750_000,
        },
      );

      expect(result).toEqual({
        delta: {
          inputTokens: 75,
          cachedInputTokens: 15,
          cacheCreationTokens: 8,
          outputTokens: 40,
          reasoningOutputTokens: 7,
          costMicroUsd: 750_000,
        },
        nextBaseline: {
          inputTokens: 175,
          cachedInputTokens: 35,
          cacheCreationTokens: 18,
          outputTokens: 90,
          reasoningOutputTokens: 12,
          costMicroUsd: 1_750_000,
        },
        reset: false,
      });
    });

    it("returns a zero delta when baseline equals cumulative", () => {
      const cumulative = {
        inputTokens: 100,
        cachedInputTokens: 20,
        cacheCreationTokens: 10,
        outputTokens: 50,
        reasoningOutputTokens: 5,
        costMicroUsd: 1_000_000,
      };

      expect(usageDelta(cumulative, cumulative)).toEqual({
        delta: ZERO_USAGE_COUNTERS,
        nextBaseline: cumulative,
        reset: false,
      });
    });

    it("treats a counter regression as a provider session reset", () => {
      const cumulative = {
        inputTokens: 125,
        cachedInputTokens: 25,
        cacheCreationTokens: 12,
        outputTokens: 10,
        reasoningOutputTokens: 6,
        costMicroUsd: 1_250_000,
      };

      expect(
        usageDelta(
          {
            inputTokens: 100,
            cachedInputTokens: 20,
            cacheCreationTokens: 10,
            outputTokens: 50,
            reasoningOutputTokens: 5,
            costMicroUsd: 1_000_000,
          },
          cumulative,
        ),
      ).toEqual({
        delta: cumulative,
        nextBaseline: cumulative,
        reset: true,
      });
    });
  });

  describe("claudeCumulativeByModel", () => {
    it("decodes per-model cumulative usage and converts USD to micro-USD", () => {
      const result = claudeCumulativeByModel({
        "claude-fable-5[1m]": {
          inputTokens: 100,
          outputTokens: 50,
          cacheReadInputTokens: 1_000,
          cacheCreationInputTokens: 200,
          costUSD: 1.25,
        },
        "claude-opus-4-8": {
          inputTokens: 80,
          outputTokens: 30,
          cacheReadInputTokens: 400,
          cacheCreationInputTokens: 25,
        },
      });

      expect(result).toEqual(
        new Map([
          [
            "claude-fable-5[1m]",
            {
              inputTokens: 100,
              cachedInputTokens: 1_000,
              cacheCreationTokens: 200,
              outputTokens: 50,
              reasoningOutputTokens: 0,
              costMicroUsd: 1_250_000,
            },
          ],
          [
            "claude-opus-4-8",
            {
              inputTokens: 80,
              cachedInputTokens: 400,
              cacheCreationTokens: 25,
              outputTokens: 30,
              reasoningOutputTokens: 0,
              costMicroUsd: 0,
            },
          ],
        ]),
      );
    });

    it("returns undefined for malformed input", () => {
      expect(claudeCumulativeByModel({ model: "not usage" })).toBeUndefined();
      expect(claudeCumulativeByModel(null)).toBeUndefined();
    });
  });

  describe("codexCumulativeFromSnapshot", () => {
    it("stores only the uncached share in inputTokens", () => {
      expect(
        codexCumulativeFromSnapshot({
          totalInputTokens: 1_000,
          totalCachedInputTokens: 250,
          totalOutputTokens: 400,
          totalReasoningOutputTokens: 125,
        }),
      ).toEqual({
        inputTokens: 750,
        cachedInputTokens: 250,
        cacheCreationTokens: 0,
        outputTokens: 400,
        reasoningOutputTokens: 125,
        costMicroUsd: 0,
      });
    });

    it("returns undefined when no cumulative total fields are present", () => {
      expect(codexCumulativeFromSnapshot({})).toBeUndefined();
      expect(
        codexCumulativeFromSnapshot({
          totalCachedInputTokens: 100,
          totalReasoningOutputTokens: 20,
        }),
      ).toBeUndefined();
    });
  });

  it("canonicalizes provider capacity suffixes", () => {
    expect(canonicalModelId("claude-fable-5[1m]")).toBe("claude-fable-5");
    expect(canonicalModelId("claude-opus-4-8")).toBe("claude-opus-4-8");
  });

  it("detects zero usage", () => {
    expect(isZeroUsage(ZERO_USAGE_COUNTERS)).toBe(true);
    expect(isZeroUsage({ ...ZERO_USAGE_COUNTERS, outputTokens: 1 })).toBe(false);
    expect(isZeroUsage({ ...ZERO_USAGE_COUNTERS, costMicroUsd: 1 })).toBe(false);
  });
});
