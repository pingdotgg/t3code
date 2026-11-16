import { ProviderThreadId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { deriveThreadUsageRows } from "./threadUsage";

const updatedAt = "2026-11-16T00:00:00.000Z";

describe("deriveThreadUsageRows", () => {
  it("returns no rows when there is no usage", () => {
    expect(deriveThreadUsageRows(null)).toEqual([]);
    expect(deriveThreadUsageRows(undefined)).toEqual([]);
    expect(
      deriveThreadUsageRows({
        threadId: ThreadId.make("thread-1"),
        providerThread: null,
        latestTurnTokenUsage: null,
      }),
    ).toEqual([]);
  });

  it("shows context used, max and percentage", () => {
    const rows = deriveThreadUsageRows({
      threadId: ThreadId.make("thread-1"),
      providerThread: {
        id: ProviderThreadId.make("provider-thread-1"),
        contextUsage: { usedTokens: 50_000, maxTokens: 200_000 },
        updatedAt: DateTime.makeUnsafe(updatedAt),
      },
      latestTurnTokenUsage: null,
    });
    expect(rows).toEqual([{ label: "Context", value: "50k / 200k (25%)" }]);
  });

  it("shows used tokens without a percentage when max is unknown", () => {
    const rows = deriveThreadUsageRows({
      threadId: ThreadId.make("thread-1"),
      providerThread: {
        id: ProviderThreadId.make("provider-thread-1"),
        contextUsage: { usedTokens: 1_500 },
        updatedAt: DateTime.makeUnsafe(updatedAt),
      },
      latestTurnTokenUsage: null,
    });
    expect(rows).toEqual([{ label: "Context", value: "1.5k tokens" }]);
  });

  it("adds the latest turn breakdown and omits absent fields", () => {
    const rows = deriveThreadUsageRows({
      threadId: ThreadId.make("thread-1"),
      providerThread: null,
      latestTurnTokenUsage: {
        usedTokens: 12_000,
        inputTokens: 10_000,
        outputTokens: 2_000,
        updatedAt,
      },
    });
    expect(rows).toEqual([
      { label: "Last turn", value: "12K tokens" },
      { label: "Input", value: "10K" },
      { label: "Output", value: "2K" },
    ]);
  });
});
