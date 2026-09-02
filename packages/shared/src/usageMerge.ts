/**
 * Merges per-environment usage summaries into the single view the page renders.
 *
 * Pure, so the de-duplication and derivation rules can be tested without a
 * connected environment.
 *
 * @module usageMerge
 */
import {
  USAGE_MERGE_COMPATIBLE_SINCE,
  type EnvironmentId,
  type ProjectId,
  type UsageBucket,
  type UsageProviderKind,
  type UsageSourceFingerprint,
  type UsageSummary,
} from "@t3tools/contracts";

export interface EnvironmentUsage {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly summary: UsageSummary;
}

export interface ProviderTotals {
  readonly provider: UsageProviderKind;
  readonly costUsd: number;
  readonly totalTokens: number;
  readonly records: number;
  readonly sessions: number;
  readonly costShare: number;
  readonly tokenShare: number;
}

export interface ModelTotals {
  readonly model: string;
  readonly provider: UsageProviderKind;
  readonly costUsd: number;
  readonly totalTokens: number;
  readonly cacheWriteTokens: number;
  readonly cacheWriteUsd: number | null;
  readonly records: number;
  readonly costShare: number;
}

/** One project's slice of the window. `project` is null for buckets that ran outside every project. */
export interface ProjectTotals {
  readonly projectId: ProjectId | null;
  /** Stable, namespaced value accepted by `MergeUsageOptions.projectFilter`. */
  readonly projectKey: string | null;
  readonly project: string | null;
  readonly costUsd: number;
  readonly totalTokens: number;
  readonly cacheWriteTokens: number;
  readonly cacheWriteUsd: number | null;
  readonly records: number;
  readonly costShare: number;
}

export interface DailyTotals {
  readonly day: string;
  readonly costUsd: number;
  readonly totalTokens: number;
  readonly byProvider: ReadonlyMap<UsageProviderKind, { costUsd: number; totalTokens: number }>;
}

export interface HourlyTotals {
  readonly day: string;
  readonly hourStart: string;
  readonly costUsd: number;
  readonly totalTokens: number;
  readonly byProvider: ReadonlyMap<UsageProviderKind, { costUsd: number; totalTokens: number }>;
}

export interface CostQuality {
  readonly providerReportedShare: number;
  readonly modelPricedShare: number;
  readonly unpricedShare: number;
  readonly cacheSavingsUsd: number;
  /** Estimated cost of reported cache-creation tokens at cache-write rates. */
  readonly cacheWriteUsd: number | null;
}

export interface EnvironmentProviderContribution {
  readonly environmentId: EnvironmentId;
  readonly contractVersion: number;
  readonly providers: readonly UsageProviderKind[];
}

export interface MergedUsage {
  readonly costUsd: number;
  readonly uncachedInputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheCreationTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly totalTokens: number;
  readonly records: number;
  readonly sessions: number;
  readonly providers: readonly ProviderTotals[];
  readonly models: readonly ModelTotals[];
  /**
   * Always computed from the unfiltered buckets, so a project picker keeps its
   * full option list while a filter is applied.
   */
  readonly projects: readonly ProjectTotals[];
  readonly daily: readonly DailyTotals[];
  readonly hourly: readonly HourlyTotals[];
  readonly costQuality: CostQuality;
  /** Environments whose data was dropped as a duplicate of another's. */
  readonly duplicateSources: readonly string[];
  readonly contributingEnvironments: readonly EnvironmentId[];
  /** Provider rows this environment owns after physical-source de-duplication. */
  readonly providerContributions: readonly EnvironmentProviderContribution[];
  readonly staleEnvironments: readonly EnvironmentId[];
}

/**
 * Two sources are the same physical transcript directory only when host,
 * provider, path and filesystem identity all agree.
 *
 * `volumeId` is what stops two machines that happen to share a hostname and a
 * home path, which is every Mac in a fleet, from collapsing into one source and
 * having one of them silently dropped.
 */
function fingerprintKey(fingerprint: UsageSourceFingerprint): string {
  return [
    fingerprint.hostId,
    fingerprint.provider,
    fingerprint.resolvedHomePath,
    fingerprint.volumeId,
  ].join(" ");
}

/**
 * Decides which environment owns each physical transcript directory.
 *
 * Several environments on one machine (worktree servers, for instance) resolve
 * the same provider home and would otherwise double count every token. The
 * first environment in a stable order claims a fingerprint; the rest have that
 * provider's buckets dropped. Environments are sorted by id so the winner does
 * not change between renders.
 */
function claimSources(environments: readonly EnvironmentUsage[]): {
  readonly ownerByFingerprint: ReadonlyMap<string, EnvironmentId>;
  readonly duplicates: readonly string[];
} {
  const ownerByFingerprint = new Map<string, EnvironmentId>();
  const duplicates: string[] = [];

  const ordered = [...environments].sort((a, b) => a.environmentId.localeCompare(b.environmentId));

  for (const environment of ordered) {
    for (const source of environment.summary.sources) {
      if (source.status === "missing") continue;
      const key = fingerprintKey(source.fingerprint);
      if (ownerByFingerprint.has(key)) {
        duplicates.push(`${environment.label}: ${source.fingerprint.resolvedHomePath}`);
        continue;
      }
      ownerByFingerprint.set(key, environment.environmentId);
    }
  }

  return { ownerByFingerprint, duplicates };
}

/** Sources this environment owns after fingerprint claims, plus their buckets. */
function ownedContribution(
  environment: EnvironmentUsage,
  ownerByFingerprint: ReadonlyMap<string, EnvironmentId>,
): {
  readonly buckets: readonly UsageBucket[];
  readonly sessionsByProvider: ReadonlyMap<UsageProviderKind, number>;
} {
  const ownedProviders = new Set<UsageProviderKind>();
  const sessionsByProvider = new Map<UsageProviderKind, number>();
  for (const source of environment.summary.sources) {
    if (source.status === "missing") continue;
    const key = fingerprintKey(source.fingerprint);
    if (ownerByFingerprint.get(key) === environment.environmentId) {
      const provider = source.fingerprint.provider;
      ownedProviders.add(provider);
      // Distinct within a directory. Summing per-bucket session counts instead
      // would count a session once per day and model it spans.
      sessionsByProvider.set(
        provider,
        (sessionsByProvider.get(provider) ?? 0) + source.distinctSessions,
      );
    }
  }
  return {
    buckets: environment.summary.buckets.filter((bucket) => ownedProviders.has(bucket.provider)),
    sessionsByProvider,
  };
}

function bucketTokens(bucket: UsageBucket): number {
  // reasoningTokens is a subset of outputTokens and must not be added again.
  return (
    bucket.totals.uncachedInputTokens +
    bucket.totals.cachedInputTokens +
    bucket.totals.cacheCreationTokens +
    bucket.totals.outputTokens
  );
}

function isCompatibleContractVersion(version: number, expected: number): boolean {
  return version >= USAGE_MERGE_COMPATIBLE_SINCE && version <= expected;
}

const EMPTY_MERGED: MergedUsage = {
  costUsd: 0,
  uncachedInputTokens: 0,
  cachedInputTokens: 0,
  cacheCreationTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  totalTokens: 0,
  records: 0,
  sessions: 0,
  providers: [],
  models: [],
  projects: [],
  daily: [],
  hourly: [],
  costQuality: {
    providerReportedShare: 0,
    modelPricedShare: 0,
    unpricedShare: 0,
    cacheSavingsUsd: 0,
    cacheWriteUsd: 0,
  },
  duplicateSources: [],
  contributingEnvironments: [],
  providerContributions: [],
  staleEnvironments: [],
};

export interface MergeUsageOptions {
  /**
   * Restrict every figure except `projects` to buckets from one project:
   * a project's namespaced key selects that project, `null` selects buckets
   * that ran outside every project, and `undefined` applies no filter.
   *
   * Sessions are counted per source directory, not per project, so a filtered
   * merge reports `sessions` as 0 rather than a number it cannot know.
   */
  readonly projectFilter?: string | null;
}

function localBucketProjectKey(bucket: UsageBucket): string | null | undefined {
  if (bucket.projectId !== undefined) return `id:${bucket.projectId}`;
  if (bucket.project !== undefined) return `title:${bucket.project}`;
  return bucket.projectAttribution === "outside" ? null : undefined;
}

function namespacedProjectKey(environmentId: EnvironmentId, localKey: string): string {
  return JSON.stringify([environmentId, localKey]);
}

/** Converts a merged project key back to the key understood by one server. */
export function projectFilterForEnvironment(
  filter: string | null | undefined,
  environmentId: EnvironmentId,
): string | null | undefined {
  if (filter === undefined || filter === null) return filter;
  try {
    const parsed: unknown = JSON.parse(filter);
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      parsed[0] === environmentId &&
      typeof parsed[1] === "string"
    ) {
      return parsed[1];
    }
  } catch {
    // A malformed or foreign key must select nothing in this environment.
  }
  return "environment-mismatch:";
}

/**
 * Merges every connected environment's summary.
 *
 * `expectedContractVersion` guards against an environment running older server
 * code: rather than blocking the page, incompatible data is excluded and its
 * id is reported so the UI can say coverage is partial. Versions in
 * [{@link USAGE_MERGE_COMPATIBLE_SINCE}, expected] still merge, so an additive
 * provider expansion does not drop Claude/Codex totals from older servers.
 */
export function mergeUsage(
  environments: readonly EnvironmentUsage[],
  expectedContractVersion: number,
  options?: MergeUsageOptions,
): MergedUsage {
  if (environments.length === 0) return EMPTY_MERGED;
  const projectFilter = options?.projectFilter;

  const current: EnvironmentUsage[] = [];
  const staleEnvironments: EnvironmentId[] = [];
  for (const environment of environments) {
    if (isCompatibleContractVersion(environment.summary.contractVersion, expectedContractVersion)) {
      current.push(environment);
    } else {
      staleEnvironments.push(environment.environmentId);
    }
  }

  // A namespaced project belongs to one environment. Restrict ownership
  // candidates before de-duplication so another environment cannot claim the
  // shared transcript source and erase the selected project's buckets.
  const ownershipEnvironments =
    typeof projectFilter === "string"
      ? current.filter(
          (environment) =>
            projectFilterForEnvironment(projectFilter, environment.environmentId) !==
            "environment-mismatch:",
        )
      : current;
  const unfilteredClaims = claimSources(current);
  const selectedClaims =
    typeof projectFilter === "string" ? claimSources(ownershipEnvironments) : unfilteredClaims;
  const { ownerByFingerprint, duplicates } = selectedClaims;
  const unfilteredOwnerByFingerprint = unfilteredClaims.ownerByFingerprint;

  let costUsd = 0;
  let uncachedInputTokens = 0;
  let cachedInputTokens = 0;
  let cacheCreationTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let records = 0;
  let sessions = 0;
  let cacheSavingsUsd = 0;
  let cacheWriteUsd = 0;
  let cacheWriteComplete = true;
  let providerReportedRecords = 0;
  let unpricedRecords = 0;

  const providerAccumulator = new Map<
    UsageProviderKind,
    { costUsd: number; totalTokens: number; records: number; sessions: number }
  >();
  const modelAccumulator = new Map<
    string,
    {
      provider: UsageProviderKind;
      costUsd: number;
      totalTokens: number;
      cacheWriteTokens: number;
      cacheWriteUsd: number;
      cacheWriteComplete: boolean;
      records: number;
    }
  >();
  // Keyed by stable project id where available, with a namespaced title
  // fallback for pre-v7 summaries. Accumulated before the project filter.
  const projectAccumulator = new Map<
    string,
    {
      projectId: ProjectId | null;
      projectKey: string | null;
      project: string | null;
      costUsd: number;
      totalTokens: number;
      cacheWriteTokens: number;
      cacheWriteUsd: number;
      cacheWriteComplete: boolean;
      records: number;
    }
  >();
  let unfilteredCostUsd = 0;

  // Keep the picker stable while a project is selected. Its rows come from
  // the globally de-duplicated view, while the figures below use the selected
  // environment's ownership map.
  for (const environment of current) {
    const { buckets } = ownedContribution(environment, unfilteredOwnerByFingerprint);
    for (const bucket of buckets) {
      const tokens = bucketTokens(bucket);
      const bucketCacheWriteComplete =
        bucket.totals.cacheCreationTokens === 0 || bucket.cacheWriteUsd !== undefined;
      unfilteredCostUsd += bucket.costUsd;
      const localProjectKey = localBucketProjectKey(bucket);
      const projectKey =
        typeof localProjectKey === "string"
          ? namespacedProjectKey(environment.environmentId, localProjectKey)
          : localProjectKey;
      if (projectKey === undefined) continue;
      const accumulatorKey = projectKey ?? "\0";
      const project = projectAccumulator.get(accumulatorKey) ?? {
        projectId: bucket.projectId ?? null,
        projectKey,
        project: bucket.project ?? null,
        costUsd: 0,
        totalTokens: 0,
        cacheWriteTokens: 0,
        cacheWriteUsd: 0,
        cacheWriteComplete: true,
        records: 0,
      };
      project.costUsd += bucket.costUsd;
      project.totalTokens += tokens;
      project.cacheWriteTokens += bucket.totals.cacheCreationTokens;
      project.cacheWriteUsd += bucket.cacheWriteUsd ?? 0;
      project.cacheWriteComplete &&= bucketCacheWriteComplete;
      project.records += bucket.records;
      projectAccumulator.set(accumulatorKey, project);
    }
  }

  const dailyAccumulator = new Map<
    string,
    {
      costUsd: number;
      totalTokens: number;
      byProvider: Map<UsageProviderKind, { costUsd: number; totalTokens: number }>;
    }
  >();
  const hourlyAccumulator = new Map<
    string,
    {
      day: string;
      hourStart: string;
      costUsd: number;
      totalTokens: number;
      byProvider: Map<UsageProviderKind, { costUsd: number; totalTokens: number }>;
    }
  >();
  const contributingEnvironments: EnvironmentId[] = [];
  const providerContributions: EnvironmentProviderContribution[] = [];

  for (const environment of current) {
    const { buckets, sessionsByProvider } = ownedContribution(environment, ownerByFingerprint);
    if (buckets.length > 0) {
      contributingEnvironments.push(environment.environmentId);
      providerContributions.push({
        environmentId: environment.environmentId,
        contractVersion: environment.summary.contractVersion,
        providers: [...new Set(buckets.map((bucket) => bucket.provider))].sort(),
      });
    }

    // Session counts are per source directory; a project filter cannot split
    // them, so a filtered merge leaves every session figure at 0.
    if (projectFilter === undefined) {
      for (const [providerKind, providerSessions] of sessionsByProvider) {
        sessions += providerSessions;
        if (providerSessions === 0) continue;
        const provider = providerAccumulator.get(providerKind) ?? {
          costUsd: 0,
          totalTokens: 0,
          records: 0,
          sessions: 0,
        };
        provider.sessions += providerSessions;
        providerAccumulator.set(providerKind, provider);
      }
    }

    for (const bucket of buckets) {
      const tokens = bucketTokens(bucket);
      const bucketCacheWriteComplete =
        bucket.totals.cacheCreationTokens === 0 || bucket.cacheWriteUsd !== undefined;

      const localProjectKey = localBucketProjectKey(bucket);
      const projectKey =
        typeof localProjectKey === "string"
          ? namespacedProjectKey(environment.environmentId, localProjectKey)
          : localProjectKey;
      // Unknown attribution stays in unfiltered totals but never claims to be
      // part of the explicit Outside projects slice.
      if (projectKey === undefined) {
        if (projectFilter !== undefined) continue;
      } else if (projectFilter !== undefined && projectKey !== projectFilter) continue;

      costUsd += bucket.costUsd;
      cacheSavingsUsd += bucket.cacheSavingsUsd;
      cacheWriteUsd += bucket.cacheWriteUsd ?? 0;
      cacheWriteComplete &&= bucketCacheWriteComplete;
      uncachedInputTokens += bucket.totals.uncachedInputTokens;
      cachedInputTokens += bucket.totals.cachedInputTokens;
      cacheCreationTokens += bucket.totals.cacheCreationTokens;
      outputTokens += bucket.totals.outputTokens;
      reasoningTokens += bucket.totals.reasoningTokens;
      records += bucket.records;
      unpricedRecords += bucket.unpricedRecords;
      if (bucket.costSource === "providerReported") providerReportedRecords += bucket.records;

      const provider = providerAccumulator.get(bucket.provider) ?? {
        costUsd: 0,
        totalTokens: 0,
        records: 0,
        sessions: 0,
      };
      provider.costUsd += bucket.costUsd;
      provider.totalTokens += tokens;
      provider.records += bucket.records;
      providerAccumulator.set(bucket.provider, provider);

      const modelKey = `${bucket.provider} ${bucket.model}`;
      const model = modelAccumulator.get(modelKey) ?? {
        provider: bucket.provider,
        costUsd: 0,
        totalTokens: 0,
        cacheWriteTokens: 0,
        cacheWriteUsd: 0,
        cacheWriteComplete: true,
        records: 0,
      };
      model.costUsd += bucket.costUsd;
      model.totalTokens += tokens;
      model.cacheWriteTokens += bucket.totals.cacheCreationTokens;
      model.cacheWriteUsd += bucket.cacheWriteUsd ?? 0;
      model.cacheWriteComplete &&= bucketCacheWriteComplete;
      model.records += bucket.records;
      modelAccumulator.set(modelKey, model);

      const day = dailyAccumulator.get(bucket.day) ?? {
        costUsd: 0,
        totalTokens: 0,
        byProvider: new Map<UsageProviderKind, { costUsd: number; totalTokens: number }>(),
      };
      day.costUsd += bucket.costUsd;
      day.totalTokens += tokens;
      const dayProvider = day.byProvider.get(bucket.provider) ?? { costUsd: 0, totalTokens: 0 };
      dayProvider.costUsd += bucket.costUsd;
      dayProvider.totalTokens += tokens;
      day.byProvider.set(bucket.provider, dayProvider);
      dailyAccumulator.set(bucket.day, day);

      if (bucket.hourStart !== undefined) {
        const hour = hourlyAccumulator.get(bucket.hourStart) ?? {
          day: bucket.day,
          hourStart: bucket.hourStart,
          costUsd: 0,
          totalTokens: 0,
          byProvider: new Map<UsageProviderKind, { costUsd: number; totalTokens: number }>(),
        };
        hour.costUsd += bucket.costUsd;
        hour.totalTokens += tokens;
        const hourProvider = hour.byProvider.get(bucket.provider) ?? {
          costUsd: 0,
          totalTokens: 0,
        };
        hourProvider.costUsd += bucket.costUsd;
        hourProvider.totalTokens += tokens;
        hour.byProvider.set(bucket.provider, hourProvider);
        hourlyAccumulator.set(bucket.hourStart, hour);
      }
    }
  }

  const totalTokens = uncachedInputTokens + cachedInputTokens + cacheCreationTokens + outputTokens;

  const providers: ProviderTotals[] = [...providerAccumulator.entries()]
    .map(([provider, totals]) => ({
      provider,
      costUsd: totals.costUsd,
      totalTokens: totals.totalTokens,
      records: totals.records,
      sessions: totals.sessions,
      costShare: costUsd === 0 ? 0 : totals.costUsd / costUsd,
      tokenShare: totalTokens === 0 ? 0 : totals.totalTokens / totalTokens,
    }))
    .sort((a, b) => b.costUsd - a.costUsd);

  const models: ModelTotals[] = [...modelAccumulator.entries()]
    .map(([key, totals]) => ({
      model: key.slice(key.indexOf(" ") + 1),
      provider: totals.provider,
      costUsd: totals.costUsd,
      totalTokens: totals.totalTokens,
      cacheWriteTokens: totals.cacheWriteTokens,
      cacheWriteUsd: totals.cacheWriteComplete ? totals.cacheWriteUsd : null,
      records: totals.records,
      costShare: costUsd === 0 ? 0 : totals.costUsd / costUsd,
    }))
    .sort((a, b) => b.costUsd - a.costUsd || b.totalTokens - a.totalTokens);

  const projects: ProjectTotals[] = [...projectAccumulator.entries()]
    .map(([, totals]) => ({
      projectId: totals.projectId,
      projectKey: totals.projectKey,
      project: totals.project,
      costUsd: totals.costUsd,
      totalTokens: totals.totalTokens,
      cacheWriteTokens: totals.cacheWriteTokens,
      cacheWriteUsd: totals.cacheWriteComplete ? totals.cacheWriteUsd : null,
      records: totals.records,
      costShare: unfilteredCostUsd === 0 ? 0 : totals.costUsd / unfilteredCostUsd,
    }))
    .sort((a, b) => b.costUsd - a.costUsd || b.totalTokens - a.totalTokens);

  const daily: DailyTotals[] = [...dailyAccumulator.entries()]
    .map(([day, totals]) => ({
      day,
      costUsd: totals.costUsd,
      totalTokens: totals.totalTokens,
      byProvider: totals.byProvider,
    }))
    .sort((a, b) => a.day.localeCompare(b.day));

  const hourly: HourlyTotals[] = [...hourlyAccumulator.values()].sort((a, b) =>
    a.hourStart.localeCompare(b.hourStart),
  );

  return {
    costUsd,
    uncachedInputTokens,
    cachedInputTokens,
    cacheCreationTokens,
    outputTokens,
    reasoningTokens,
    totalTokens,
    records,
    sessions,
    providers,
    models,
    projects,
    daily,
    hourly,
    costQuality: {
      providerReportedShare: records === 0 ? 0 : providerReportedRecords / records,
      unpricedShare: records === 0 ? 0 : unpricedRecords / records,
      modelPricedShare:
        records === 0 ? 0 : (records - providerReportedRecords - unpricedRecords) / records,
      cacheSavingsUsd,
      cacheWriteUsd: cacheWriteComplete ? cacheWriteUsd : null,
    },
    duplicateSources: duplicates,
    contributingEnvironments,
    providerContributions: providerContributions.sort((a, b) =>
      a.environmentId.localeCompare(b.environmentId),
    ),
    staleEnvironments,
  };
}
