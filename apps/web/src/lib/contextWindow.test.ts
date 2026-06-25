import { describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import { deriveLatestContextWindowSnapshot, formatContextWindowTokens } from "./contextWindow";

describe("V2 context window presentation", () => {
  it("uses retained compaction token data when available", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      {
        item: {
          id: "compaction-1" as never,
          threadId: "thread-1" as never,
          runId: null,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 1,
          status: "completed",
          title: null,
          startedAt: null,
          completedAt: null,
          updatedAt: DateTime.makeUnsafe("2026-06-20T00:00:00.000Z"),
          type: "compaction",
          driver: null,
          beforeTokenCount: 10_000,
          afterTokenCount: 2_000,
        },
      },
    ]);
    expect(snapshot?.usedTokens).toBe(2_000);
    expect(snapshot?.totalProcessedTokens).toBe(10_000);
  });

  it("formats compact token values", () => {
    expect(formatContextWindowTokens(1_500)).toBe("1.5k");
  });
});
