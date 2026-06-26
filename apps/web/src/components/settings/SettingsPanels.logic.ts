import type {
  EnvironmentId,
  OrchestrationProjectShell,
  OrchestrationThreadShell,
  ProviderDriverKind,
  ProviderInstanceConfig,
  ProviderInstanceId,
  ThreadId,
  ServerSettings,
  UnifiedSettings,
} from "@t3tools/contracts";
import type { ArchivedSnapshotEntry } from "@t3tools/client-runtime/state/threads";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { normalizeSearchQuery, scoreQueryMatch } from "@t3tools/shared/searchRanking";

const ARCHIVED_THREAD_ALL_TOKENS_SCORE_OFFSET = 1_000;
const ARCHIVED_THREAD_PARTIAL_TOKENS_SCORE_OFFSET = 5_000;
const DEFAULT_ARCHIVED_PROJECT_BULK_ACTION_CONCURRENCY = 4;

export type ArchivedThreadSortField = "archivedAt" | "createdAt";
export type ArchivedThreadSortDirection = "asc" | "desc";
export type ArchivedProjectBulkScope = "all" | "matching";

export interface ArchivedThreadSortState {
  readonly field: ArchivedThreadSortField;
  readonly direction: ArchivedThreadSortDirection;
}

export type ArchivedProjectBulkThread = {
  readonly id: ThreadId;
  readonly environmentId: EnvironmentId;
};

export type ArchivedProjectBulkFailure = Extract<
  AtomCommandResult<unknown, unknown>,
  { readonly _tag: "Failure" }
>;

export interface ArchivedThreadGroupProject {
  readonly id: OrchestrationProjectShell["id"];
  readonly environmentId: EnvironmentId;
  readonly name: string;
  readonly cwd: string;
}

export type ArchivedThreadGroupThread = OrchestrationThreadShell & {
  readonly environmentId: EnvironmentId;
  readonly normalizedTitle: string;
  readonly searchScore: number;
};

export interface ArchivedThreadGroup {
  readonly key: string;
  readonly project: ArchivedThreadGroupProject;
  readonly threads: ReadonlyArray<ArchivedThreadGroupThread>;
  readonly searchScore: number;
}

export interface ArchivedThreadSearchInput {
  readonly normalizedQuery: string;
  readonly tokens: ReadonlyArray<string>;
  readonly isSearching: boolean;
}

export interface ArchivedProjectBulkActionOptions {
  readonly concurrency?: number;
}

function archivedProjectGroupKey(
  environmentId: EnvironmentId,
  projectId: OrchestrationProjectShell["id"],
): string {
  return JSON.stringify([environmentId, projectId]);
}

export function parseArchivedThreadSearchInput(query: string): ArchivedThreadSearchInput {
  const normalizedQuery = normalizeSearchQuery(query);
  return {
    normalizedQuery,
    tokens: normalizedQuery.split(/\s+/u).filter((token) => token.length > 0),
    isSearching: normalizedQuery.length > 0,
  };
}

// Lower search scores are more relevant, matching the shared search-ranking helpers.
export function archivedThreadSearchScore(input: {
  readonly normalizedTitle: string;
  readonly normalizedQuery: string;
  readonly tokens: ReadonlyArray<string>;
}): number | null {
  if (input.normalizedQuery.length === 0) {
    return 0;
  }

  if (!input.normalizedTitle) {
    return null;
  }

  const phraseScore = scoreQueryMatch({
    value: input.normalizedTitle,
    query: input.normalizedQuery,
    exactBase: 0,
    prefixBase: 1,
    boundaryBase: 2,
    includesBase: 3,
  });
  if (phraseScore !== null) {
    return phraseScore;
  }

  let matchedTokenCount = 0;
  let tokenScore = 0;
  for (const token of input.tokens) {
    const score = scoreQueryMatch({
      value: input.normalizedTitle,
      query: token,
      exactBase: 0,
      prefixBase: 2,
      boundaryBase: 4,
      includesBase: 6,
      ...(token.length >= 3 ? { fuzzyBase: 100 } : {}),
    });
    if (score === null) {
      continue;
    }

    matchedTokenCount += 1;
    tokenScore += score;
  }

  if (matchedTokenCount === 0) {
    return null;
  }

  if (matchedTokenCount === input.tokens.length) {
    return ARCHIVED_THREAD_ALL_TOKENS_SCORE_OFFSET + tokenScore;
  }

  return (
    ARCHIVED_THREAD_PARTIAL_TOKENS_SCORE_OFFSET +
    (input.tokens.length - matchedTokenCount) * 1_000 +
    tokenScore
  );
}

export async function runArchivedProjectThreadActions(
  threads: ReadonlyArray<ArchivedProjectBulkThread>,
  action: (thread: ArchivedProjectBulkThread) => Promise<AtomCommandResult<unknown, unknown>>,
  options: ArchivedProjectBulkActionOptions = {},
): Promise<ReadonlyArray<ArchivedProjectBulkFailure>> {
  const failures: Array<ArchivedProjectBulkFailure> = [];
  const thrownErrors: unknown[] = [];
  const concurrency =
    options.concurrency === undefined || !Number.isFinite(options.concurrency)
      ? DEFAULT_ARCHIVED_PROJECT_BULK_ACTION_CONCURRENCY
      : Math.max(1, Math.floor(options.concurrency));
  let nextThreadIndex = 0;
  let shouldStop = false;
  async function worker() {
    for (;;) {
      if (shouldStop) {
        return;
      }
      const threadIndex = nextThreadIndex;
      if (threadIndex >= threads.length) {
        return;
      }
      nextThreadIndex += 1;
      const thread = threads[threadIndex]!;
      try {
        const result = await action(thread);
        if (result._tag === "Failure") {
          failures.push(result);
        }
      } catch (error) {
        thrownErrors.push(error);
        shouldStop = true;
        return;
      }
    }
  }

  const workers: Array<Promise<void>> = [];
  for (let index = 0; index < Math.min(concurrency, threads.length); index += 1) {
    workers.push(worker());
  }
  await Promise.all(workers);
  if (thrownErrors.length > 0) {
    throw new AggregateError(thrownErrors, "Archived project thread action failed");
  }
  return failures;
}

export function archivedProjectBulkScopeLabel(scope: ArchivedProjectBulkScope): string {
  return scope === "matching" ? "matching archived conversations" : "all archived conversations";
}

function archivedThreadSortTimestamp(
  thread: { readonly archivedAt: string | null; readonly createdAt: string },
  field: ArchivedThreadSortField,
): number {
  const timestamp = Date.parse(
    field === "archivedAt" ? (thread.archivedAt ?? thread.createdAt) : thread.createdAt,
  );
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

export function compareArchivedThreads<
  T extends { readonly id: string; readonly archivedAt: string | null; readonly createdAt: string },
>(left: T, right: T, sort: ArchivedThreadSortState): number {
  const leftTimestamp = archivedThreadSortTimestamp(left, sort.field);
  const rightTimestamp = archivedThreadSortTimestamp(right, sort.field);
  const timestampComparison =
    sort.direction === "asc" ? leftTimestamp - rightTimestamp : rightTimestamp - leftTimestamp;
  return timestampComparison || left.id.localeCompare(right.id);
}

export function nextArchivedThreadSortState(
  current: ArchivedThreadSortState,
  field: ArchivedThreadSortField,
): ArchivedThreadSortState {
  if (current.field !== field) {
    return { field, direction: "desc" };
  }
  return { field, direction: current.direction === "desc" ? "asc" : "desc" };
}

export function buildArchivedThreadGroups(input: {
  readonly snapshots: ReadonlyArray<ArchivedSnapshotEntry>;
  readonly normalizedSearchQuery: string;
  readonly searchTokens: ReadonlyArray<string>;
  readonly isSearching: boolean;
  readonly sort: ArchivedThreadSortState;
}): ReadonlyArray<ArchivedThreadGroup> {
  const projectsByEnvironmentAndId = new Map<string, ArchivedThreadGroupProject>();
  const threadsByEnvironmentAndProjectId = new Map<string, ArchivedThreadGroupThread[]>();

  for (const { environmentId, snapshot } of input.snapshots) {
    for (const project of snapshot.projects) {
      const key = archivedProjectGroupKey(environmentId, project.id);
      // Later snapshots for the same environment/project replace older project metadata.
      projectsByEnvironmentAndId.set(key, {
        id: project.id,
        environmentId,
        name: project.title,
        cwd: project.workspaceRoot,
      });
    }

    for (const thread of snapshot.threads) {
      const normalizedTitle = normalizeSearchQuery(thread.title);
      const searchScore = archivedThreadSearchScore({
        normalizedTitle,
        normalizedQuery: input.normalizedSearchQuery,
        tokens: input.searchTokens,
      });
      if (searchScore === null) {
        continue;
      }
      const key = archivedProjectGroupKey(environmentId, thread.projectId);
      const projectThreads = threadsByEnvironmentAndProjectId.get(key);
      const archivedThread = {
        ...thread,
        environmentId,
        normalizedTitle,
        searchScore,
      };
      if (projectThreads) {
        projectThreads.push(archivedThread);
      } else {
        threadsByEnvironmentAndProjectId.set(key, [archivedThread]);
      }
    }
  }

  const groups: ArchivedThreadGroup[] = [];
  for (const [projectKey, project] of projectsByEnvironmentAndId.entries()) {
    const projectThreads = threadsByEnvironmentAndProjectId.get(projectKey);
    if (projectThreads && projectThreads.length > 0) {
      const searchScore = projectThreads.reduce(
        (minimumScore, thread) => Math.min(minimumScore, thread.searchScore),
        Number.POSITIVE_INFINITY,
      );
      groups.push({
        key: projectKey,
        project,
        threads: projectThreads.toSorted((left, right) =>
          input.isSearching
            ? left.searchScore - right.searchScore ||
              compareArchivedThreads(left, right, input.sort)
            : compareArchivedThreads(left, right, input.sort),
        ),
        searchScore,
      });
    }
  }
  return input.isSearching
    ? groups.toSorted(
        (left, right) =>
          left.searchScore - right.searchScore ||
          left.project.name.localeCompare(right.project.name),
      )
    : groups;
}

function collapseOtelSignalsUrl(input: {
  readonly tracesUrl: string;
  readonly metricsUrl: string;
}): string | null {
  const tracesSuffix = "/traces";
  const metricsSuffix = "/metrics";
  if (!input.tracesUrl.endsWith(tracesSuffix) || !input.metricsUrl.endsWith(metricsSuffix)) {
    return null;
  }

  const tracesBase = input.tracesUrl.slice(0, -tracesSuffix.length);
  const metricsBase = input.metricsUrl.slice(0, -metricsSuffix.length);
  if (tracesBase !== metricsBase) {
    return null;
  }

  return `${tracesBase}/{traces,metrics}`;
}

export function formatDiagnosticsDescription(input: {
  readonly localTracingEnabled: boolean;
  readonly otlpTracesEnabled: boolean;
  readonly otlpTracesUrl?: string | undefined;
  readonly otlpMetricsEnabled: boolean;
  readonly otlpMetricsUrl?: string | undefined;
}): string {
  const mode = input.localTracingEnabled ? "Local trace file" : "Terminal logs only";
  const tracesUrl = input.otlpTracesEnabled ? input.otlpTracesUrl : undefined;
  const metricsUrl = input.otlpMetricsEnabled ? input.otlpMetricsUrl : undefined;

  if (tracesUrl && metricsUrl) {
    const collapsedUrl = collapseOtelSignalsUrl({ tracesUrl, metricsUrl });
    return collapsedUrl
      ? `${mode}. Exporting OTEL to ${collapsedUrl}.`
      : `${mode}. Exporting OTEL traces to ${tracesUrl} and metrics to ${metricsUrl}.`;
  }

  if (tracesUrl) {
    return `${mode}. Exporting OTEL traces to ${tracesUrl}.`;
  }

  if (metricsUrl) {
    return `${mode}. Exporting OTEL metrics to ${metricsUrl}.`;
  }

  return `${mode}.`;
}

export function buildProviderInstanceUpdatePatch(input: {
  readonly settings: Pick<ServerSettings, "providers" | "providerInstances">;
  readonly instanceId: ProviderInstanceId;
  readonly instance: ProviderInstanceConfig;
  readonly driver: ProviderDriverKind;
  readonly isDefault: boolean;
  readonly textGenerationModelSelection?:
    | ServerSettings["textGenerationModelSelection"]
    | undefined;
}): Partial<UnifiedSettings> {
  type LegacyProviderSettings = ServerSettings["providers"][keyof ServerSettings["providers"]];
  const legacyProviderDefaults = DEFAULT_UNIFIED_SETTINGS.providers as Record<
    string,
    LegacyProviderSettings | undefined
  >;
  const legacyProviderDefault = input.isDefault ? legacyProviderDefaults[input.driver] : undefined;
  return {
    ...(legacyProviderDefault !== undefined
      ? {
          providers: {
            ...input.settings.providers,
            [input.driver]: legacyProviderDefault,
          } as ServerSettings["providers"],
        }
      : {}),
    providerInstances: {
      ...input.settings.providerInstances,
      [input.instanceId]: input.instance,
    },
    ...(input.textGenerationModelSelection !== undefined
      ? { textGenerationModelSelection: input.textGenerationModelSelection }
      : {}),
  };
}
