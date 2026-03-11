import { describe, expect, it } from "vitest";
import { EventId, type OrchestrationThreadActivity } from "@t3tools/contracts";

import {
  deriveContextWindowStatusFromUsage,
  deriveLatestContextWindowStatus,
} from "./contextWindow";

describe("deriveContextWindowStatusFromUsage", () => {
  it("derives remaining context from Codex thread token usage payloads", () => {
    expect(
      deriveContextWindowStatusFromUsage({
        model_context_window: 128_000,
        last_token_usage: {
          input_tokens: 32_000,
        },
      }),
    ).toEqual({
      remainingRatio: 0.75,
      remainingTokens: 96_000,
      usedTokens: 32_000,
      totalTokens: 128_000,
    });
  });

  it("supports wrapped usage payloads with explicit remaining tokens", () => {
    expect(
      deriveContextWindowStatusFromUsage({
        usage: {
          modelContextWindow: 200_000,
          remainingContextTokens: 50_000,
        },
      }),
    ).toEqual({
      remainingRatio: 0.25,
      remainingTokens: 50_000,
      usedTokens: 150_000,
      totalTokens: 200_000,
    });
  });

  it("ignores lifetime token totals that exceed the context window", () => {
    expect(
      deriveContextWindowStatusFromUsage({
        model_context_window: 128_000,
        total_token_usage: {
          total_tokens: 900_000,
        },
      }),
    ).toBeNull();
  });
});

describe("deriveLatestContextWindowStatus", () => {
  it("reads the most recent token-usage activity", () => {
    const activities = [
      {
        id: EventId.makeUnsafe("activity-1"),
        tone: "info",
        kind: "thread.token-usage.updated",
        summary: "Context window updated",
        payload: {
          usage: {
            model_context_window: 100_000,
            last_token_usage: {
              input_tokens: 20_000,
            },
          },
        },
        turnId: null,
        createdAt: "2026-03-11T00:00:00.000Z",
      },
      {
        id: EventId.makeUnsafe("activity-2"),
        tone: "info",
        kind: "thread.token-usage.updated",
        summary: "Context window updated",
        payload: {
          usage: {
            model_context_window: 100_000,
            remaining_context_tokens: 10_000,
          },
        },
        turnId: null,
        createdAt: "2026-03-11T00:00:01.000Z",
      },
    ] satisfies OrchestrationThreadActivity[];

    expect(deriveLatestContextWindowStatus(activities)).toEqual({
      remainingRatio: 0.1,
      remainingTokens: 10_000,
      usedTokens: 90_000,
      totalTokens: 100_000,
    });
  });
});
