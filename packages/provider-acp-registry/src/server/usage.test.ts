import { describe, expect, it } from "vite-plus/test";

import { mistralVibeUsageFormat } from "./usage.ts";

const line = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: "mistral_vibe_usage",
    sessionId: "s1",
    turn: 3,
    timestamp: "2026-11-07T10:00:00.000Z",
    model: "zai-glm-5-3",
    inputTokens: 1000,
    cachedInputTokens: 400,
    outputTokens: 50,
    reasoningTokens: 10,
    ...overrides,
  });

describe("mistralVibeUsageFormat", () => {
  it("keeps cached input disjoint from uncached input", () => {
    const [record] = mistralVibeUsageFormat.parseLine(line(), undefined);
    expect(record).toMatchObject({
      provider: "mistral-vibe",
      model: "zai-glm-5-3",
      sessionId: "s1",
      totals: {
        uncachedInputTokens: 600,
        cachedInputTokens: 400,
        cacheCreationTokens: 0,
        outputTokens: 50,
        reasoningTokens: 10,
      },
      dedupeKey: JSON.stringify(["mistral-vibe", "s1", 3]),
    });
  });

  it("clamps cached input to input and ignores malformed or empty lines", () => {
    const [record] = mistralVibeUsageFormat.parseLine(line({ cachedInputTokens: 5000 }), undefined);
    expect(record?.totals.uncachedInputTokens).toBe(0);
    expect(record?.totals.cachedInputTokens).toBe(1000);
    expect(mistralVibeUsageFormat.parseLine("not json", undefined)).toEqual([]);
    expect(
      mistralVibeUsageFormat.parseLine(
        line({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }),
        undefined,
      ),
    ).toEqual([]);
    expect(mistralVibeUsageFormat.parseLine(line({ timestamp: "nope" }), undefined)).toEqual([]);
  });
});
