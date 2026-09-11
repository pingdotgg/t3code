import { describe, expect, it } from "vite-plus/test";

import { mergeUsage } from "@t3tools/shared/usageMerge";
import { UsageDay } from "@t3tools/contracts";
import { usageToCsv, usageToJson } from "./usageExport";

const input = {
  sinceDay: UsageDay.make("2026-08-10"),
  untilDay: UsageDay.make("2026-08-11"),
  timeZone: "UTC",
  resolution: "day" as const,
};

describe("usage exports", () => {
  it("exports model rows as escaped CSV", () => {
    const usage = mergeUsage(
      [
        {
          environmentId: "env-a" as never,
          label: "Local",
          summary: {
            contractVersion: 6,
            readAt: "2026-08-11T00:00:00.000Z",
            timeZone: "UTC",
            sinceDay: input.sinceDay,
            untilDay: input.untilDay,
            buckets: [
              {
                day: input.sinceDay,
                provider: "devin",
                model: "gpt,5.6",
                totals: {
                  uncachedInputTokens: 10,
                  cachedInputTokens: 2,
                  cacheCreationTokens: 0,
                  outputTokens: 5,
                  reasoningTokens: 1,
                },
                costUsd: 0.25,
                cacheSavingsUsd: 0,
                costSource: "providerReported",
                records: 1,
                unpricedRecords: 0,
                sessions: 1,
              },
            ],
            sources: [
              {
                fingerprint: {
                  hostId: "host",
                  provider: "devin",
                  resolvedHomePath: "/logs",
                  volumeId: "1:2",
                },
                status: "ok",
                scannedFiles: 1,
                skippedFiles: 0,
                malformedRecords: 0,
                distinctSessions: 1,
                message: null,
              },
            ],
            pricing: {
              status: "unavailable",
              source: "test",
              fetchedAt: null,
              knownModels: 0,
            },
            scanDurationMs: 1,
          },
        },
      ],
      6,
    );
    const csv = usageToCsv(usage, input);

    expect(csv).toContain("Provider,Model,Tokens,Cost (USD),Records,Cost share");
    expect(csv).toContain('devin,"gpt,5.6"');
    expect(csv).toContain("Total tokens,17");
  });

  it("serializes provider maps in JSON instead of dropping them", () => {
    const usage = mergeUsage([], 6);
    const parsed = JSON.parse(usageToJson(usage, input)) as {
      readonly daily: readonly unknown[];
      readonly window: { readonly timeZone: string };
    };

    expect(parsed.window.timeZone).toBe("UTC");
    expect(parsed.daily).toEqual([]);
  });
});
