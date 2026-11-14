import { describe, expect, it } from "@effect/vitest";

import { resolveModelAliases, UsageAggregator } from "./usageAggregation.ts";
import { decodeScanCache, dedupeWithinFile, makeScanCacheWriter } from "./usageScanCache.ts";
import { TEST_FORMAT_MAP } from "./usageTestFormats.ts";
import { parseClaudeLine } from "../provider/Drivers/claudeUsage.ts";
import type { RateTable } from "./usagePricing.ts";
import type { UsageRecord } from "@t3tools/provider-core/server/usage";

const rates: RateTable = new Map([
  [
    "claude-fable-5",
    {
      inputCostPerToken: 1e-5,
      outputCostPerToken: 5e-5,
      cacheReadCostPerToken: 1e-6,
      cacheCreationCostPerToken: 1.25e-5,
      cacheCreation1hCostPerToken: 2e-5,
      fast: {
        inputCostPerToken: 2e-5,
        outputCostPerToken: 1e-4,
        cacheReadCostPerToken: 2e-6,
        cacheCreationCostPerToken: 2.5e-5,
        cacheCreation1hCostPerToken: 4e-5,
      },
      ultrafast: null,
      contextTiers: [],
    },
  ],
]);

function record(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    provider: "claude",
    timestampMs: Date.parse("2026-08-07T04:05:13.944Z"),
    model: "claude-fable-5",
    sessionId: "session-a",
    totals: {
      uncachedInputTokens: 100,
      cachedInputTokens: 1000,
      cacheCreationTokens: 10,
      outputTokens: 50,
      reasoningTokens: 0,
    },
    reportedCostUsd: null,
    speed: "standard",
    dedupeKey: null,
    ...overrides,
  };
}

function aggregate(
  records: readonly UsageRecord[],
  timeZone = "UTC",
  resolution: "day" | "hour" = "day",
) {
  const hourlyBounds =
    resolution === "hour"
      ? {
          sinceTimeMs: Date.parse("2026-08-06T04:37:00.000Z"),
          untilTimeMs: Date.parse("2026-08-07T04:37:00.000Z"),
        }
      : {};
  const aggregator = new UsageAggregator({
    timeZone,
    sinceDay: "2026-08-01",
    untilDay: "2026-08-31",
    resolution,
    ...hourlyBounds,
    rates,
  });
  for (const item of records) aggregator.add(item);
  return aggregator.finish();
}

describe("UsageAggregator", () => {
  it("splits a bucket's cost by category and speed", () => {
    const [bucket] = aggregate([record(), record({ speed: "fast" })]).buckets;

    expect(bucket).toMatchObject({
      costUsd: expect.closeTo(0.016875),
      categoryCostUsd: {
        input: expect.closeTo(0.003),
        cacheRead: expect.closeTo(0.003),
        cacheWrite: expect.closeTo(0.000375),
        output: expect.closeTo(0.0075),
      },
      fastCostUsd: expect.closeTo(0.01125),
      speedPremiumUsd: expect.closeTo(0.005625),
    });
    expect(bucket).not.toHaveProperty("ultrafastCostUsd");
  });

  it("merges partial copies of a key by channel maximum in the first copy's bucket", () => {
    const zeroTotals = {
      uncachedInputTokens: 0,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
    };
    const partial = record({
      dedupeKey: "msg_1:",
      speed: "fast",
      reportedCostUsd: 1,
      totals: { ...record().totals, cachedInputTokens: 1200, outputTokens: 3, reasoningTokens: 5 },
    });
    const complete = record({
      dedupeKey: "msg_1:",
      model: "claude-fable-5[1m]",
      timestampMs: Date.parse("2026-08-08T12:00:00Z"),
      sessionId: "session-fork",
      reportedCostUsd: 2,
      totals: {
        uncachedInputTokens: 2,
        cachedInputTokens: 1000,
        cacheCreationTokens: 40,
        outputTokens: 264,
        reasoningTokens: 135,
      },
    });
    const zero = { ...partial, totals: zeroTotals, reportedCostUsd: null };
    const merged = {
      reportedCostUsd: 2,
      totals: { ...complete.totals, uncachedInputTokens: 100, cachedInputTokens: 1200 },
    };

    for (const copies of [
      [zero, partial, complete, complete],
      [complete, partial, zero, zero],
    ]) {
      const aggregator = new UsageAggregator({
        timeZone: "UTC",
        sinceDay: "2026-08-01",
        untilDay: "2026-08-31",
        rates,
      });
      copies.forEach((copy, index) => aggregator.add(copy, `${index}.jsonl`));
      const result = aggregator.finish();
      const expected = aggregate([{ ...copies[0]!, ...merged }]).buckets[0];

      expect(result.duplicatesDropped).toBe(3);
      expect(result.buckets).toEqual([{ ...expected, sourcePath: "0.jsonl" }]);
    }
  });

  it("does not count a key whose first copy fell outside the window", () => {
    const result = aggregate([
      record({ dedupeKey: "msg_1:", timestampMs: Date.parse("2026-07-01T12:00:00Z") }),
      record({ dedupeKey: "msg_1:", totals: { ...record().totals, outputTokens: 500 } }),
    ]);

    expect(result.duplicatesDropped).toBe(1);
    expect(result.outOfWindow).toBe(1);
    expect(result.buckets).toHaveLength(0);
  });

  it.each([false, true])(
    "replaces a fallback's stream-start copy across cached files (reverse=%s)",
    (reverse) => {
      const attempt = {
        type: "message",
        model: "claude-opus-5-5",
        input_tokens: 3,
        cache_creation_input_tokens: 20000,
        output_tokens: 250,
      };
      const fallback = {
        type: "fallback_message",
        model: "claude-fable-5",
        input_tokens: 6,
        cache_creation_input_tokens: 10000,
        output_tokens: 900,
      };
      const line = (usage: unknown) =>
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-08-07T04:05:13.944Z",
          sessionId: "session-a",
          requestId: "req_fallback",
          message: { id: "msg_fallback", model: attempt.model, usage },
        });
      const early = parseClaudeLine(line({ ...attempt, output_tokens: 3 }));
      const complete = parseClaudeLine(
        line({ ...fallback, cache_creation_input_tokens: 30000, iterations: [attempt, fallback] }),
      );
      const original = new Map(
        [
          ...new Map<string, readonly UsageRecord[]>([
            ["/partial.jsonl", early.map((entry) => ({ ...entry, sessionId: "session-fork" }))],
            ["/complete.jsonl", dedupeWithinFile([...early, ...complete, ...complete])],
            [
              "/deleted.jsonl",
              [
                {
                  ...early[0]!,
                  sessionId: "session-deleted",
                  totals: { ...early[0]!.totals, cacheCreationTokens: 30000 },
                },
              ],
            ],
          ]),
        ].map(
          ([path, records]) =>
            [
              path,
              {
                provider: "claude" as const,
                size: 100,
                mtimeMs: 100,
                records,
                tailRecords: [],
                malformedRecords: 0,
                position: { resumeOffset: 100, guardLength: 0, guardHash: 0, state: null },
              },
            ] as const,
        ),
      );
      const cache = decodeScanCache(
        JSON.parse([...makeScanCacheWriter()(original, {})].join("")),
        TEST_FORMAT_MAP,
      );
      const copies = [...cache.values()];
      if (reverse) copies.reverse();
      for (const model of [undefined, attempt.model, fallback.model]) {
        const aggregator = new UsageAggregator({
          timeZone: "UTC",
          sinceDay: "2026-08-01",
          untilDay: "2026-08-31",
          rates,
          ...(model === undefined ? {} : { modelFilter: { include: [{ model }] } }),
        });
        for (const file of copies) for (const record of file.records) aggregator.add(record);
        const buckets = aggregator.finish().buckets;
        const expected =
          model === undefined
            ? [attempt, fallback]
            : [model === attempt.model ? attempt : fallback];
        expect(
          buckets.map((bucket) => [
            bucket.model,
            bucket.totals.cacheCreationTokens,
            bucket.totals.outputTokens,
            bucket.records,
            bucket.sessions,
          ]),
        ).toEqual(
          expected
            .toSorted((a, b) => a.model.localeCompare(b.model))
            .map((entry) => [
              entry.model,
              entry.cache_creation_input_tokens,
              entry.output_tokens,
              1,
              1,
            ]),
        );
      }
    },
  );

  it("buckets by the day in the requested time zone", () => {
    const utc = aggregate([record()], "UTC");
    const losAngeles = aggregate([record()], "America/Los_Angeles");

    expect(utc.buckets[0]?.day).toBe("2026-08-07");
    expect(losAngeles.buckets[0]?.day).toBe("2026-08-06");
  });

  it("finds the day at a quarter-hour zone's midnight across interleaved buckets", () => {
    const result = aggregate(
      [
        record({ timestampMs: Date.parse("2026-08-01T18:14:59.999Z") }),
        record({ timestampMs: Date.parse("2026-08-01T18:15:00.000Z") }),
        record({ timestampMs: Date.parse("2026-08-01T18:15:00.000Z"), model: "claude-opus-5" }),
        record({ timestampMs: Date.parse("2026-08-01T18:16:00.000Z") }),
      ],
      "Asia/Kathmandu",
    );

    expect(result.buckets.map((bucket) => [bucket.day, bucket.model, bucket.records])).toEqual([
      ["2026-08-01", "claude-fable-5", 1],
      ["2026-08-02", "claude-fable-5", 2],
      ["2026-08-02", "claude-opus-5", 1],
    ]);
  });

  it("finds the day at a fixed offset's midnight between quarter hours", () => {
    const result = aggregate(
      [
        record({ timestampMs: Date.parse("2026-08-01T23:58:59.999Z") }),
        record({ timestampMs: Date.parse("2026-08-01T23:59:00.000Z") }),
      ],
      "+00:01",
    );

    expect(result.buckets.map((bucket) => [bucket.day, bucket.records])).toEqual([
      ["2026-08-01", 1],
      ["2026-08-02", 1],
    ]);
  });

  it("splits an hourly request into fixed buckets anchored to its exact start", () => {
    const result = aggregate(
      [
        record({ timestampMs: Date.parse("2026-08-07T02:40:13.944Z") }),
        record({ timestampMs: Date.parse("2026-08-07T03:40:13.944Z") }),
      ],
      "America/Los_Angeles",
      "hour",
    );

    expect(result.buckets.map((bucket) => [bucket.day, bucket.hourStart])).toEqual([
      ["2026-08-06", "2026-08-07T02:37:00.000Z"],
      ["2026-08-06", "2026-08-07T03:37:00.000Z"],
    ]);
  });

  it("uses an inclusive start and exclusive end for rolling windows", () => {
    const result = aggregate(
      [
        record({ timestampMs: Date.parse("2026-08-06T04:36:59.999Z") }),
        record({ timestampMs: Date.parse("2026-08-06T04:37:00.000Z") }),
        record({ timestampMs: Date.parse("2026-08-07T04:36:59.999Z") }),
        record({ timestampMs: Date.parse("2026-08-07T04:37:00.000Z") }),
      ],
      "UTC",
      "hour",
    );

    expect(result.outOfWindow).toBe(2);
    expect(result.buckets.map((bucket) => bucket.hourStart)).toEqual([
      "2026-08-06T04:37:00.000Z",
      "2026-08-07T03:37:00.000Z",
    ]);
  });

  it("counts tokens but not cost for a model with no rate", () => {
    const result = aggregate([record({ model: "kimi-k3" })]);

    expect(result.buckets[0]?.costUsd).toBe(0);
    expect(result.buckets[0]?.costSource).toBe("unpriced");
    expect(result.buckets[0]?.unpricedRecords).toBe(1);
    expect(result.buckets[0]?.totals.outputTokens).toBe(50);
  });

  it("prefers a reported cost over the rate table", () => {
    const result = aggregate([record({ reportedCostUsd: 1.25 })]);

    expect(result.buckets[0]?.costUsd).toBe(1.25);
    expect(result.buckets[0]?.costSource).toBe("providerReported");
  });

  it("folds a mapped model into its target and prices it there", () => {
    const aggregator = new UsageAggregator({
      timeZone: "UTC",
      sinceDay: "2026-08-01",
      untilDay: "2026-08-31",
      rates,
      modelAliases: resolveModelAliases({ "example-preview": "claude-fable-5" }),
    });
    aggregator.add(record());
    aggregator.add(record({ model: "example-preview", rateModel: "example-preview-high" }));
    const result = aggregator.finish();

    expect(result.buckets).toHaveLength(1);
    expect(result.buckets[0]?.model).toBe("claude-fable-5");
    expect(result.buckets[0]?.records).toBe(2);
    expect(result.buckets[0]?.costUsd).toBeCloseTo(0.00925, 9);
    expect(result.buckets[0]?.unpricedRecords).toBe(0);
  });
});

describe("resolveModelAliases", () => {
  it("follows chains to the final model and drops chains that enter a loop", () => {
    expect(
      resolveModelAliases({
        "preview[1m]": "preview",
        preview: "example-model",
        loop: "back",
        back: "loop",
        intoLoop: "loop",
        self: "self",
      }),
    ).toEqual(
      new Map([
        ["preview[1m]", "example-model"],
        ["preview", "example-model"],
      ]),
    );
  });
});
