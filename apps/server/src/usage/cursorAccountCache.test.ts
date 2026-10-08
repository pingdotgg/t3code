import { assert, describe, it } from "@effect/vitest";

import { cursorFetchRange, mergeCursorFetch } from "./cursorAccountCache.ts";
import type { UsageRecord } from "./usageTranscripts.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

const record = (timestampMs: number): UsageRecord => ({
  provider: "cursor",
  timestampMs,
  model: "claude-fable-5",
  sessionId: "conversation-1",
  totals: {
    uncachedInputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 1,
    reasoningTokens: 0,
  },
  reportedCostUsd: null,
  speed: "standard",
  dedupeKey: `cursor-account:a:${timestampMs}:0`,
});

describe("cursorAccountCache", () => {
  it("refetches everything once the cache no longer reaches the retention start", () => {
    const cache = {
      accountKey: "a",
      sinceMs: 0,
      untilMs: 10 * DAY_MS,
      fetchedAtMs: 10 * DAY_MS,
      records: [record(5 * DAY_MS)],
    };
    const nowMs = 100 * DAY_MS;
    const range = cursorFetchRange(cache, 10 * DAY_MS, nowMs);
    assert.deepStrictEqual(range, { sinceMs: 10 * DAY_MS, untilMs: nowMs });

    const { cache: merged } = mergeCursorFetch(
      cache,
      "a",
      range,
      [record(50 * DAY_MS)],
      nowMs,
      10 * DAY_MS,
    );
    assert.deepStrictEqual(
      merged.records.map((entry) => entry.timestampMs),
      [50 * DAY_MS],
    );
    // Then only the newest edge.
    assert.deepStrictEqual(cursorFetchRange(merged, 11 * DAY_MS, nowMs + DAY_MS), {
      sinceMs: nowMs - 60 * 60 * 1000,
      untilMs: nowMs + DAY_MS,
    });
  });

  it("reports an edge that only confirms the cache as unchanged", () => {
    const cache = {
      accountKey: "a",
      sinceMs: 0,
      untilMs: 10 * DAY_MS,
      fetchedAtMs: 10 * DAY_MS,
      records: [record(DAY_MS), record(10 * DAY_MS)],
    };
    const range = cursorFetchRange(cache, 0, 11 * DAY_MS);
    assert.isFalse(
      mergeCursorFetch(cache, "a", range, [record(10 * DAY_MS)], 11 * DAY_MS, 0).changed,
    );
    assert.isTrue(
      mergeCursorFetch(
        cache,
        "a",
        range,
        [record(10 * DAY_MS), record(10.5 * DAY_MS)],
        11 * DAY_MS,
        0,
      ).changed,
    );
  });
});
