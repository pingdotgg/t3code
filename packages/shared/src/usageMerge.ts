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
  type UsageBucket,
  type UsageProject,
  type UsageProviderKind,
  type UsageSource,
  type UsageSourceFingerprint,
  type UsageSummary,
  type UsageThread,
  type UsageTokenTotals,
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
  readonly tokens: UsageTokenTotals;
  readonly records: number;
  /**
   * Records whose tokens are counted here but which contributed nothing to
   * `costUsd`. When it equals `records` the cost is unknown, not zero.
   */
  readonly unpricedRecords: number;
  /**
   * Tokens with no known rates, which a custom price would cover. A cell that
   * mixes these with reported costs counts its tokens by record share.
   */
  readonly unpricedTokens: number;
  readonly costShare: number;
  readonly tokenShare: number;
}

/**
 * A model whose every record lacked rates has an unknown cost, not a zero one.
 * Clients must not present its `costUsd` as a real dollar figure.
 */
export function isModelCostUnknown(model: ModelTotals): boolean {
  return model.records > 0 && model.unpricedRecords >= model.records;
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
}

/**
 * `costUsd` by token category. `unsplit` is cost no rates could split,
 * including all cost from servers that predate the split.
 */
export interface CategoryCost {
  readonly input: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly output: number;
  readonly unsplit: number;
}

/** `costUsd` by request speed. Servers that predate speeds count as standard. */
export interface SpeedCost {
  readonly standard: number;
  readonly fast: number;
  readonly ultrafast: number;
  /** What fast and ultrafast requests cost above the standard rate. */
  readonly premium: number;
}

export interface UsageContractMismatch {
  readonly environmentId: EnvironmentId;
  readonly direction: "serverBehind" | "clientBehind";
  readonly contractVersion: number;
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
  readonly daily: readonly DailyTotals[];
  readonly hourly: readonly HourlyTotals[];
  readonly costQuality: CostQuality;
  readonly categoryCost: CategoryCost;
  readonly speedCost: SpeedCost;
  /** Environments whose data was dropped as a duplicate of another's. */
  readonly duplicateSources: readonly string[];
  readonly contributingEnvironments: readonly EnvironmentId[];
  readonly contractMismatches: readonly UsageContractMismatch[];
  /**
   * Each environment's buckets after source ownership, with the threads and
   * projects they point at. Thread indexes are local to their environment.
   */
  readonly contributions: readonly UsageContribution[];
}

export interface UsageContribution {
  readonly environmentId: EnvironmentId;
  readonly buckets: readonly UsageBucket[];
  readonly threads: readonly UsageThread[];
  readonly projects: readonly UsageProject[];
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

function bucketsForSource(summary: UsageSummary, source: UsageSource): readonly UsageBucket[] {
  const providerSources = summary.sources.filter(
    (entry) => entry.fingerprint.provider === source.fingerprint.provider,
  );
  return summary.buckets.filter(
    (bucket) =>
      bucket.provider === source.fingerprint.provider &&
      (bucket.sourcePath === source.fingerprint.resolvedHomePath ||
        (bucket.sourcePath === undefined && providerSources.length === 1)),
  );
}

/**
 * The overlap cell for partial-scan supplements. Thread and account stay out
 * of it on purpose: thread indexes are local to each summary, so the same
 * usage carries a different index in each scan.
 */
function bucketKey(bucket: UsageBucket): string {
  return JSON.stringify([bucket.day, bucket.hourStart ?? null, bucket.provider, bucket.model]);
}

/**
 * Cells already counted for one transcript directory. An hourly and a daily
 * summary of the same directory can only be compared by day, so a bucket
 * overlaps when its own cell, or its day at the other resolution, is counted.
 */
class SeenCells {
  readonly #cells = new Set<string>();
  readonly #hourlyDays = new Set<string>();
  readonly #dailyDays = new Set<string>();

  constructor(buckets: readonly UsageBucket[]) {
    this.addAll(buckets);
  }

  overlaps(bucket: UsageBucket): boolean {
    const day = dayKey(bucket);
    return (
      this.#cells.has(bucketKey(bucket)) ||
      (bucket.hourStart === undefined ? this.#hourlyDays.has(day) : this.#dailyDays.has(day))
    );
  }

  addAll(buckets: readonly UsageBucket[]): void {
    for (const bucket of buckets) {
      this.#cells.add(bucketKey(bucket));
      (bucket.hourStart === undefined ? this.#dailyDays : this.#hourlyDays).add(dayKey(bucket));
    }
  }
}

function dayKey(bucket: UsageBucket): string {
  return JSON.stringify([bucket.day, bucket.provider, bucket.model]);
}

/** How much older than the newest scan of a folder its owner may be. */
const ATTRIBUTION_MAX_AGE_MS = 10 * 60 * 1000;

/**
 * How well an environment can attribute a source: -1 when its server cannot
 * split usage by thread at all, otherwise the records it placed in its own T3
 * threads.
 */
function recordsInT3Threads(summary: UsageSummary, source: UsageSource): number {
  const threads = summary.threads;
  if (threads === undefined) return -1;
  let records = 0;
  for (const bucket of bucketsForSource(summary, source)) {
    if (bucket.thread !== undefined && threads[bucket.thread]?.threadId !== undefined) {
      records += bucket.records;
    }
  }
  return records;
}

/**
 * Decides which environment owns each physical transcript directory.
 *
 * Several environments on one machine (worktree servers, for instance) resolve
 * the same provider home and would otherwise double count every token.
 * Complete scans claim a fingerprint ahead of partial scans. Within a status,
 * a server that splits usage by thread wins over one that cannot, then the
 * environment that ran most of the directory's work in its own T3 threads,
 * so threads and projects keep their usage and the owner does not change
 * between refreshes; then the most recently read scan, then the environment
 * id. Attribution only decides among scans read within
 * {@link ATTRIBUTION_MAX_AGE_MS} of the newest, so an older owner misses at
 * most the usage recorded in between, which the next refresh shows. A newer
 * partial scan can still contribute cells absent from an older complete scan.
 *
 * Ownership is decided on whole summaries, so narrowing the buckets
 * afterwards (to one model, say) keeps the same owners as the full merge.
 */
function claimSources(environments: readonly EnvironmentUsage[]): {
  readonly ownerByFingerprint: ReadonlyMap<string, EnvironmentId>;
  readonly supplementalBucketsByEnvironment: ReadonlyMap<EnvironmentId, ReadonlySet<UsageBucket>>;
  readonly sessionsByFingerprint: ReadonlyMap<string, number>;
  readonly duplicates: readonly string[];
} {
  const ownerByFingerprint = new Map<string, EnvironmentId>();
  const ownerScanByFingerprint = new Map<
    string,
    { environment: EnvironmentUsage; source: UsageSource }
  >();
  const seenBucketKeysByFingerprint = new Map<string, SeenCells>();
  const supplementalBucketsByEnvironment = new Map<EnvironmentId, Set<UsageBucket>>();
  const sessionsByFingerprint = new Map<string, number>();
  const duplicates: string[] = [];

  const ordered = [...environments].sort(
    (a, b) =>
      (Date.parse(b.summary.readAt) || 0) - (Date.parse(a.summary.readAt) || 0) ||
      a.environmentId.localeCompare(b.environmentId),
  );

  // A complete scan takes precedence over a newer partial scan of the same
  // directory. Partial history still contributes when no complete copy exists.
  for (const status of ["ok", "partial", "failed"] as const) {
    const candidates = new Map<
      string,
      { environment: EnvironmentUsage; source: UsageSource; inThreads: number }[]
    >();
    for (const environment of ordered) {
      for (const source of environment.summary.sources) {
        if (source.status !== status) continue;
        const key = fingerprintKey(source.fingerprint);
        if (ownerByFingerprint.has(key)) {
          duplicates.push(`${environment.label}: ${source.fingerprint.resolvedHomePath}`);
          continue;
        }
        const list = candidates.get(key) ?? [];
        list.push({ environment, source, inThreads: 0 });
        candidates.set(key, list);
      }
    }
    for (const [key, list] of candidates) {
      if (list.length > 1) {
        // `list` is newest first. A scan far older than the newest, such as a
        // summary kept after a failed refresh, never wins on attribution.
        const newest = Date.parse(list[0]!.environment.summary.readAt) || 0;
        for (const entry of list) {
          const readAt = Date.parse(entry.environment.summary.readAt) || 0;
          entry.inThreads =
            newest - readAt > ATTRIBUTION_MAX_AGE_MS
              ? -2
              : recordsInT3Threads(entry.environment.summary, entry.source);
        }
      }
      // A stable sort keeps the read-time order among equals. A copy, not
      // `toSorted`: this also runs on Hermes.
      const [owner, ...rest] = [...list].sort((a, b) => b.inThreads - a.inThreads);
      if (owner === undefined) continue;
      ownerByFingerprint.set(key, owner.environment.environmentId);
      ownerScanByFingerprint.set(key, owner);
      sessionsByFingerprint.set(key, owner.source.distinctSessions);
      for (const { environment, source } of rest) {
        duplicates.push(`${environment.label}: ${source.fingerprint.resolvedHomePath}`);
      }
    }
  }

  // A newer partial scan may contain usage recorded after an older complete
  // scan. Keep cells absent from the complete scan. Aggregated cells do not
  // reveal enough to reconcile overlapping records without double counting.
  for (const environment of ordered) {
    for (const source of environment.summary.sources) {
      if (source.status !== "partial") continue;
      const key = fingerprintKey(source.fingerprint);
      const owner = ownerScanByFingerprint.get(key);
      if (
        owner?.source.status !== "ok" ||
        Date.parse(environment.summary.readAt) <= Date.parse(owner.environment.summary.readAt)
      ) {
        continue;
      }
      let seen = seenBucketKeysByFingerprint.get(key);
      if (seen === undefined) {
        seen = new SeenCells(bucketsForSource(owner.environment.summary, owner.source));
        seenBucketKeysByFingerprint.set(key, seen);
      }
      const supplemental =
        supplementalBucketsByEnvironment.get(environment.environmentId) ?? new Set<UsageBucket>();
      // Every bucket of a new cell counts: one cell holds a bucket per thread.
      // Cells are marked seen only after the whole source, so siblings stay.
      const admitted = bucketsForSource(environment.summary, source).filter(
        (bucket) => !seen.overlaps(bucket),
      );
      for (const bucket of admitted) supplemental.add(bucket);
      seen.addAll(admitted);
      if (admitted.length === 0) continue;
      supplementalBucketsByEnvironment.set(environment.environmentId, supplemental);
      sessionsByFingerprint.set(
        key,
        Math.max(sessionsByFingerprint.get(key) ?? 0, source.distinctSessions),
      );
    }
  }

  return {
    ownerByFingerprint,
    supplementalBucketsByEnvironment,
    sessionsByFingerprint,
    duplicates,
  };
}

/** Sources this environment owns after fingerprint claims, plus their buckets. */
function ownedContribution(
  environment: EnvironmentUsage,
  ownerByFingerprint: ReadonlyMap<string, EnvironmentId>,
  supplementalBuckets: ReadonlySet<UsageBucket>,
  sessionsByFingerprint: ReadonlyMap<string, number>,
  keepBucket: ((bucket: UsageBucket) => boolean) | undefined,
): {
  readonly buckets: readonly UsageBucket[];
  readonly sessionsByProvider: ReadonlyMap<UsageProviderKind, number>;
} {
  const ownedProviders = new Set<UsageProviderKind>();
  const ownedSources = new Set<string>();
  const sessionsByProvider = new Map<UsageProviderKind, number>();
  for (const source of environment.summary.sources) {
    if (source.status === "missing") continue;
    const key = fingerprintKey(source.fingerprint);
    if (ownerByFingerprint.get(key) === environment.environmentId) {
      const provider = source.fingerprint.provider;
      ownedProviders.add(provider);
      ownedSources.add(`${provider}\u0000${source.fingerprint.resolvedHomePath}`);
      // Distinct within a directory. Summing per-bucket session counts instead
      // would count a session once per day and model it spans.
      sessionsByProvider.set(
        provider,
        (sessionsByProvider.get(provider) ?? 0) +
          (sessionsByFingerprint.get(key) ?? source.distinctSessions),
      );
    }
  }
  return {
    buckets: environment.summary.buckets.filter(
      (bucket) =>
        (supplementalBuckets.has(bucket) ||
          (bucket.sourcePath === undefined
            ? ownedProviders.has(bucket.provider)
            : ownedSources.has(`${bucket.provider}\u0000${bucket.sourcePath}`))) &&
        (keepBucket === undefined || keepBucket(bucket)),
    ),
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

export function isCompatibleUsageContractVersion(version: number, expected: number): boolean {
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
  daily: [],
  hourly: [],
  costQuality: {
    providerReportedShare: 0,
    modelPricedShare: 0,
    unpricedShare: 0,
    cacheSavingsUsd: 0,
  },
  categoryCost: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, unsplit: 0 },
  speedCost: { standard: 0, fast: 0, ultrafast: 0, premium: 0 },
  duplicateSources: [],
  contributingEnvironments: [],
  contractMismatches: [],
  contributions: [],
};

/**
 * Merges every connected environment's summary.
 *
 * `expectedContractVersion` guards against incompatible server code: rather
 * than blocking the page, its data is excluded and the mismatch direction is
 * reported so the UI can identify which side needs updating. Versions in
 * [{@link USAGE_MERGE_COMPATIBLE_SINCE}, expected] still merge, so an additive
 * provider expansion does not drop Claude/Codex totals from older servers.
 *
 * `keepBucket` narrows the result, to one model for instance, after sources
 * are claimed, so the slice matches the same part of the full merge.
 */
export function mergeUsage(
  environments: readonly EnvironmentUsage[],
  expectedContractVersion: number,
  keepBucket?: (bucket: UsageBucket) => boolean,
): MergedUsage {
  if (environments.length === 0) return EMPTY_MERGED;

  const current: EnvironmentUsage[] = [];
  const contractMismatches: UsageContractMismatch[] = [];
  for (const environment of environments) {
    if (
      isCompatibleUsageContractVersion(environment.summary.contractVersion, expectedContractVersion)
    ) {
      current.push(environment);
    } else {
      contractMismatches.push({
        environmentId: environment.environmentId,
        direction:
          environment.summary.contractVersion < expectedContractVersion
            ? "serverBehind"
            : "clientBehind",
        contractVersion: environment.summary.contractVersion,
      });
    }
  }

  const {
    ownerByFingerprint,
    supplementalBucketsByEnvironment,
    sessionsByFingerprint,
    duplicates,
  } = claimSources(current);

  let costUsd = 0;
  let uncachedInputTokens = 0;
  let cachedInputTokens = 0;
  let cacheCreationTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let records = 0;
  let sessions = 0;
  let cacheSavingsUsd = 0;
  let providerReportedRecords = 0;
  let unpricedRecords = 0;
  const categoryCost = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  const speedCost = { fast: 0, ultrafast: 0, premium: 0 };

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
      tokens: UsageTokenTotals;
      records: number;
      unpricedRecords: number;
      unpricedTokens: number;
    }
  >();
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
  const contributions: UsageContribution[] = [];

  for (const environment of current) {
    const { buckets, sessionsByProvider } = ownedContribution(
      environment,
      ownerByFingerprint,
      supplementalBucketsByEnvironment.get(environment.environmentId) ?? new Set(),
      sessionsByFingerprint,
      keepBucket,
    );
    if (buckets.length > 0) {
      contributingEnvironments.push(environment.environmentId);
      contributions.push({
        environmentId: environment.environmentId,
        buckets,
        threads: environment.summary.threads ?? [],
        projects: environment.summary.projects ?? [],
      });
    }

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

    for (const bucket of buckets) {
      const tokens = bucketTokens(bucket);

      costUsd += bucket.costUsd;
      cacheSavingsUsd += bucket.cacheSavingsUsd;
      uncachedInputTokens += bucket.totals.uncachedInputTokens;
      cachedInputTokens += bucket.totals.cachedInputTokens;
      cacheCreationTokens += bucket.totals.cacheCreationTokens;
      outputTokens += bucket.totals.outputTokens;
      reasoningTokens += bucket.totals.reasoningTokens;
      records += bucket.records;
      unpricedRecords += bucket.unpricedRecords;
      if (bucket.costSource === "providerReported") providerReportedRecords += bucket.records;
      if (bucket.categoryCostUsd !== undefined) {
        categoryCost.input += bucket.categoryCostUsd.input;
        categoryCost.cacheRead += bucket.categoryCostUsd.cacheRead;
        categoryCost.cacheWrite += bucket.categoryCostUsd.cacheWrite;
        categoryCost.output += bucket.categoryCostUsd.output;
      }
      speedCost.fast += bucket.fastCostUsd ?? 0;
      speedCost.ultrafast += bucket.ultrafastCostUsd ?? 0;
      speedCost.premium += bucket.speedPremiumUsd ?? 0;

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
        tokens: {
          uncachedInputTokens: 0,
          cachedInputTokens: 0,
          cacheCreationTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
        },
        records: 0,
        unpricedRecords: 0,
        unpricedTokens: 0,
      };
      model.costUsd += bucket.costUsd;
      model.totalTokens += tokens;
      model.tokens = {
        uncachedInputTokens: model.tokens.uncachedInputTokens + bucket.totals.uncachedInputTokens,
        cachedInputTokens: model.tokens.cachedInputTokens + bucket.totals.cachedInputTokens,
        cacheCreationTokens: model.tokens.cacheCreationTokens + bucket.totals.cacheCreationTokens,
        outputTokens: model.tokens.outputTokens + bucket.totals.outputTokens,
        reasoningTokens: model.tokens.reasoningTokens + bucket.totals.reasoningTokens,
      };
      model.records += bucket.records;
      model.unpricedRecords += bucket.unpricedRecords;
      if (bucket.records > 0) {
        model.unpricedTokens += (tokens * bucket.unpricedRecords) / bucket.records;
      }
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
      tokens: totals.tokens,
      records: totals.records,
      unpricedRecords: totals.unpricedRecords,
      unpricedTokens: totals.unpricedTokens,
      costShare: costUsd === 0 ? 0 : totals.costUsd / costUsd,
      tokenShare: totalTokens === 0 ? 0 : totals.totalTokens / totalTokens,
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
    daily,
    hourly,
    costQuality: {
      providerReportedShare: records === 0 ? 0 : providerReportedRecords / records,
      unpricedShare: records === 0 ? 0 : unpricedRecords / records,
      modelPricedShare:
        records === 0 ? 0 : (records - providerReportedRecords - unpricedRecords) / records,
      cacheSavingsUsd,
    },
    // Clamped so float error never shows as a negative remainder.
    categoryCost: {
      ...categoryCost,
      unsplit: Math.max(
        0,
        costUsd -
          categoryCost.input -
          categoryCost.cacheRead -
          categoryCost.cacheWrite -
          categoryCost.output,
      ),
    },
    speedCost: {
      ...speedCost,
      standard: Math.max(0, costUsd - speedCost.fast - speedCost.ultrafast),
    },
    duplicateSources: duplicates,
    contributingEnvironments,
    contractMismatches,
    contributions,
  };
}
