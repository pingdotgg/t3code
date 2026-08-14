import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { UsageBucket } from "./usage.ts";

const decodeUsageBucket = Schema.decodeUnknownSync(UsageBucket);

describe("UsageBucket", () => {
  it("defaults sourceIndex when decoding an older server bucket", () => {
    const decoded = decodeUsageBucket({
      day: "2026-08-14",
      provider: "claude",
      model: "claude-sonnet-4-6",
      totals: {
        uncachedInputTokens: 1,
        cachedInputTokens: 2,
        cacheCreationTokens: 3,
        outputTokens: 4,
        reasoningTokens: 0,
      },
      costUsd: 0.01,
      cacheSavingsUsd: 0.02,
      costSource: "modelPriced",
      records: 1,
      unpricedRecords: 0,
      sessions: 1,
    });

    expect(decoded.sourceIndex).toBe(0);
  });
});
