import {
  USAGE_CONTRACT_VERSION,
  UsageSummary,
  type EnvironmentId,
  type UsageBucket,
  type UsageDay,
  type UsageProviderKind,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { mergeUsage, seriesKey, type EnvironmentUsage } from "./usageMerge";

const decodeUsageSummary = Schema.decodeUnknownSync(UsageSummary);

function bucket(overrides: Partial<UsageBucket> = {}): UsageBucket {
  return {
    day: "2026-08-07" as UsageDay,
    provider: "claude",
    homePath: "/home/theo/.claude",
    homeLabel: null,
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
    label?: string | null;
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
      label: source.label ?? null,
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
          summary(
            [bucket({ homePath: "/a/.claude" })],
            [{ provider: "claude", hostId: "mac", homePath: "/a/.claude" }],
          ),
        ),
        environment(
          "env-b",
          summary(
            [bucket({ homePath: "/b/.claude" })],
            [{ provider: "claude", hostId: "linux", homePath: "/b/.claude" }],
          ),
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
            [
              bucket(),
              bucket({
                provider: "codex",
                homePath: "/home/theo/.codex",
                model: "gpt-5.6-sol",
                costUsd: 4,
              }),
            ],
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

  it("drops only the duplicated home, keeping the same provider's other home", () => {
    // Both environments scan the shared work home; only env-b sees personal.
    // Ownership is per directory, so env-b still contributes personal even
    // though its work directory lost the claim.
    const work = {
      provider: "codex" as const,
      hostId: "mac",
      homePath: "/home/theo/.codex-t3/work/sessions",
      label: "Work",
    };
    const personal = {
      provider: "codex" as const,
      hostId: "mac",
      homePath: "/home/theo/.codex-t3/personal/sessions",
      label: "Personal",
    };
    const workBucket = bucket({
      provider: "codex",
      homePath: work.homePath,
      homeLabel: "Work",
      model: "gpt-5.6-sol",
    });
    const merged = mergeUsage(
      [
        environment("env-a", summary([workBucket], [work])),
        environment(
          "env-b",
          summary(
            [
              workBucket,
              bucket({
                provider: "codex",
                homePath: personal.homePath,
                homeLabel: "Personal",
                model: "gpt-5.6-sol",
                costUsd: 3,
              }),
            ],
            [work, personal],
          ),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.costUsd).toBe(13);
    expect(merged.duplicateSources).toHaveLength(1);
    expect(merged.providers.map((provider) => provider.homeLabel).sort()).toEqual([
      "Personal",
      "Work",
    ]);
  });

  it("splits one provider into series per home label", () => {
    const merged = mergeUsage(
      [
        environment(
          "env-a",
          summary(
            [
              bucket({
                provider: "codex",
                homePath: "/a/work/sessions",
                homeLabel: "Work",
                model: "gpt-5.6-sol",
                costUsd: 8,
              }),
              bucket({
                provider: "codex",
                homePath: "/a/personal/sessions",
                homeLabel: "Personal",
                model: "gpt-5.6-sol",
                costUsd: 2,
              }),
            ],
            [
              { provider: "codex", hostId: "mac", homePath: "/a/work/sessions", label: "Work" },
              {
                provider: "codex",
                hostId: "mac",
                homePath: "/a/personal/sessions",
                label: "Personal",
              },
            ],
          ),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.providers).toHaveLength(2);
    expect(merged.providers[0]?.homeLabel).toBe("Work");
    expect(merged.providers[0]?.costShare).toBeCloseTo(0.8, 5);
    expect(merged.providers[1]?.homeLabel).toBe("Personal");
    expect(merged.daily[0]?.bySeries.get(seriesKey("codex", "Work"))?.costUsd).toBe(8);
    expect(merged.daily[0]?.bySeries.get(seriesKey("codex", "Personal"))?.costUsd).toBe(2);
  });

  it("excludes an environment reporting an older contract version", () => {
    const merged = mergeUsage(
      [
        environment(
          "env-a",
          summary(
            [bucket({ homePath: "/a" })],
            [{ provider: "claude", hostId: "mac", homePath: "/a" }],
          ),
        ),
        environment(
          "env-b",
          summary(
            [bucket({ homePath: "/b" })],
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
              bucket({ homePath: "/a/.claude", costUsd: 75 }),
              bucket({
                provider: "codex",
                homePath: "/a/.codex",
                model: "gpt-5.6-sol",
                costUsd: 25,
                unpricedRecords: 5,
              }),
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
        environment(
          "env-a",
          summary(
            [bucket({ homePath: shape.homePath })],
            [{ ...shape, volumeId: "16777220:1234" }],
          ),
        ),
        environment(
          "env-b",
          summary(
            [bucket({ homePath: shape.homePath })],
            [{ ...shape, volumeId: "16777221:9999" }],
          ),
        ),
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
        environment("env-a", summary([bucket({ homePath: same.homePath })], [same])),
        environment("env-b", summary([bucket({ homePath: same.homePath })], [same])),
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
            [
              bucket({ day: "2026-08-06" as UsageDay, homePath: "/a/.claude" }),
              bucket({ day: "2026-08-07" as UsageDay, homePath: "/a/.claude" }),
            ],
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

  it("decodes a pre-v4 summary so the version check can exclude it as stale", () => {
    // UsageSummary is the RPC success schema: if the home fields were
    // required, an older environment's response would fail as an RPC error
    // before the contract-version check ever ran.
    const v3 = summary(
      [bucket({ homePath: "/a" })],
      [{ provider: "claude", hostId: "mac", homePath: "/a" }],
      USAGE_CONTRACT_VERSION - 1,
    );
    const stripped = {
      ...v3,
      buckets: v3.buckets.map(({ homePath: _path, homeLabel: _label, ...rest }) => rest),
      sources: v3.sources.map(({ label: _sourceLabel, ...rest }) => rest),
    };

    const decoded = decodeUsageSummary(stripped);
    expect(decoded.buckets[0]?.homePath).toBe("");
    expect(decoded.buckets[0]?.homeLabel).toBeNull();
    expect(decoded.sources[0]?.label).toBeNull();

    const merged = mergeUsage([environment("env-old", decoded)], USAGE_CONTRACT_VERSION);
    expect(merged.costUsd).toBe(0);
    expect(merged.staleEnvironments).toEqual(["env-old"]);
  });
});
