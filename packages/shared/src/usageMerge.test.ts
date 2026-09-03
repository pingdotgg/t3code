import {
  USAGE_CONTRACT_VERSION,
  type EnvironmentId,
  type UsageBucket,
  type UsageDay,
  type UsageProviderKind,
  type UsageSummary,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { mergeUsage, type EnvironmentUsage } from "./usageMerge.ts";

function bucket(overrides: Partial<UsageBucket> = {}): UsageBucket {
  return {
    day: "2026-08-07" as UsageDay,
    provider: "claude",
    model: "claude-fable-5",
    totals: {
      uncachedInputTokens: 100,
      cachedInputTokens: 1000,
      cacheCreationTokens: 10,
      outputTokens: 50,
      reasoningTokens: 0,
    },
    costUsd: 10,
    cacheSavingsUsd: 2,
    costSource: "modelPriced",
    records: 5,
    unpricedRecords: 0,
    sessions: 1,
    ...overrides,
  };
}

function summary(
  buckets: readonly UsageBucket[],
  sources: readonly {
    provider: UsageProviderKind;
    hostId: string;
    homePath: string;
    volumeId?: string;
    distinctSessions?: number;
  }[],
  contractVersion: number = USAGE_CONTRACT_VERSION,
): UsageSummary {
  return {
    contractVersion,
    readAt: "2026-08-07T00:00:00.000Z",
    timeZone: "UTC",
    sinceDay: "2026-08-01" as UsageDay,
    untilDay: "2026-08-31" as UsageDay,
    buckets,
    sources: sources.map((source) => ({
      fingerprint: {
        hostId: source.hostId,
        provider: source.provider,
        resolvedHomePath: source.homePath,
        volumeId: source.volumeId ?? `vol-${source.hostId}`,
      },
      status: "ok" as const,
      scannedFiles: 1,
      skippedFiles: 0,
      malformedRecords: 0,
      distinctSessions: source.distinctSessions ?? 1,
      message: null,
    })),
    pricing: { status: "fresh", source: "litellm", fetchedAt: null, knownModels: 10 },
    coverage: {
      availableThroughDay: "2026-08-31" as UsageDay,
      availableThroughTime: null,
      generatedAt: "2026-08-31T00:00:00.000Z",
    },
    scanDurationMs: 1,
  };
}

function environment(id: string, usageSummary: UsageSummary): EnvironmentUsage {
  return { environmentId: id as EnvironmentId, label: id, summary: usageSummary };
}

describe("mergeUsage", () => {
  it("sums environments that read different transcript directories", () => {
    const merged = mergeUsage(
      [
        environment(
          "env-a",
          summary([bucket()], [{ provider: "claude", hostId: "mac", homePath: "/a/.claude" }]),
        ),
        environment(
          "env-b",
          summary([bucket()], [{ provider: "claude", hostId: "linux", homePath: "/b/.claude" }]),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.costUsd).toBe(20);
    expect(merged.records).toBe(10);
    expect(merged.duplicateSources).toHaveLength(0);
    expect(merged.availableThroughDay).toBe("2026-08-31");
  });

  it("uses the earliest coverage boundary across environments", () => {
    const earlier = summary([], [{ provider: "claude", hostId: "linux", homePath: "/b" }]);
    const merged = mergeUsage(
      [
        environment("env-a", summary([], [{ provider: "claude", hostId: "mac", homePath: "/a" }])),
        environment("env-b", {
          ...earlier,
          coverage: {
            ...earlier.coverage!,
            availableThroughDay: "2026-08-29" as UsageDay,
          },
        }),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.availableThroughDay).toBe("2026-08-29");
  });

  it("keeps coverage for an all-missing complete zero summary", () => {
    const empty = summary([], []);
    const merged = mergeUsage(
      [
        environment("env-empty", {
          ...empty,
          sources: [
            {
              ...empty.sources[0],
              fingerprint: {
                hostId: "mac",
                provider: "claude",
                resolvedHomePath: "/missing",
                volumeId: "vol-missing",
              },
              status: "missing",
              message: "No transcript directory.",
            },
          ],
        }),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.availableThroughDay).toBe("2026-08-31");
  });

  it("ignores duplicate-owner coverage when choosing the shared boundary", () => {
    const owner = summary([bucket()], [{ provider: "claude", hostId: "mac", homePath: "/a" }]);
    const duplicate = {
      ...owner,
      coverage: {
        ...owner.coverage!,
        availableThroughDay: "2026-08-01" as UsageDay,
      },
    };
    const merged = mergeUsage(
      [environment("env-a-owner", owner), environment("env-b-duplicate", duplicate)],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.availableThroughDay).toBe("2026-08-31");
  });

  it("filters every aggregate to the shared cutoff and reports the oldest snapshot", () => {
    const first = summary(
      [
        bucket({ day: "2026-08-28" as UsageDay, costUsd: 3, model: "old-model" }),
        bucket({ day: "2026-08-29" as UsageDay, costUsd: 4, model: "old-model" }),
      ],
      [{ provider: "claude", hostId: "mac", homePath: "/a", distinctSessions: 1 }],
    );
    const second = summary(
      [
        bucket({ day: "2026-08-28" as UsageDay, costUsd: 5, model: "other-model" }),
        bucket({ day: "2026-08-31" as UsageDay, costUsd: 99, model: "future-model" }),
      ],
      [{ provider: "claude", hostId: "linux", homePath: "/b", distinctSessions: 2 }],
    );
    const merged = mergeUsage(
      [
        environment("env-a", {
          ...first,
          coverage: {
            ...first.coverage!,
            availableThroughDay: "2026-08-29" as UsageDay,
            generatedAt: "2026-08-28T12:00:00.000Z",
          },
        }),
        environment("env-b", second),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.costUsd).toBe(12);
    expect(merged.models.map((model) => model.model)).not.toContain("future-model");
    expect(merged.daily.map((day) => day.day)).toEqual(["2026-08-28", "2026-08-29"]);
    expect(merged.sessions).toBe(0);
    expect(merged.sessionsExact).toBe(false);
    expect(merged.lastUpdatedAt).toBe("2026-08-28T12:00:00.000Z");
  });

  it("excludes an unbounded legacy summary instead of guessing its coverage", () => {
    const legacy = summary([], [{ provider: "claude", hostId: "mac", homePath: "/a" }]);
    const { coverage: _coverage, ...withoutCoverage } = legacy;
    const merged = mergeUsage([environment("legacy", withoutCoverage)], USAGE_CONTRACT_VERSION);

    expect(merged.costUsd).toBe(0);
    expect(merged.staleEnvironments).toEqual(["legacy"]);
  });

  it("counts a shared transcript directory once", () => {
    // Two worktree servers on one machine resolve the same provider home.
    const shared = { provider: "claude" as const, hostId: "mac", homePath: "/home/theo/.claude" };
    const merged = mergeUsage(
      [
        environment("env-a", summary([bucket()], [shared])),
        environment("env-b", summary([bucket()], [shared])),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.costUsd).toBe(10);
    expect(merged.records).toBe(5);
    expect(merged.sessions).toBe(1);
    expect(merged.duplicateSources).toHaveLength(1);
    expect(merged.contributingEnvironments).toEqual(["env-a"]);
  });

  it("drops only the duplicated provider, keeping the environment's other one", () => {
    const sharedClaude = {
      provider: "claude" as const,
      hostId: "mac",
      homePath: "/home/theo/.claude",
    };
    const merged = mergeUsage(
      [
        environment("env-a", summary([bucket()], [sharedClaude])),
        environment(
          "env-b",
          summary(
            [bucket(), bucket({ provider: "codex", model: "gpt-5.6-sol", costUsd: 4 })],
            [sharedClaude, { provider: "codex", hostId: "mac", homePath: "/home/theo/.codex" }],
          ),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    // env-b's claude bucket is dropped, its codex bucket survives.
    expect(merged.costUsd).toBe(14);
    expect(merged.providers.map((provider) => provider.provider).sort()).toEqual([
      "claude",
      "codex",
    ]);
    expect(merged.sessions).toBe(2);
    expect(
      Object.fromEntries(
        merged.providers.map((provider) => [provider.provider, provider.sessions]),
      ),
    ).toEqual({ claude: 1, codex: 1 });
  });

  it("excludes an environment reporting an older contract version", () => {
    const merged = mergeUsage(
      [
        environment(
          "env-a",
          summary([bucket()], [{ provider: "claude", hostId: "mac", homePath: "/a" }]),
        ),
        environment(
          "env-b",
          summary(
            [bucket()],
            [{ provider: "claude", hostId: "linux", homePath: "/b" }],
            USAGE_CONTRACT_VERSION - 3,
          ),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.costUsd).toBe(10);
    expect(merged.staleEnvironments).toEqual(["env-b"]);
  });

  it("keeps the previous compatible contract version so additive provider expansions still merge", () => {
    const merged = mergeUsage(
      [
        environment(
          "env-a",
          summary(
            [bucket({ costUsd: 10 })],
            [{ provider: "claude", hostId: "mac", homePath: "/a" }],
          ),
        ),
        environment(
          "env-b",
          summary(
            [bucket({ costUsd: 4, provider: "codex", model: "gpt-5.6-sol" })],
            [{ provider: "codex", hostId: "linux", homePath: "/b" }],
            USAGE_CONTRACT_VERSION - 1,
          ),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.costUsd).toBe(14);
    expect(merged.staleEnvironments).toEqual([]);
  });

  it("derives provider shares and cost quality", () => {
    const merged = mergeUsage(
      [
        environment(
          "env-a",
          summary(
            [
              bucket({ costUsd: 75 }),
              bucket({ provider: "codex", model: "gpt-5.6-sol", costUsd: 25, unpricedRecords: 5 }),
            ],
            [
              { provider: "claude", hostId: "mac", homePath: "/a/.claude" },
              { provider: "codex", hostId: "mac", homePath: "/a/.codex" },
            ],
          ),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.providers[0]?.provider).toBe("claude");
    expect(merged.providers[0]?.costShare).toBeCloseTo(0.75, 5);
    expect(merged.costQuality.unpricedShare).toBeCloseTo(0.5, 5);
    expect(merged.costQuality.cacheSavingsUsd).toBe(4);
  });

  it("keeps two machines apart when hostname and home path collide", () => {
    // Every Mac resolves /Users/theo/.claude, so a hostname clash used to make
    // one machine's usage vanish. Filesystem identity separates them.
    const shape = { provider: "claude" as const, hostId: "mac", homePath: "/Users/theo/.claude" };
    const merged = mergeUsage(
      [
        environment("env-a", summary([bucket()], [{ ...shape, volumeId: "16777220:1234" }])),
        environment("env-b", summary([bucket()], [{ ...shape, volumeId: "16777221:9999" }])),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.costUsd).toBe(20);
    expect(merged.duplicateSources).toHaveLength(0);
  });

  it("still collapses two servers reading the same directory", () => {
    const same = {
      provider: "claude" as const,
      hostId: "mac",
      homePath: "/Users/theo/.claude",
      volumeId: "16777220:1234",
    };
    const merged = mergeUsage(
      [
        environment("env-a", summary([bucket()], [same])),
        environment("env-b", summary([bucket()], [same])),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.costUsd).toBe(10);
    expect(merged.duplicateSources).toHaveLength(1);
  });

  it("totals sessions from per-directory distinct counts, not per-bucket sums", () => {
    // One session that spans two days appears in two buckets. Summing bucket
    // sessions would say 2; the source's distinct count says 1.
    const merged = mergeUsage(
      [
        environment(
          "env-a",
          summary(
            [bucket({ day: "2026-08-06" as UsageDay }), bucket({ day: "2026-08-07" as UsageDay })],
            [
              {
                provider: "claude",
                hostId: "mac",
                homePath: "/a/.claude",
                distinctSessions: 1,
              },
            ],
          ),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.sessions).toBe(1);
    expect(merged.providers[0]?.sessions).toBe(1);
  });

  it("returns empty totals with no environments", () => {
    const merged = mergeUsage([], USAGE_CONTRACT_VERSION);
    expect(merged.costUsd).toBe(0);
    expect(merged.daily).toHaveLength(0);
    expect(merged.hourly).toHaveLength(0);
  });

  it("omits providers with no sessions or usage", () => {
    const merged = mergeUsage(
      [
        environment(
          "env-a",
          summary(
            [],
            [
              {
                provider: "claude",
                hostId: "mac",
                homePath: "/a/.claude",
                distinctSessions: 0,
              },
            ],
          ),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.providers).toEqual([]);
  });

  it("derives hourly totals without losing the daily rollup", () => {
    const merged = mergeUsage(
      [
        environment(
          "env-a",
          summary(
            [
              bucket({ hourStart: "2026-08-07T09:37:00.000Z", costUsd: 3 }),
              bucket({ hourStart: "2026-08-07T10:37:00.000Z", costUsd: 7 }),
            ],
            [{ provider: "claude", hostId: "mac", homePath: "/a/.claude" }],
          ),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.hourly.map((hour) => [hour.hourStart, hour.costUsd])).toEqual([
      ["2026-08-07T09:37:00.000Z", 3],
      ["2026-08-07T10:37:00.000Z", 7],
    ]);
    expect(merged.daily).toHaveLength(1);
    expect(merged.daily[0]?.costUsd).toBe(10);
  });

  it("keeps the final half-hour-aligned bucket at an exact cutoff", () => {
    const base = summary(
      [
        bucket({ hourStart: "2026-08-07T23:30:00.000Z", costUsd: 3 }),
        bucket({ hourStart: "2026-08-08T00:30:00.000Z", costUsd: 7 }),
      ],
      [{ provider: "claude", hostId: "mac", homePath: "/a/.claude" }],
    );
    const merged = mergeUsage(
      [
        environment("env-a", {
          ...base,
          coverage: {
            ...base.coverage!,
            availableThroughDay: "2026-08-08" as UsageDay,
            availableThroughTime: "2026-08-08T00:30:00.000Z",
          },
        }),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.availableThroughTime).toBe("2026-08-08T00:30:00.000Z");
    expect(merged.hourly.map((hour) => hour.hourStart)).toEqual(["2026-08-07T23:30:00.000Z"]);
    expect(merged.costUsd).toBe(3);
  });
});
