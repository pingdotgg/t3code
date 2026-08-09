import {
  USAGE_CONTRACT_VERSION,
  type EnvironmentId,
  type UsageBucket,
  type UsageDay,
  type UsageProviderKind,
  type UsageSummary,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  deriveUsageDisplay,
  mergeUsage,
  type EnvironmentUsage,
  type EnvironmentUsageStatus,
} from "./usageMerge.ts";

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
            USAGE_CONTRACT_VERSION - 1,
          ),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.costUsd).toBe(10);
    expect(merged.staleEnvironments).toEqual(["env-b"]);
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
  });

  it("returns empty totals with no environments", () => {
    const merged = mergeUsage([], USAGE_CONTRACT_VERSION);
    expect(merged.costUsd).toBe(0);
    expect(merged.daily).toHaveLength(0);
  });
});

describe("deriveUsageDisplay", () => {
  it("keeps the existing merged and deduplicated totals for All devices", () => {
    const sharedSource = {
      provider: "claude" as const,
      hostId: "mac",
      homePath: "/Users/theo/.claude",
    };
    const answered = [
      environment("env-a", summary([bucket()], [sharedSource])),
      environment("env-b", summary([bucket()], [sharedSource])),
    ];
    const environments: EnvironmentUsageStatus[] = answered.map((environmentUsage) => ({
      ...environmentUsage,
      isConnected: true,
      isPending: false,
      error: null,
    }));

    const display = deriveUsageDisplay(environments, null, USAGE_CONTRACT_VERSION);
    const existingAggregate = mergeUsage(answered, USAGE_CONTRACT_VERSION);

    expect(display.selectedEnvironmentId).toBeNull();
    expect(display.merged).toEqual(existingAggregate);
    expect(display.merged.costUsd).toBe(10);
    expect(display.merged.duplicateSources).toHaveLength(1);
  });

  it("filters totals, models, days, and providers to one selected device", () => {
    const environments: EnvironmentUsageStatus[] = [
      {
        ...environment(
          "env-a",
          summary(
            [bucket({ day: "2026-08-06" as UsageDay })],
            [{ provider: "claude", hostId: "mac-a", homePath: "/a/.claude" }],
          ),
        ),
        isConnected: true,
        isPending: false,
        error: null,
      },
      {
        ...environment(
          "env-b",
          summary(
            [
              bucket({
                day: "2026-08-07" as UsageDay,
                provider: "codex",
                model: "gpt-5.6-sol",
                costUsd: 4,
              }),
            ],
            [{ provider: "codex", hostId: "mac-b", homePath: "/b/.codex" }],
          ),
        ),
        isConnected: true,
        isPending: false,
        error: null,
      },
    ];

    const display = deriveUsageDisplay(
      environments,
      "env-b" as EnvironmentId,
      USAGE_CONTRACT_VERSION,
    );

    expect(display.selectedEnvironmentId).toBe("env-b");
    expect(display.merged.costUsd).toBe(4);
    expect(display.merged.models.map((model) => model.model)).toEqual(["gpt-5.6-sol"]);
    expect(display.merged.daily.map((day) => day.day)).toEqual(["2026-08-07"]);
    expect(display.merged.providers.map((provider) => provider.provider)).toEqual(["codex"]);
  });

  it("falls back to All devices and offers only successful current summaries", () => {
    const current = summary(
      [bucket()],
      [{ provider: "claude", hostId: "mac", homePath: "/current/.claude" }],
    );
    const environments: EnvironmentUsageStatus[] = [
      {
        ...environment("env-current", current),
        isConnected: true,
        isPending: false,
        error: null,
      },
      {
        ...environment(
          "env-failed",
          summary(
            [bucket()],
            [{ provider: "claude", hostId: "linux", homePath: "/failed/.claude" }],
          ),
        ),
        isConnected: true,
        isPending: false,
        error: "This environment could not report usage.",
      },
      {
        ...environment(
          "env-old-server",
          summary(
            [bucket()],
            [{ provider: "claude", hostId: "old", homePath: "/old/.claude" }],
            USAGE_CONTRACT_VERSION - 1,
          ),
        ),
        isConnected: true,
        isPending: false,
        error: null,
      },
      {
        environmentId: "env-pending" as EnvironmentId,
        label: "env-pending",
        isConnected: true,
        isPending: true,
        error: null,
        summary: null,
      },
      {
        ...environment(
          "env-refreshing",
          summary(
            [bucket()],
            [{ provider: "claude", hostId: "refreshing", homePath: "/refreshing/.claude" }],
          ),
        ),
        isConnected: true,
        isPending: true,
        error: null,
      },
      {
        ...environment(
          "env-disconnected",
          summary(
            [bucket()],
            [{ provider: "claude", hostId: "offline", homePath: "/offline/.claude" }],
          ),
        ),
        isConnected: false,
        isPending: false,
        error: null,
      },
    ];

    const display = deriveUsageDisplay(
      environments,
      "env-failed" as EnvironmentId,
      USAGE_CONTRACT_VERSION,
    );

    expect(display.selectedEnvironmentId).toBeNull();
    expect(display.shouldResetRequestedEnvironment).toBe(true);
    expect(display.deviceOptions).toEqual([{ environmentId: "env-current", label: "env-current" }]);
    expect(display.merged.costUsd).toBe(40);

    const refreshingSelection = deriveUsageDisplay(
      environments,
      "env-refreshing" as EnvironmentId,
      USAGE_CONTRACT_VERSION,
    );
    expect(refreshingSelection.selectedEnvironmentId).toBeNull();

    const disconnectedSelection = deriveUsageDisplay(
      environments,
      "env-disconnected" as EnvironmentId,
      USAGE_CONTRACT_VERSION,
    );
    expect(disconnectedSelection.selectedEnvironmentId).toBeNull();
  });

  it("keeps the global wait-for-all loading state when one device is selected", () => {
    const environments: EnvironmentUsageStatus[] = [
      {
        ...environment(
          "env-ready",
          summary(
            [bucket()],
            [{ provider: "claude", hostId: "ready", homePath: "/ready/.claude" }],
          ),
        ),
        isConnected: true,
        isPending: false,
        error: null,
      },
      {
        environmentId: "env-scanning" as EnvironmentId,
        label: "env-scanning",
        isConnected: true,
        isPending: true,
        error: null,
        summary: null,
      },
    ];

    const display = deriveUsageDisplay(
      environments,
      "env-ready" as EnvironmentId,
      USAGE_CONTRACT_VERSION,
    );

    expect(display.isPending).toBe(false);
    expect(display.isPartial).toBe(true);
  });

  it("preserves a requested device scope while that device refreshes", () => {
    const ready: EnvironmentUsageStatus = {
      ...environment(
        "env-selected",
        summary(
          [bucket()],
          [{ provider: "claude", hostId: "selected", homePath: "/selected/.claude" }],
        ),
      ),
      isConnected: true,
      isPending: false,
      error: null,
    };
    const requestedEnvironmentId = "env-selected" as EnvironmentId;

    const refreshing = deriveUsageDisplay(
      [{ ...ready, isPending: true }],
      requestedEnvironmentId,
      USAGE_CONTRACT_VERSION,
    );

    expect(refreshing.selectedEnvironmentId).toBeNull();
    expect(refreshing.shouldResetRequestedEnvironment).toBe(false);
    expect(
      deriveUsageDisplay([ready], requestedEnvironmentId, USAGE_CONTRACT_VERSION)
        .selectedEnvironmentId,
    ).toBe(requestedEnvironmentId);
  });
});
