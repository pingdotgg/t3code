import { ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { makeProjectResolver, UsageAggregator } from "./usageAggregation.ts";
import type { RateTable } from "./usagePricing.ts";
import type { UsageRecord } from "./usageTranscripts.ts";

const rates: RateTable = new Map([
  [
    "claude-fable-5",
    {
      inputCostPerToken: 1e-5,
      outputCostPerToken: 5e-5,
      cacheReadCostPerToken: 1e-6,
      cacheCreationCostPerToken: 1.25e-5,
      cacheCreation1hCostPerToken: 2e-5,
    },
  ],
]);

function record(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    provider: "claude",
    // 2026-08-07T04:05Z is still Aug 6 in Los Angeles.
    timestampMs: Date.parse("2026-08-07T04:05:13.944Z"),
    model: "claude-fable-5",
    sessionId: "session-a",
    cwd: "",
    totals: {
      uncachedInputTokens: 100,
      cachedInputTokens: 1000,
      cacheCreationTokens: 10,
      outputTokens: 50,
      reasoningTokens: 0,
    },
    reportedCostUsd: null,
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
  it("requires exact bounds for hourly aggregation", () => {
    expect(
      () =>
        new UsageAggregator({
          timeZone: "UTC",
          sinceDay: "2026-08-01",
          untilDay: "2026-08-31",
          resolution: "hour",
          rates,
        }),
    ).toThrow("requires exact time bounds");
  });

  it("uses the final complete snapshot for a repeated dedupe key", () => {
    const result = aggregate([
      record({
        dedupeKey: "msg_partial:",
        totals: { ...record().totals, outputTokens: 1 },
      }),
      record({
        dedupeKey: "msg_partial:",
        totals: { ...record().totals, outputTokens: 310 },
      }),
    ]);

    expect(result.buckets[0]?.records).toBe(1);
    expect(result.buckets[0]?.totals.outputTokens).toBe(310);
  });

  it("still sums records that carry no dedupe key", () => {
    const result = aggregate([record(), record()]);

    expect(result.buckets[0]?.totals.outputTokens).toBe(100);
  });

  it("distinguishes project, outside, and unknown attribution", () => {
    const projectId = ProjectId.make("project-app");
    const aggregator = new UsageAggregator({
      timeZone: "UTC",
      sinceDay: "2026-08-01",
      untilDay: "2026-08-31",
      rates,
      resolveProject: (cwd) => (cwd === "/work/app" ? { projectId, title: "App" } : null),
    });
    aggregator.add(record({ cwd: "/work/app" }));
    aggregator.add(record({ cwd: "/work/app" }));
    aggregator.add(record({ cwd: "/elsewhere" }));
    aggregator.add(record({ cwd: "", model: "grok-4" }));
    const { buckets } = aggregator.finish();

    expect(buckets).toHaveLength(3);
    const outside = buckets.find((bucket) => bucket.projectAttribution === "outside");
    expect(outside?.project).toBeUndefined();
    expect(outside?.records).toBe(1);
    const project = buckets.find((bucket) => bucket.projectAttribution === "project");
    expect(project?.project).toBe("App");
    expect(project?.projectId).toBe(projectId);
    expect(project?.records).toBe(2);
    expect(buckets.some((bucket) => bucket.projectAttribution === "unknown")).toBe(true);
  });

  it("marks every bucket unknown when no project resolver is available", () => {
    const result = aggregate([record({ cwd: "/work/app" })]);

    expect(result.buckets[0]?.projectAttribution).toBe("unknown");
  });

  it("buckets by the day in the requested time zone", () => {
    const utc = aggregate([record()], "UTC");
    const losAngeles = aggregate([record()], "America/Los_Angeles");

    expect(utc.buckets[0]?.day).toBe("2026-08-07");
    expect(losAngeles.buckets[0]?.day).toBe("2026-08-06");
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

  it("keeps daily payloads collapsed when hourly resolution is not requested", () => {
    const result = aggregate([
      record({ timestampMs: Date.parse("2026-08-07T04:05:13.944Z") }),
      record({ timestampMs: Date.parse("2026-08-07T05:05:13.944Z") }),
    ]);

    expect(result.buckets).toHaveLength(1);
    expect(result.buckets[0]?.hourStart).toBeUndefined();
    expect(result.buckets[0]?.records).toBe(2);
  });

  it("prices against the rate table", () => {
    const result = aggregate([record()]);

    // 100*1e-5 + 1000*1e-6 + 10*1.25e-5 + 50*5e-5
    expect(result.buckets[0]?.costUsd).toBeCloseTo(0.004625, 9);
    expect(result.buckets[0]?.costSource).toBe("modelPriced");
    // Cache writes priced at the cache-write rate: 10 * 1.25e-5.
    expect(result.buckets[0]?.cacheWriteUsd).toBeCloseTo(1.25e-4, 12);
  });

  it("prices one-hour cache writes at their separate rate", () => {
    const result = aggregate([
      record({
        totals: {
          ...record().totals,
          cacheCreationTokens: 30,
          cacheCreation5mTokens: 10,
          cacheCreation1hTokens: 20,
        },
      }),
    ]);

    expect(result.buckets[0]?.cacheWriteUsd).toBeCloseTo(10 * 1.25e-5 + 20 * 2e-5, 12);
  });

  it("distinguishes unavailable cache-write cost from write-free usage", () => {
    const unpriced = aggregate([record({ model: "kimi-k3" })]);
    expect(unpriced.buckets[0]?.cacheWriteUsd).toBeUndefined();

    const writeFree = aggregate([
      record({
        totals: {
          uncachedInputTokens: 100,
          cachedInputTokens: 1000,
          cacheCreationTokens: 0,
          outputTokens: 50,
          reasoningTokens: 0,
        },
      }),
    ]);
    expect(writeFree.buckets[0]?.cacheWriteUsd).toBe(0);
  });

  it("marks cache-write cost unavailable when a legacy aggregate lacks TTL provenance", () => {
    const aggregator = new UsageAggregator({
      timeZone: "UTC",
      sinceDay: "2026-08-01",
      untilDay: "2026-08-31",
      resolution: "day",
      rates,
    });
    const item = record();
    aggregator.addAggregate({
      bucketStartMs: item.timestampMs,
      provider: item.provider,
      model: item.model,
      totals: item.totals,
      pricedTotals: item.totals,
      savingsTotals: item.totals,
      reportedCostUsd: 0,
      records: 1,
      unpricedRecords: 0,
      providerReportedRecords: 0,
      sessions: [item.sessionId],
    });

    expect(aggregator.finish().buckets[0]?.cacheWriteUsd).toBeUndefined();
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
    expect(result.buckets[0]?.cacheWriteUsd).toBeUndefined();
  });

  it("keeps cache savings for provider-reported aggregate cells", () => {
    const aggregator = new UsageAggregator({
      timeZone: "UTC",
      sinceDay: "2026-08-01",
      untilDay: "2026-08-31",
      rates,
    });
    aggregator.addAggregate({
      bucketStartMs: Date.parse("2026-08-07T04:00:00.000Z"),
      provider: "claude",
      model: "claude-fable-5",
      totals: record().totals,
      pricedTotals: {
        uncachedInputTokens: 0,
        cachedInputTokens: 0,
        cacheCreationTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
      },
      savingsTotals: record().totals,
      reportedCostUsd: 1.25,
      records: 1,
      unpricedRecords: 0,
      providerReportedRecords: 1,
      sessions: ["session-a"],
    });
    expect(aggregator.finish().buckets[0]?.cacheSavingsUsd).toBeCloseTo(0.009, 9);
  });

  it("counts only legacy null-cost rows in a mixed provenance cell", () => {
    const aggregator = new UsageAggregator({
      timeZone: "UTC",
      sinceDay: "2026-08-01",
      untilDay: "2026-08-31",
      rates: new Map(),
    });
    const bucketStartMs = Date.parse("2026-08-07T04:00:00.000Z");
    aggregator.addAggregate({
      bucketStartMs,
      provider: "claude",
      model: "legacy-model",
      totals: { ...record().totals, outputTokens: 12 },
      pricedTotals: { ...record().totals, outputTokens: 5 },
      savingsTotals: { ...record().totals, outputTokens: 12 },
      reportedCostUsd: 1.5,
      records: 2,
      unpricedRecords: 0,
      providerReportedRecords: 1,
      legacyPricing: true,
      legacyPricingRecords: 1,
      sessions: ["legacy-session", "provider-session"],
    });

    const bucket = aggregator.finish().buckets[0]!;
    expect(bucket.records).toBe(2);
    expect(bucket.unpricedRecords).toBe(1);
    expect(bucket.costUsd).toBe(1.5);
  });

  it("applies an explicit override to every row in a mixed-provenance cell", () => {
    const aggregator = new UsageAggregator({
      timeZone: "UTC",
      sinceDay: "2026-08-01",
      untilDay: "2026-08-31",
      rates: new Map(),
      priceOverrides: new Map([
        [
          "custom-model",
          {
            inputCostPerToken: 1e-6,
            outputCostPerToken: 1e-6,
            cacheReadCostPerToken: 0.5e-6,
            cacheCreationCostPerToken: 1e-6,
          },
        ],
      ]),
    });
    aggregator.addAggregate({
      bucketStartMs: Date.parse("2026-08-07T04:00:00.000Z"),
      provider: "claude",
      model: "custom-model",
      totals: { ...record().totals, outputTokens: 12 },
      pricedTotals: { ...record().totals, outputTokens: 5 },
      savingsTotals: { ...record().totals, outputTokens: 12 },
      reportedCostUsd: 1.5,
      records: 2,
      unpricedRecords: 0,
      providerReportedRecords: 1,
      dynamicPricing: true,
      sessions: ["custom-session", "provider-session"],
    });

    const bucket = aggregator.finish().buckets[0]!;
    expect(bucket.costUsd).toBeCloseTo(0.000622, 9);
    expect(bucket.cacheSavingsUsd).toBeCloseTo(0.0005, 9);
    expect(bucket.unpricedRecords).toBe(0);
    expect(bucket.costSource).toBe("modelPriced");
  });

  it("applies an explicit override ahead of a provider-reported aggregate cost", () => {
    const aggregator = new UsageAggregator({
      timeZone: "UTC",
      sinceDay: "2026-08-01",
      untilDay: "2026-08-31",
      rates: new Map(),
      priceOverrides: new Map([
        [
          "custom-model",
          {
            inputCostPerToken: 1e-6,
            outputCostPerToken: 1e-6,
            cacheReadCostPerToken: 0.5e-6,
            cacheCreationCostPerToken: 1e-6,
          },
        ],
      ]),
    });
    aggregator.addAggregate({
      bucketStartMs: Date.parse("2026-08-07T04:00:00.000Z"),
      provider: "claude",
      model: "custom-model",
      totals: record().totals,
      pricedTotals: {
        uncachedInputTokens: 0,
        cachedInputTokens: 0,
        cacheCreationTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
      },
      savingsTotals: record().totals,
      reportedCostUsd: 99,
      records: 1,
      unpricedRecords: 0,
      providerReportedRecords: 1,
      dynamicPricing: false,
      sessions: ["provider-session"],
    });

    const bucket = aggregator.finish().buckets[0]!;
    expect(bucket.costUsd).toBeCloseTo(0.00066, 9);
    expect(bucket.unpricedRecords).toBe(0);
    expect(bucket.costSource).toBe("modelPriced");
  });

  it("counts v2 model-priced records as unpriced when rates are unavailable", () => {
    const aggregator = new UsageAggregator({
      timeZone: "UTC",
      sinceDay: "2026-08-01",
      untilDay: "2026-08-31",
      rates: new Map(),
    });
    aggregator.addAggregate({
      bucketStartMs: Date.parse("2026-08-07T04:00:00.000Z"),
      provider: "claude",
      model: "claude-fable-5",
      totals: { ...record().totals, outputTokens: 12 },
      pricedTotals: { ...record().totals, outputTokens: 12 },
      savingsTotals: record().totals,
      reportedCostUsd: 0,
      records: 2,
      unpricedRecords: 0,
      providerReportedRecords: 0,
      sessions: ["session-a"],
    });

    const bucket = aggregator.finish().buckets[0]!;
    expect(bucket.costUsd).toBe(0);
    expect(bucket.costSource).toBe("unpriced");
    expect(bucket.records).toBe(2);
    expect(bucket.unpricedRecords).toBe(2);
  });

  it("drops records outside the window", () => {
    const result = aggregate([record({ timestampMs: Date.parse("2026-07-01T12:00:00Z") })]);

    expect(result.outOfWindow).toBe(1);
    expect(result.buckets).toHaveLength(0);
  });

  it("reports whether a record falls in the window", () => {
    const aggregator = new UsageAggregator({
      timeZone: "UTC",
      sinceDay: "2026-08-01",
      untilDay: "2026-08-31",
      rates,
    });

    expect(aggregator.add(record({ dedupeKey: "msg_1:" }))).toBe(true);
    expect(aggregator.add(record({ dedupeKey: "msg_1:" }))).toBe(true);
    expect(aggregator.add(record({ timestampMs: Date.parse("2026-07-01T12:00:00Z") }))).toBe(false);
  });

  it("counts sessions from the final progressive snapshot", () => {
    const aggregator = new UsageAggregator({
      timeZone: "UTC",
      sinceDay: "2026-08-01",
      untilDay: "2026-08-31",
      rates,
    });

    aggregator.add(record({ dedupeKey: "msg_1:", sessionId: "partial-session" }));
    aggregator.add(record({ dedupeKey: "msg_1:", sessionId: "final-session" }));

    expect(aggregator.distinctSessions("claude")).toBe(1);
    expect(aggregator.finish().buckets[0]?.sessions).toBe(1);
  });

  it("applies the window to the final progressive snapshot", () => {
    const aggregator = new UsageAggregator({
      timeZone: "UTC",
      sinceDay: "2026-08-01",
      untilDay: "2026-08-31",
      rates,
    });

    aggregator.add(record({ dedupeKey: "msg_1:" }));
    aggregator.add(
      record({ dedupeKey: "msg_1:", timestampMs: Date.parse("2026-09-01T00:00:00Z") }),
    );

    expect(aggregator.finish()).toMatchObject({ buckets: [], outOfWindow: 1 });
  });

  it("separates providers and models into their own buckets", () => {
    const result = aggregate([
      record(),
      record({ provider: "codex", model: "gpt-5.6-sol" }),
      record({ model: "claude-opus-5" }),
    ]);

    expect(result.buckets).toHaveLength(3);
  });
});

describe("makeProjectResolver", () => {
  const appId = ProjectId.make("project-app");
  const vendoredId = ProjectId.make("project-vendored");
  const legacyDeletedId = ProjectId.make("project-legacy-deleted");
  const legacyId = ProjectId.make("project-legacy");
  const untitledId = ProjectId.make("project-untitled");
  const resolver = makeProjectResolver([
    { projectId: appId, workspaceRoot: "/work/app", title: "App", deleted: false },
    {
      projectId: vendoredId,
      workspaceRoot: "/work/app/vendored",
      title: "Vendored",
      deleted: false,
    },
    {
      projectId: legacyDeletedId,
      workspaceRoot: "/work/legacy",
      title: "Legacy Was Deleted",
      deleted: true,
    },
    {
      projectId: legacyId,
      workspaceRoot: "/work/legacy",
      title: "Legacy",
      deleted: false,
    },
    {
      projectId: untitledId,
      workspaceRoot: "/work/untitled",
      title: "   ",
      deleted: false,
    },
  ]);

  it("matches the root itself and any path under it", () => {
    expect(resolver("/work/app")).toEqual({ projectId: appId, title: "App" });
    expect(resolver("/work/app/src/deep")).toEqual({ projectId: appId, title: "App" });
  });

  it("requires a path-segment boundary, not a bare prefix", () => {
    expect(resolver("/work/app-sibling")).toBeNull();
  });

  it("prefers the deepest matching root", () => {
    expect(resolver("/work/app/vendored/lib")).toEqual({
      projectId: vendoredId,
      title: "Vendored",
    });
  });

  it("prefers a live project over a deleted one sharing the root", () => {
    expect(resolver("/work/legacy/src")).toEqual({ projectId: legacyId, title: "Legacy" });
  });

  it("never attributes to a blank title or an empty cwd", () => {
    expect(resolver("/work/untitled/src")).toBeNull();
    expect(resolver("")).toBeNull();
  });

  it("matches descendants when the project root is the filesystem root", () => {
    const rootId = ProjectId.make("project-root");
    const rootResolver = makeProjectResolver([
      { projectId: rootId, workspaceRoot: "/", title: "Root", deleted: false },
    ]);

    expect(rootResolver("/work/app")).toEqual({ projectId: rootId, title: "Root" });
  });

  it("matches mixed slash styles and normalized segments", () => {
    expect(resolver("\\work\\app\\src")).toEqual({ projectId: appId, title: "App" });
    expect(resolver("/work/app/other/../src")).toEqual({ projectId: appId, title: "App" });

    const windowsResolver = makeProjectResolver([
      { projectId: appId, workspaceRoot: "C:\\Work\\App", title: "App", deleted: false },
    ]);
    expect(windowsResolver("c:/work/app/src")).toEqual({ projectId: appId, title: "App" });
  });
});
