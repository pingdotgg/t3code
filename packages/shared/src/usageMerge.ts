/**
 * Merges per-environment usage summaries into the single view the page renders.
 *
 * Pure, so the de-duplication and derivation rules can be tested without a
 * connected environment.
 *
 * @module usageMerge
 */
import type {
  EnvironmentId,
  UsageBucket,
  UsageProviderKind,
  UsageSourceFingerprint,
  UsageSummary,
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
}

export interface IncompleteUsageSource {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly provider: UsageProviderKind;
  readonly sourcePath: string;
  readonly status: "partial" | "failed";
  readonly message: string | null;
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
  /** Environments whose data was dropped as a duplicate of another's. */
  readonly duplicateSources: readonly string[];
  /** Provider stores that could not be read completely. */
  readonly incompleteSources: readonly IncompleteUsageSource[];
  readonly contributingEnvironments: readonly EnvironmentId[];
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

function environmentProviderKey(environmentId: EnvironmentId, provider: UsageProviderKind): string {
  return `${environmentId}\0${provider}`;
}

function sourceClaimKey(fingerprint: UsageSourceFingerprint, environmentId: EnvironmentId): string {
  const key = fingerprintKey(fingerprint);
  return fingerprint.volumeId.length > 0 ? key : `${key}\0${environmentId}`;
}

/**
 * Decides which environment owns each connected provider-source group.
 *
 * Several environments on one machine (worktree servers, for instance) resolve
 * the same provider home and would otherwise double count every token. Current
 * buckets carry source attribution and are claimed exactly; the connected-group
 * winner is the conservative fallback for an older/unattributed bucket. The
 * environment with the most complete/readable stores wins that fallback; ties
 * are sorted by environment id so ownership does not change between renders.
 */
function claimSources(environments: readonly EnvironmentUsage[]): {
  readonly ownerByFingerprint: ReadonlyMap<string, EnvironmentId>;
  readonly ownedEnvironmentProviders: ReadonlySet<string>;
  readonly duplicates: readonly string[];
} {
  const ownerByFingerprint = new Map<string, EnvironmentId>();
  const ownedEnvironmentProviders = new Set<string>();
  const duplicates: string[] = [];

  const exactCandidates = environments
    .flatMap((environment) =>
      environment.summary.sources.flatMap((source) =>
        source.status === "missing" ? [] : [{ environment, source }],
      ),
    )
    .sort((a, b) => {
      const rank = (status: "ok" | "partial" | "failed" | "missing") =>
        status === "ok" ? 0 : status === "partial" ? 1 : status === "failed" ? 2 : 3;
      const statusOrder = rank(a.source.status) - rank(b.source.status);
      return statusOrder || a.environment.environmentId.localeCompare(b.environment.environmentId);
    });
  for (const { environment, source } of exactCandidates) {
    const key = sourceClaimKey(source.fingerprint, environment.environmentId);
    if (ownerByFingerprint.has(key)) {
      duplicates.push(`${environment.label}: ${source.fingerprint.resolvedHomePath}`);
    } else {
      ownerByFingerprint.set(key, environment.environmentId);
    }
  }

  for (const provider of new Set(
    environments.flatMap((environment) =>
      environment.summary.sources.map((source) => source.fingerprint.provider),
    ),
  )) {
    const candidates = environments.flatMap((environment) => {
      const sources = environment.summary.sources.filter(
        (source) => source.fingerprint.provider === provider,
      );
      return sources.length === 0 ? [] : [{ environment, sources }];
    });
    const byEnvironment = new Map(
      candidates.map((candidate) => [candidate.environment.environmentId, candidate]),
    );
    const adjacent = new Map<EnvironmentId, Set<EnvironmentId>>(
      candidates.map((candidate) => [candidate.environment.environmentId, new Set()]),
    );
    const environmentsByFingerprint = new Map<string, EnvironmentId[]>();
    for (const candidate of candidates) {
      for (const source of candidate.sources) {
        if (source.status === "missing" || source.fingerprint.volumeId.length === 0) continue;
        const key = fingerprintKey(source.fingerprint);
        const owners = environmentsByFingerprint.get(key) ?? [];
        owners.push(candidate.environment.environmentId);
        environmentsByFingerprint.set(key, owners);
      }
    }
    for (const owners of environmentsByFingerprint.values()) {
      const first = owners[0];
      if (first === undefined) continue;
      for (const owner of owners.slice(1)) {
        adjacent.get(first)?.add(owner);
        adjacent.get(owner)?.add(first);
      }
    }

    const visited = new Set<EnvironmentId>();
    for (const environmentId of [...byEnvironment.keys()].sort()) {
      if (visited.has(environmentId)) continue;
      const component: EnvironmentId[] = [];
      const pending = [environmentId];
      while (pending.length > 0) {
        const current = pending.pop();
        if (current === undefined || visited.has(current)) continue;
        visited.add(current);
        component.push(current);
        for (const neighbor of adjacent.get(current) ?? []) pending.push(neighbor);
      }

      const ranked = component
        .map((id) => byEnvironment.get(id))
        .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== undefined)
        .sort((a, b) => {
          const aOk = a.sources.filter((source) => source.status === "ok").length;
          const bOk = b.sources.filter((source) => source.status === "ok").length;
          const aReadable = a.sources.filter(
            (source) => source.status === "ok" || source.status === "partial",
          ).length;
          const bReadable = b.sources.filter(
            (source) => source.status === "ok" || source.status === "partial",
          ).length;
          return (
            bOk - aOk ||
            bReadable - aReadable ||
            a.environment.environmentId.localeCompare(b.environment.environmentId)
          );
        });
      const winner = ranked[0];
      if (winner === undefined) continue;
      ownedEnvironmentProviders.add(
        environmentProviderKey(winner.environment.environmentId, provider),
      );
    }
  }

  return { ownerByFingerprint, ownedEnvironmentProviders, duplicates };
}

/** Sources this environment owns after fingerprint claims, plus their buckets. */
function ownedContribution(
  environment: EnvironmentUsage,
  ownerByFingerprint: ReadonlyMap<string, EnvironmentId>,
  ownedEnvironmentProviders: ReadonlySet<string>,
): {
  readonly buckets: readonly UsageBucket[];
  readonly sessionsByProvider: ReadonlyMap<UsageProviderKind, number>;
} {
  const sessionsByProvider = new Map<UsageProviderKind, number>();
  const readableProviders = new Set<UsageProviderKind>();
  const sourceByPath = new Map(
    environment.summary.sources.map((source) => [
      `${source.fingerprint.provider}\0${source.fingerprint.resolvedHomePath}`,
      source,
    ]),
  );
  for (const source of environment.summary.sources) {
    if (source.status === "missing" || source.status === "failed") continue;
    const provider = source.fingerprint.provider;
    readableProviders.add(provider);
    if (
      ownerByFingerprint.get(sourceClaimKey(source.fingerprint, environment.environmentId)) ===
      environment.environmentId
    ) {
      // Distinct within a directory. Summing per-bucket session counts instead
      // would count a session once per day and model it spans.
      sessionsByProvider.set(
        provider,
        (sessionsByProvider.get(provider) ?? 0) + source.distinctSessions,
      );
    }
  }
  return {
    buckets: environment.summary.buckets.filter((bucket) => {
      if (bucket.sourcePath !== undefined) {
        const source = sourceByPath.get(`${bucket.provider}\0${bucket.sourcePath}`);
        return (
          source !== undefined &&
          source.status !== "missing" &&
          source.status !== "failed" &&
          ownerByFingerprint.get(sourceClaimKey(source.fingerprint, environment.environmentId)) ===
            environment.environmentId
        );
      }
      return (
        ownedEnvironmentProviders.has(
          environmentProviderKey(environment.environmentId, bucket.provider),
        ) && readableProviders.has(bucket.provider)
      );
    }),
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
  duplicateSources: [],
  incompleteSources: [],
  contributingEnvironments: [],
  staleEnvironments: [],
};

/**
 * Merges every connected environment's summary.
 *
 * `expectedContractVersion` guards against an environment running older server
 * code: rather than blocking the page, its data is excluded and its id is
 * reported so the UI can say coverage is partial.
 */
export function mergeUsage(
  environments: readonly EnvironmentUsage[],
  expectedContractVersion: number,
): MergedUsage {
  if (environments.length === 0) return EMPTY_MERGED;

  const current: EnvironmentUsage[] = [];
  const staleEnvironments: EnvironmentId[] = [];
  for (const environment of environments) {
    if (environment.summary.contractVersion === expectedContractVersion) {
      current.push(environment);
    } else {
      staleEnvironments.push(environment.environmentId);
    }
  }

  const { ownerByFingerprint, ownedEnvironmentProviders, duplicates } = claimSources(current);
  const providerCoverage = new Map<
    string,
    {
      environmentId: EnvironmentId;
      environmentLabel: string;
      provider: UsageProviderKind;
      sourcePath: string;
      message: string | null;
      hasReadableSource: boolean;
      hasProblem: boolean;
    }
  >();
  for (const environment of current) {
    for (const source of environment.summary.sources) {
      const exactOwner = ownerByFingerprint.get(
        sourceClaimKey(source.fingerprint, environment.environmentId),
      );
      const ownsFallback = ownedEnvironmentProviders.has(
        environmentProviderKey(environment.environmentId, source.fingerprint.provider),
      );
      if (
        (exactOwner !== undefined && exactOwner !== environment.environmentId) ||
        (exactOwner === undefined && !ownsFallback)
      ) {
        continue;
      }
      if (source.status === "missing") continue;

      const key = `${environment.environmentId}\0${source.fingerprint.provider}`;
      const coverage = providerCoverage.get(key) ?? {
        environmentId: environment.environmentId,
        environmentLabel: environment.label,
        provider: source.fingerprint.provider,
        sourcePath: source.fingerprint.resolvedHomePath,
        message: null,
        hasReadableSource: false,
        hasProblem: false,
      };
      if (source.status === "ok" || source.status === "partial") {
        coverage.hasReadableSource = true;
      }
      if (source.status === "partial" || source.status === "failed") {
        if (!coverage.hasProblem) {
          coverage.sourcePath = source.fingerprint.resolvedHomePath;
          coverage.message = source.message;
        }
        coverage.hasProblem = true;
      }
      providerCoverage.set(key, coverage);
    }
  }
  const incompleteSources: IncompleteUsageSource[] = [...providerCoverage.values()]
    .filter((coverage) => coverage.hasProblem)
    .map(({ hasReadableSource, hasProblem: _, ...coverage }) => ({
      ...coverage,
      status: hasReadableSource ? "partial" : "failed",
    }));

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

  const providerAccumulator = new Map<
    UsageProviderKind,
    { costUsd: number; totalTokens: number; records: number; sessions: number }
  >();
  const modelAccumulator = new Map<
    string,
    { provider: UsageProviderKind; costUsd: number; totalTokens: number; records: number }
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

  for (const environment of current) {
    const { buckets, sessionsByProvider } = ownedContribution(
      environment,
      ownerByFingerprint,
      ownedEnvironmentProviders,
    );
    if (buckets.length > 0) contributingEnvironments.push(environment.environmentId);

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
        records: 0,
      };
      model.costUsd += bucket.costUsd;
      model.totalTokens += tokens;
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
      records: totals.records,
      costShare: costUsd === 0 ? 0 : totals.costUsd / costUsd,
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
    duplicateSources: duplicates,
    incompleteSources,
    contributingEnvironments,
    staleEnvironments,
  };
}
