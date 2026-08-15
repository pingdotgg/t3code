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
  isUsageContractMergeCompatible,
  mergeUsage,
  resolveExpectedUsageContractVersion,
  USAGE_MERGE_COMPATIBLE_SINCE,
  type EnvironmentUsage,
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

  it("reports duplicate sources only for the focused provider", () => {
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
      { provider: "codex" },
    );

    expect(merged.costUsd).toBe(4);
    expect(merged.duplicateSources).toEqual([]);
  });

  it("includes older compatible contract versions when merging all environments", () => {
    // Nightly remotes often ship v3 (Claude+Codex) while a local client is on
    // v5 (Grok+OpenCode). All-environments must sum the overlapping fields.
    const merged = mergeUsage(
      [
        environment(
          "env-a",
          summary(
            [bucket({ costUsd: 10 }), bucket({ provider: "grok", model: "grok-4.5", costUsd: 3 })],
            [
              { provider: "claude", hostId: "mac", homePath: "/a/.claude" },
              { provider: "grok", hostId: "mac", homePath: "/a/.grok" },
            ],
          ),
        ),
        environment(
          "env-b",
          summary(
            [bucket({ costUsd: 7 })],
            [{ provider: "claude", hostId: "linux", homePath: "/b/.claude" }],
            USAGE_MERGE_COMPATIBLE_SINCE,
          ),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.costUsd).toBe(20);
    expect(merged.staleEnvironments).toEqual([]);
    expect([...merged.contributingEnvironments].sort()).toEqual(["env-a", "env-b"]);
    expect(merged.providers.map((provider) => provider.provider).sort()).toEqual([
      "claude",
      "grok",
    ]);
  });

  it("still excludes versions below the compatible floor", () => {
    const merged = mergeUsage(
      [
        environment(
          "env-a",
          summary([bucket()], [{ provider: "claude", hostId: "mac", homePath: "/a" }]),
        ),
        environment(
          "env-b",
          summary(
            [bucket({ costUsd: 7 })],
            [{ provider: "claude", hostId: "linux", homePath: "/b" }],
            USAGE_MERGE_COMPATIBLE_SINCE - 1,
          ),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.costUsd).toBe(10);
    expect(merged.staleEnvironments).toEqual(["env-b"]);
  });

  it("still excludes newer-than-client versions from All", () => {
    const merged = mergeUsage(
      [
        environment(
          "env-a",
          summary([bucket()], [{ provider: "claude", hostId: "mac", homePath: "/a" }]),
        ),
        environment(
          "env-b",
          summary(
            [bucket({ costUsd: 7 })],
            [{ provider: "claude", hostId: "linux", homePath: "/b" }],
            USAGE_CONTRACT_VERSION + 1,
          ),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.costUsd).toBe(10);
    expect(merged.staleEnvironments).toEqual(["env-b"]);
  });

  it("keeps an isolated older environment when the expected version matches it", () => {
    // Single-env view passes the remote's own contract version so a nightly
    // server still shows Claude/Codex usage against a newer local client.
    const older = environment(
      "env-b",
      summary(
        [bucket({ costUsd: 7 })],
        [{ provider: "claude", hostId: "linux", homePath: "/b" }],
        USAGE_CONTRACT_VERSION - 2,
      ),
    );
    const expected = resolveExpectedUsageContractVersion({
      environmentFilter: "env-b",
      answered: [older],
      clientContractVersion: USAGE_CONTRACT_VERSION,
    });
    const merged = mergeUsage([older], expected);

    expect(expected).toBe(USAGE_CONTRACT_VERSION - 2);
    expect(merged.costUsd).toBe(7);
    expect(merged.staleEnvironments).toEqual([]);
    expect(merged.contributingEnvironments).toEqual(["env-b"]);
  });

  it("uses the client contract version as the All-environments ceiling", () => {
    const older = environment(
      "env-b",
      summary(
        [bucket({ costUsd: 7 })],
        [{ provider: "claude", hostId: "linux", homePath: "/b" }],
        USAGE_MERGE_COMPATIBLE_SINCE,
      ),
    );
    expect(
      resolveExpectedUsageContractVersion({
        environmentFilter: "all",
        answered: [older],
        clientContractVersion: USAGE_CONTRACT_VERSION,
      }),
    ).toBe(USAGE_CONTRACT_VERSION);
    expect(
      isUsageContractMergeCompatible(USAGE_MERGE_COMPATIBLE_SINCE, USAGE_CONTRACT_VERSION),
    ).toBe(true);
  });

  it("narrows the merge to one provider when focused", () => {
    const merged = mergeUsage(
      [
        environment(
          "env-a",
          summary(
            [
              bucket({ costUsd: 10 }),
              bucket({ provider: "codex", model: "gpt-5.6-sol", costUsd: 4 }),
            ],
            [
              { provider: "claude", hostId: "mac", homePath: "/a/.claude" },
              { provider: "codex", hostId: "mac", homePath: "/a/.codex" },
            ],
          ),
        ),
      ],
      USAGE_CONTRACT_VERSION,
      { provider: "codex" },
    );

    expect(merged.costUsd).toBe(4);
    expect(merged.providers.map((provider) => provider.provider)).toEqual(["codex"]);
    expect(merged.models).toHaveLength(1);
    expect(merged.models[0]?.model).toBe("gpt-5.6-sol");
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
    expect(merged.hourly).toHaveLength(0);
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

  it("isolates one environment when the client filters before merge", () => {
    // The usage page keeps the All-environments merge by default and narrows
    // to a single environment by passing only that summary into mergeUsage.
    const merged = mergeUsage(
      [
        environment(
          "env-b",
          summary(
            [bucket({ provider: "codex", model: "gpt-5.6-sol", costUsd: 4 })],
            [{ provider: "codex", hostId: "linux", homePath: "/b/.codex" }],
          ),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.costUsd).toBe(4);
    expect(merged.contributingEnvironments).toEqual(["env-b"]);
    expect(merged.providers.map((provider) => provider.provider)).toEqual(["codex"]);
  });

  it("keeps grok buckets in the merge", () => {
    const merged = mergeUsage(
      [
        environment(
          "env-a",
          summary(
            [bucket({ provider: "grok", model: "grok-4.5", costUsd: 3 })],
            [{ provider: "grok", hostId: "mac", homePath: "/a/.grok/sessions" }],
          ),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.costUsd).toBe(3);
    expect(merged.providers[0]?.provider).toBe("grok");
  });

  it("keeps opencode buckets in the merge", () => {
    const merged = mergeUsage(
      [
        environment(
          "env-a",
          summary(
            [bucket({ provider: "opencode", model: "gpt-5.4", costUsd: 2 })],
            [{ provider: "opencode", hostId: "mac", homePath: "/a/.local/share/opencode" }],
          ),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.costUsd).toBe(2);
    expect(merged.providers[0]?.provider).toBe("opencode");
  });
});
