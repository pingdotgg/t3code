import {
  USAGE_CONTRACT_VERSION,
  USAGE_MERGE_COMPATIBLE_SINCE,
  USAGE_PROJECT_ATTRIBUTION_SINCE,
  ProjectId,
  type EnvironmentId,
  type UsageBucket,
  type UsageDay,
  type UsageProviderKind,
  type UsageSummary,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { mergeUsage, projectFilterForEnvironment, type EnvironmentUsage } from "./usageMerge.ts";

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
    projectAttribution: "outside",
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
    expect(merged.providerContributions).toEqual([
      { environmentId: "env-a", contractVersion: USAGE_CONTRACT_VERSION, providers: ["claude"] },
      { environmentId: "env-b", contractVersion: USAGE_CONTRACT_VERSION, providers: ["claude"] },
    ]);
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
    expect(merged.providerContributions).toEqual([
      { environmentId: "env-a", contractVersion: USAGE_CONTRACT_VERSION, providers: ["claude"] },
    ]);
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
    expect(merged.providerContributions).toEqual([
      { environmentId: "env-a", contractVersion: USAGE_CONTRACT_VERSION, providers: ["claude"] },
      { environmentId: "env-b", contractVersion: USAGE_CONTRACT_VERSION, providers: ["codex"] },
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
            USAGE_MERGE_COMPATIBLE_SINCE - 1,
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

  it("rolls buckets up by project, with explicit outside buckets under null", () => {
    const merged = mergeUsage(
      [
        environment(
          "env-a",
          summary(
            [
              bucket({ project: "App", costUsd: 6 }),
              bucket({ project: "App", costUsd: 2, model: "claude-opus-5" }),
              bucket({ costUsd: 2 }),
            ],
            [{ provider: "claude", hostId: "mac", homePath: "/a/.claude" }],
          ),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.projects.map((project) => [project.project, project.costUsd])).toEqual([
      ["App", 8],
      [null, 2],
    ]);
    expect(merged.projects[0]?.costShare).toBeCloseTo(0.8, 9);
  });

  it("keeps projects with the same title distinct and filters by stable id", () => {
    const firstId = ProjectId.make("project-first");
    const secondId = ProjectId.make("project-second");
    const environments = [
      environment(
        "env-a",
        summary(
          [
            bucket({ projectId: firstId, project: "App", costUsd: 6 }),
            bucket({ projectId: secondId, project: "App", costUsd: 2 }),
          ],
          [{ provider: "claude", hostId: "mac", homePath: "/a/.claude" }],
        ),
      ),
    ];

    const merged = mergeUsage(environments, USAGE_CONTRACT_VERSION);
    expect(
      merged.projects.map((project) => [project.projectId, project.project, project.costUsd]),
    ).toEqual([
      [firstId, "App", 6],
      [secondId, "App", 2],
    ]);

    const secondKey = merged.projects.find((project) => project.projectId === secondId)?.projectKey;
    if (secondKey === undefined) throw new Error("second project key missing");
    const filtered = mergeUsage(environments, USAGE_CONTRACT_VERSION, { projectFilter: secondKey });
    expect(filtered.costUsd).toBe(2);
  });

  it("reconciles aggregate, provider, project, and filtered project totals", () => {
    const environments = [
      environment(
        "env-a",
        summary(
          [
            bucket({ project: "App", costUsd: 6 }),
            bucket({
              project: "App",
              provider: "codex",
              model: "gpt-5.6-sol",
              costUsd: 3,
              totals: {
                uncachedInputTokens: 20,
                cachedInputTokens: 200,
                cacheCreationTokens: 0,
                outputTokens: 10,
                reasoningTokens: 5,
              },
            }),
            bucket({ costUsd: 2 }),
          ],
          [
            { provider: "claude", hostId: "mac", homePath: "/a/.claude" },
            { provider: "codex", hostId: "mac", homePath: "/a/.codex" },
          ],
        ),
      ),
    ];
    const merged = mergeUsage(environments, USAGE_CONTRACT_VERSION);

    expect(merged.providers.reduce((sum, provider) => sum + provider.costUsd, 0)).toBe(
      merged.costUsd,
    );
    expect(merged.providers.reduce((sum, provider) => sum + provider.totalTokens, 0)).toBe(
      merged.totalTokens,
    );
    expect(merged.projects.reduce((sum, project) => sum + project.costUsd, 0)).toBe(merged.costUsd);
    expect(merged.projects.reduce((sum, project) => sum + project.totalTokens, 0)).toBe(
      merged.totalTokens,
    );

    for (const project of merged.projects) {
      const filtered = mergeUsage(environments, USAGE_CONTRACT_VERSION, {
        projectFilter: project.projectKey,
      });
      expect(filtered.costUsd).toBe(project.costUsd);
      expect(filtered.totalTokens).toBe(project.totalTokens);
    }
  });

  it("marks cache-write cost unavailable when a cache-creating bucket omits it", () => {
    const merged = mergeUsage(
      [
        environment(
          "env-a",
          summary(
            [
              bucket({ cacheWriteUsd: 3 }),
              bucket({ cacheWriteUsd: 1, model: "claude-opus-5" }),
              // A summary written before the field existed makes the estimate incomplete.
              bucket({ model: "claude-opus-5" }),
            ],
            [{ provider: "claude", hostId: "mac", homePath: "/a/.claude" }],
          ),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.costQuality.cacheWriteUsd).toBeNull();
    const opus = merged.models.find((model) => model.model === "claude-opus-5");
    expect(opus?.cacheWriteUsd).toBeNull();
  });

  it("sums cache-write cost when every cache-creating bucket reports it", () => {
    const merged = mergeUsage(
      [
        environment(
          "env-a",
          summary(
            [bucket({ cacheWriteUsd: 3 }), bucket({ cacheWriteUsd: 1, model: "claude-opus-5" })],
            [{ provider: "claude", hostId: "mac", homePath: "/a/.claude" }],
          ),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.costQuality.cacheWriteUsd).toBe(4);
    const opus = merged.models.find((model) => model.model === "claude-opus-5");
    expect(opus?.cacheWriteUsd).toBe(1);
  });

  it("filters every figure except the project list when a project is selected", () => {
    const environments = [
      environment(
        "env-a",
        summary(
          [
            bucket({ project: "App", costUsd: 6 }),
            bucket({ costUsd: 2, provider: "codex", model: "gpt-5.6-sol" }),
          ],
          [
            { provider: "claude", hostId: "mac", homePath: "/a/.claude" },
            { provider: "codex", hostId: "mac", homePath: "/a/.codex" },
          ],
        ),
      ),
    ];

    const unfiltered = mergeUsage(environments, USAGE_CONTRACT_VERSION);
    const appKey = unfiltered.projects.find((project) => project.project === "App")?.projectKey;
    if (appKey === undefined || appKey === null) throw new Error("app project key missing");
    const filtered = mergeUsage(environments, USAGE_CONTRACT_VERSION, { projectFilter: appKey });
    expect(filtered.costUsd).toBe(6);
    expect(filtered.providers.map((provider) => provider.provider)).toEqual(["claude"]);
    // Session counts are per source directory and cannot be split by project.
    expect(filtered.sessions).toBe(0);
    // The picker keeps its full option list while the filter narrows the rest.
    expect(filtered.projects.map((project) => project.project)).toEqual(["App", null]);

    const outside = mergeUsage(environments, USAGE_CONTRACT_VERSION, { projectFilter: null });
    expect(outside.costUsd).toBe(2);
    expect(outside.providers.map((provider) => provider.provider)).toEqual(["codex"]);
  });

  it("filters environments before claiming a selected project's shared source", () => {
    const sharedSource = [{ provider: "claude" as const, hostId: "mac", homePath: "/shared" }];
    const environments = [
      environment(
        "env-a",
        summary(
          [bucket({ projectId: ProjectId.make("project-a"), project: "A", costUsd: 9 })],
          sharedSource,
        ),
      ),
      environment(
        "env-b",
        summary(
          [bucket({ projectId: ProjectId.make("project-b"), project: "B", costUsd: 4 })],
          sharedSource,
        ),
      ),
    ];
    const projectKey = JSON.stringify(["env-b", "id:project-b"]);

    const filtered = mergeUsage(environments, USAGE_CONTRACT_VERSION, {
      projectFilter: projectKey,
    });

    expect(filtered.costUsd).toBe(4);
    expect(filtered.contributingEnvironments).toEqual(["env-b"]);
    expect(filtered.providerContributions.map((entry) => entry.environmentId)).toEqual(["env-b"]);
  });

  it("namespaces stable project ids by environment", () => {
    const sharedId = ProjectId.make("cloned-project");
    const environments = [
      environment(
        "env-a",
        summary(
          [bucket({ projectId: sharedId, project: "App", costUsd: 6 })],
          [{ provider: "claude", hostId: "mac", homePath: "/a/.claude" }],
        ),
      ),
      environment(
        "env-b",
        summary(
          [bucket({ projectId: sharedId, project: "App", costUsd: 2 })],
          [{ provider: "claude", hostId: "linux", homePath: "/b/.claude" }],
        ),
      ),
    ];

    const merged = mergeUsage(environments, USAGE_CONTRACT_VERSION);
    expect(merged.projects.map((project) => project.costUsd)).toEqual([6, 2]);
    const firstKey = merged.projects[0]?.projectKey;
    if (firstKey === undefined || firstKey === null) throw new Error("project key missing");
    expect(projectFilterForEnvironment(firstKey, "env-a" as EnvironmentId)).toBe(`id:${sharedId}`);
    expect(projectFilterForEnvironment(firstKey, "env-b" as EnvironmentId)).toBe(
      "environment-mismatch:",
    );
  });

  it("does not treat unknown attribution from old summaries as outside projects", () => {
    const oldEnvironment = environment(
      "env-old",
      summary(
        [bucket({ costUsd: 4, projectAttribution: undefined })],
        [{ provider: "claude", hostId: "mac", homePath: "/old/.claude" }],
        USAGE_PROJECT_ATTRIBUTION_SINCE - 1,
      ),
    );

    const unfiltered = mergeUsage([oldEnvironment], USAGE_CONTRACT_VERSION);
    expect(unfiltered.costUsd).toBe(4);
    expect(unfiltered.projects).toEqual([]);

    const outside = mergeUsage([oldEnvironment], USAGE_CONTRACT_VERSION, {
      projectFilter: null,
    });
    expect(outside.costUsd).toBe(0);
  });

  it("does not treat current unknown attribution as outside projects", () => {
    const currentEnvironment = environment(
      "env-current",
      summary(
        [
          bucket({
            provider: "grok",
            model: "grok-code-fast-1",
            costUsd: 4,
            projectAttribution: "unknown",
          }),
        ],
        [{ provider: "grok", hostId: "mac", homePath: "/unknown" }],
      ),
    );

    const unfiltered = mergeUsage([currentEnvironment], USAGE_CONTRACT_VERSION);
    expect(unfiltered.costUsd).toBe(4);
    expect(unfiltered.projects).toEqual([]);

    const outside = mergeUsage([currentEnvironment], USAGE_CONTRACT_VERSION, {
      projectFilter: null,
    });
    expect(outside.costUsd).toBe(0);
  });
});
