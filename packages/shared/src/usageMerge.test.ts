import {
  USAGE_CONTRACT_VERSION,
  type EnvironmentId,
  type UsageBucket,
  type UsageDay,
  type UsageProviderKind,
  type UsageSummary,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { isCursorCoverageGap, mergeUsage, type EnvironmentUsage } from "./usageMerge.ts";

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
    status?: "ok" | "missing" | "failed";
    message?: string | null;
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
      status: source.status ?? ("ok" as const),
      scannedFiles: 1,
      skippedFiles: 0,
      malformedRecords: 0,
      distinctSessions: source.distinctSessions ?? 1,
      message: source.message ?? null,
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

  it("dedupes Cursor export fingerprints across worktree environments", () => {
    const sharedCursor = {
      provider: "cursor" as const,
      hostId: "cursor-account",
      homePath: "cursor-export:user_abc",
      volumeId: "",
    };
    const merged = mergeUsage(
      [
        environment(
          "env-a",
          summary(
            [bucket({ provider: "cursor", model: "composer-2", costUsd: 3 })],
            [sharedCursor],
          ),
        ),
        environment(
          "env-b",
          summary(
            [bucket({ provider: "cursor", model: "composer-2", costUsd: 3 })],
            [sharedCursor],
          ),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.costUsd).toBe(3);
    expect(merged.providers.map((provider) => provider.provider)).toEqual(["cursor"]);
  });

  it("dedupes Cursor exports across different host machines", () => {
    const cursorAccount = {
      provider: "cursor" as const,
      hostId: "cursor-account",
      homePath: "cursor-export:user_abc",
      volumeId: "",
    };
    const merged = mergeUsage(
      [
        environment(
          "laptop",
          summary([bucket({ provider: "cursor", costUsd: 5 })], [cursorAccount]),
        ),
        environment(
          "desktop",
          summary([bucket({ provider: "cursor", costUsd: 5 })], [cursorAccount]),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.costUsd).toBe(5);
    expect(merged.duplicateSources).toHaveLength(1);
  });

  it("does not let a failed Cursor source block a successful sibling", () => {
    const cursorAccount = {
      provider: "cursor" as const,
      hostId: "cursor-account",
      homePath: "cursor-export:user_abc",
      volumeId: "",
    };
    const merged = mergeUsage(
      [
        environment(
          "env-a",
          summary([], [{ ...cursorAccount, status: "failed", message: "export failed" }]),
        ),
        environment(
          "env-b",
          summary(
            [bucket({ provider: "cursor", model: "composer-2", costUsd: 4 })],
            [cursorAccount],
          ),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.costUsd).toBe(4);
    expect(merged.providers.map((provider) => provider.provider)).toEqual(["cursor"]);
    expect(merged.duplicateSources).toHaveLength(0);
  });

  it("prefers a richer Cursor export over a stale empty sibling", () => {
    // env-a sorts first and reports ok from a stale cache with no in-window
    // rows; env-b fetched a fresher export for the same account.
    const cursorAccount = {
      provider: "cursor" as const,
      hostId: "cursor-account",
      homePath: "cursor-export:user_abc",
      volumeId: "",
    };
    const merged = mergeUsage(
      [
        environment(
          "env-a",
          summary([], [{ ...cursorAccount, distinctSessions: 0 }]),
        ),
        environment(
          "env-b",
          summary(
            [bucket({ provider: "cursor", model: "composer-2", costUsd: 7, records: 3 })],
            [{ ...cursorAccount, distinctSessions: 2 }],
          ),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.costUsd).toBe(7);
    expect(merged.contributingEnvironments).toEqual(["env-b"]);
    expect(merged.duplicateSources).toEqual(["env-a: cursor-export:user_abc"]);
  });

  it("keeps the first Cursor owner when sibling richness ties", () => {
    const cursorAccount = {
      provider: "cursor" as const,
      hostId: "cursor-account",
      homePath: "cursor-export:user_abc",
      volumeId: "",
    };
    const merged = mergeUsage(
      [
        environment(
          "env-a",
          summary(
            [bucket({ provider: "cursor", model: "composer-2", costUsd: 3, records: 2 })],
            [{ ...cursorAccount, distinctSessions: 1 }],
          ),
        ),
        environment(
          "env-b",
          summary(
            [bucket({ provider: "cursor", model: "composer-2", costUsd: 3, records: 2 })],
            [{ ...cursorAccount, distinctSessions: 1 }],
          ),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.costUsd).toBe(3);
    expect(merged.contributingEnvironments).toEqual(["env-a"]);
  });

  it("treats only Cursor missing/failed sources as coverage gaps", () => {
    expect(
      isCursorCoverageGap({
        fingerprint: {
          hostId: "mac",
          provider: "claude",
          resolvedHomePath: "/a/.claude",
          volumeId: "vol",
        },
        status: "missing",
      }),
    ).toBe(false);
    expect(
      isCursorCoverageGap({
        fingerprint: {
          hostId: "cursor-account",
          provider: "cursor",
          resolvedHomePath: "cursor-export:user_abc",
          volumeId: "",
        },
        status: "missing",
      }),
    ).toBe(true);
    expect(
      isCursorCoverageGap({
        fingerprint: {
          hostId: "cursor-account",
          provider: "cursor",
          resolvedHomePath: "cursor-export:user_abc",
          volumeId: "",
        },
        status: "ok",
      }),
    ).toBe(false);
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
});
