/**
 * Multi-environment usage state.
 *
 * Every connected environment answers the same typed query; the client merges
 * the results. Raw transcripts never leave the machine that produced them.
 *
 * @module state/usage
 */
import { useAtomValue } from "@effect/atom-react";
import {
  USAGE_CONTRACT_VERSION,
  USAGE_EXPLICIT_REFRESH_SINCE,
  USAGE_THREAD_BREAKDOWN_SINCE,
  type EnvironmentId,
  type UsageSummary,
  type UsageSummaryInput,
  type UsageProviderKind,
  type UsageThreadBreakdown,
  type UsageThreadBreakdownInput,
  type UsageThreadRow,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  completeUsageRefresh,
  refreshStateForWindowChange,
  startUsageRefresh,
  type UsageRefreshState,
} from "@t3tools/shared/usageRefreshState";
import {
  makeUsageRefreshToken,
  mergeUsage,
  projectFilterForEnvironment,
  retainUsageStatuses,
  usageRefreshTargets,
  type EnvironmentProviderContribution,
  type EnvironmentUsage,
  type MergedUsage,
  type SettledUsageStatuses,
} from "@t3tools/shared/usageMerge";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import { randomUUID } from "../lib/utils";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentPresentations } from "./presentation";
import { serverEnvironment } from "./server";
import { useAtomCommand } from "./use-atom-command";

export interface EnvironmentUsageStatus {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly isPending: boolean;
  readonly error: string | null;
  readonly summary: UsageSummary | null;
}

/**
 * Reads every environment's summary for one window.
 *
 * Keyed by the serialised window so switching ranges does not thrash the atom
 * cache, and so each environment's query is shared with any other reader of the
 * same window.
 */
const usageByWindowAtom = Atom.family((windowKey: string) =>
  Atom.make((get): readonly EnvironmentUsageStatus[] => {
    const input = JSON.parse(windowKey) as UsageSummaryInput;
    const presentations = get(environmentPresentations.presentationsAtom);

    const statuses: EnvironmentUsageStatus[] = [];
    for (const [environmentId, presentation] of presentations) {
      const result = get(serverEnvironment.usageSummary({ environmentId, input }));
      statuses.push({
        environmentId,
        label: presentation.entry.target.label,
        isPending: result.waiting,
        error: result._tag === "Failure" ? "This environment could not report usage." : null,
        summary: Option.getOrNull(AsyncResult.value(result)),
      });
    }
    return statuses;
  }).pipe(Atom.withLabel(`web-usage:window:${windowKey}`)),
);

export interface UsageView {
  readonly merged: MergedUsage;
  readonly environments: readonly EnvironmentUsageStatus[];
  readonly selectedEnvironments: readonly EnvironmentUsageStatus[];
  /** True until at least one selected environment has answered. */
  readonly isPending: boolean;
  /**
   * True while environments that have not failed are still answering. Failed
   * environments are reported through their own error rows: totals will not
   * improve by waiting on them, so they must not read as "still reporting".
   */
  readonly isPartial: boolean;
  /** True while a previously loaded snapshot is being refreshed. */
  readonly isRefreshing: boolean;
  readonly refreshError?: string | null;
  readonly refresh: (requestedInput?: UsageSummaryInput) => void;
}

export function filterUsageEnvironmentsForProject<
  T extends { readonly environmentId: EnvironmentId },
>(environments: readonly T[], projectFilter: string | null | undefined): readonly T[] {
  return environments.filter(
    (environment) =>
      projectFilterForEnvironment(projectFilter, environment.environmentId) !==
      "environment-mismatch:",
  );
}

function usageViewScopeKey(
  rangeKey: string,
  projectFilter: string | null | undefined,
  selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null,
): string {
  return JSON.stringify({
    rangeKey,
    projectScope:
      projectFilter === undefined
        ? ["all"]
        : projectFilter === null
          ? ["outside"]
          : ["project", projectFilter],
    environmentScope:
      selectedEnvironmentIds === null ? ["all"] : [...selectedEnvironmentIds].toSorted(),
  });
}

export function useUsage(
  input: UsageSummaryInput,
  /** A namespaced project key, `null` for outside-projects buckets, `undefined` for no filter. */
  projectFilter?: string | null,
  /** Refresh the deferred thread query only while its table is mounted. */
  refreshThreads = false,
  selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null = null,
): UsageView {
  const rangeKey = useMemo(
    () =>
      JSON.stringify({
        sinceDay: input.sinceDay,
        untilDay: input.untilDay,
        timeZone: input.timeZone,
        resolution: input.resolution,
        sinceTime: input.sinceTime,
        untilTime: input.untilTime,
      }),
    [
      input.sinceDay,
      input.untilDay,
      input.timeZone,
      input.resolution,
      input.sinceTime,
      input.untilTime,
    ],
  );
  const windowKey = rangeKey;
  const viewKey = useMemo(
    () => usageViewScopeKey(rangeKey, projectFilter, selectedEnvironmentIds),
    [projectFilter, rangeKey, selectedEnvironmentIds],
  );
  const atom = usageByWindowAtom(windowKey);
  const currentEnvironments = useAtomValue(atom);
  const settledStatuses = useRef<SettledUsageStatuses<EnvironmentUsageStatus> | null>(null);
  const retained = retainUsageStatuses(rangeKey, currentEnvironments, settledStatuses.current);
  settledStatuses.current = retained.settled;
  const environments = retained.visible;
  const selectedEnvironments = useMemo(
    () =>
      selectedEnvironmentIds === null
        ? environments
        : environments.filter((environment) =>
            selectedEnvironmentIds.has(environment.environmentId),
          ),
    [environments, selectedEnvironmentIds],
  );
  const answered = useMemo<readonly EnvironmentUsage[]>(
    () =>
      selectedEnvironments.flatMap((environment) =>
        environment.summary === null
          ? []
          : [
              {
                environmentId: environment.environmentId,
                label: environment.label,
                summary: environment.summary,
              },
            ],
      ),
    [selectedEnvironments],
  );
  const merged = useMemo(
    () =>
      mergeUsage(
        answered,
        USAGE_CONTRACT_VERSION,
        projectFilter === undefined ? undefined : { projectFilter },
      ),
    [answered, projectFilter],
  );

  const refreshUsageSummary = useAtomCommand(serverEnvironment.refreshUsageSummary, {
    reportFailure: false,
  });
  const refreshUsageRates = useAtomCommand(serverEnvironment.refreshUsageRates, {
    reportFailure: false,
  });
  const [manualRefreshState, setManualRefreshState] = useState<UsageRefreshState>({
    windowKey: viewKey,
    requestId: 0,
    refreshing: false,
    error: null,
  });
  const currentViewKey = useRef(viewKey);
  const currentRefreshId = useRef(0);
  const pendingRefreshViewKey = useRef(viewKey);
  useEffect(() => {
    currentViewKey.current = viewKey;
  }, [viewKey]);
  useEffect(() => {
    const nextState = refreshStateForWindowChange(
      manualRefreshState,
      viewKey,
      pendingRefreshViewKey.current,
    );
    if (nextState === manualRefreshState) return;
    currentRefreshId.current = nextState.requestId;
    pendingRefreshViewKey.current = viewKey;
    setManualRefreshState(nextState);
  }, [manualRefreshState, viewKey]);

  const refresh = useCallback(
    (requestedInput?: UsageSummaryInput) => {
      const refreshEnvironments = usageRefreshTargets(
        filterUsageEnvironmentsForProject(selectedEnvironments, projectFilter),
      );
      if (refreshEnvironments.length === 0) return;
      const requestInput = requestedInput ?? (JSON.parse(rangeKey) as UsageSummaryInput);
      const requestRangeKey =
        requestedInput === undefined
          ? rangeKey
          : JSON.stringify({
              sinceDay: requestInput.sinceDay,
              untilDay: requestInput.untilDay,
              timeZone: requestInput.timeZone,
              resolution: requestInput.resolution,
              sinceTime: requestInput.sinceTime,
              untilTime: requestInput.untilTime,
            });
      const requestViewKey = usageViewScopeKey(
        requestRangeKey,
        projectFilter,
        selectedEnvironmentIds,
      );
      const nextRefreshState = startUsageRefresh(currentRefreshId.current, requestViewKey);
      const requestId = nextRefreshState.requestId;
      currentRefreshId.current = requestId;
      pendingRefreshViewKey.current = requestViewKey;
      setManualRefreshState(nextRefreshState);

      const legacyOrUnknown = refreshEnvironments.filter(
        (environment) => (environment.summary?.contractVersion ?? 0) < USAGE_EXPLICIT_REFRESH_SINCE,
      );
      const legacyAnswered = legacyOrUnknown.flatMap((environment) =>
        environment.summary === null
          ? []
          : [
              {
                environmentId: environment.environmentId,
                label: environment.label,
                summary: environment.summary,
              },
            ],
      );
      const refreshToken = JSON.stringify([
        makeUsageRefreshToken(legacyAnswered) ?? "unknown",
        randomUUID(),
      ]);
      const environmentsAfterRates = refreshEnvironments.map(async (environment) => {
        await Promise.allSettled([
          refreshUsageRates({ environmentId: environment.environmentId, input: {} }),
        ]);
        return environment;
      });
      const summaryRefreshes = environmentsAfterRates.map(async (environmentAfterRates) => {
        const environment = await environmentAfterRates;
        let result;
        if ((environment.summary?.contractVersion ?? 0) < USAGE_EXPLICIT_REFRESH_SINCE) {
          const refreshed = await executeAtomQuery(
            appAtomRegistry,
            serverEnvironment.usageSummary({
              environmentId: environment.environmentId,
              input: { ...requestInput, refreshToken },
            }),
            { reportFailure: false, refresh: true },
          );
          if (refreshed._tag === "Failure") {
            result = refreshed;
          } else {
            const baseAtom = serverEnvironment.usageSummary({
              environmentId: environment.environmentId,
              input: requestInput,
            });
            if (appAtomRegistry.get(baseAtom).waiting) {
              await executeAtomQuery(appAtomRegistry, baseAtom, {
                reportFailure: false,
              });
            }
            result = await executeAtomQuery(appAtomRegistry, baseAtom, {
              reportFailure: false,
              refresh: true,
            });
          }
        } else {
          result = await refreshUsageSummary({
            environmentId: environment.environmentId,
            input: requestInput,
          });
        }

        if (refreshThreads) {
          for (const contribution of filterProviderContributionsForProject(
            projectFilter,
            merged.providerContributions,
          )) {
            if (
              contribution.environmentId !== environment.environmentId ||
              contribution.contractVersion < USAGE_THREAD_BREAKDOWN_SINCE
            ) {
              continue;
            }
            appAtomRegistry.refresh(
              serverEnvironment.usageThreadBreakdown({
                environmentId: contribution.environmentId,
                input: makeThreadBreakdownInput(
                  requestInput,
                  projectFilter,
                  contribution.providers,
                  contribution.environmentId,
                ),
              }),
            );
          }
        }
        return result;
      });

      void Promise.all(summaryRefreshes)
        .then((results) => {
          const nextState = completeUsageRefresh(
            currentViewKey.current,
            currentRefreshId.current,
            requestViewKey,
            requestId,
            results.some((result) => result._tag === "Failure")
              ? "Refresh failed. Showing the last successful usage snapshot."
              : null,
          );
          if (nextState !== null) setManualRefreshState(nextState);
        })
        .catch(() => {
          const nextState = completeUsageRefresh(
            currentViewKey.current,
            currentRefreshId.current,
            requestViewKey,
            requestId,
            "Refresh failed. Showing the last successful usage snapshot.",
          );
          if (nextState !== null) setManualRefreshState(nextState);
        });
    },
    [
      merged.providerContributions,
      projectFilter,
      rangeKey,
      refreshThreads,
      refreshUsageRates,
      refreshUsageSummary,
      selectedEnvironmentIds,
      selectedEnvironments,
    ],
  );

  const relevantEnvironments = filterUsageEnvironmentsForProject(
    selectedEnvironments,
    projectFilter,
  );
  const answeredCount = relevantEnvironments.filter(
    (environment) => environment.summary !== null,
  ).length;
  const stillReporting = relevantEnvironments.filter(
    (environment) => environment.summary === null && environment.error === null,
  ).length;
  const isRefreshing =
    relevantEnvironments.some(
      (environment) => environment.isPending && environment.summary !== null,
    ) ||
    (manualRefreshState.windowKey === viewKey && manualRefreshState.refreshing);

  return {
    merged,
    environments,
    selectedEnvironments,
    isPending: answeredCount === 0 && stillReporting > 0,
    isPartial: answeredCount > 0 && stillReporting > 0,
    isRefreshing,
    refreshError: manualRefreshState.windowKey === viewKey ? manualRefreshState.error : null,
    refresh,
  };
}

export interface UsageThreadRowWithEnvironment extends UsageThreadRow {
  /** Environment that reported the row; thread deep links are environment-scoped. */
  readonly environmentId: EnvironmentId;
}

export interface UsageThreadsView {
  readonly rows: readonly UsageThreadRowWithEnvironment[];
  readonly truncatedRows: number;
  /** True until every listed environment answered or failed. */
  readonly isPending: boolean;
  readonly failedEnvironments: number;
}

export interface EnvironmentUsageThreadBreakdown {
  readonly environmentId: EnvironmentId;
  readonly breakdown: UsageThreadBreakdown;
}

export function makeThreadBreakdownInput(
  input: UsageSummaryInput,
  projectFilter: string | null | undefined,
  providers: readonly UsageProviderKind[],
  environmentId: EnvironmentId,
): UsageThreadBreakdownInput {
  return {
    sinceDay: input.sinceDay,
    untilDay: input.untilDay,
    timeZone: input.timeZone,
    ...(input.sinceTime === undefined ? {} : { sinceTime: input.sinceTime }),
    ...(input.untilTime === undefined ? {} : { untilTime: input.untilTime }),
    ...(projectFilter === undefined
      ? {}
      : { projectKey: projectFilterForEnvironment(projectFilter, environmentId) }),
    providers: [...providers],
  };
}

function withOwnedProviders(
  input: UsageThreadBreakdownInput,
  providers: readonly UsageProviderKind[],
): UsageThreadBreakdownInput {
  return { ...input, providers: [...providers] };
}

/** Applies the summary's physical-source ownership to thread rows. */
export function mergeUsageThreadBreakdowns(
  environments: readonly EnvironmentUsageThreadBreakdown[],
  providerContributions: readonly EnvironmentProviderContribution[],
): Pick<UsageThreadsView, "rows" | "truncatedRows"> {
  const providersByEnvironment = new Map(
    providerContributions.map((entry) => [entry.environmentId, new Set(entry.providers)]),
  );
  const rows: UsageThreadRowWithEnvironment[] = [];
  let truncatedRows = 0;

  for (const environment of environments) {
    const ownedProviders = providersByEnvironment.get(environment.environmentId);
    if (ownedProviders === undefined) continue;
    for (const row of environment.breakdown.rows) {
      if (!ownedProviders.has(row.provider)) continue;
      rows.push({ ...row, environmentId: environment.environmentId });
      truncatedRows += row.groupedRows ?? 0;
    }
  }
  rows.sort((a, b) => b.costUsd - a.costUsd);
  return { rows, truncatedRows };
}

/** Excludes environments that cannot own a namespaced project selection. */
export function filterProviderContributionsForProject(
  projectKey: string | null | undefined,
  providerContributions: readonly EnvironmentProviderContribution[],
): readonly EnvironmentProviderContribution[] {
  if (projectKey === undefined || projectKey === null) return providerContributions;
  return providerContributions.filter(
    (contribution) =>
      projectFilterForEnvironment(projectKey, contribution.environmentId) !==
      "environment-mismatch:",
  );
}

const usageThreadsAtom = Atom.family((requestKey: string) =>
  Atom.make((get): UsageThreadsView => {
    const { input, providerContributions } = JSON.parse(requestKey) as {
      input: UsageThreadBreakdownInput;
      providerContributions: readonly EnvironmentProviderContribution[];
    };

    const relevantContributions = filterProviderContributionsForProject(
      input.projectKey,
      providerContributions,
    );
    const breakdowns: EnvironmentUsageThreadBreakdown[] = [];
    let pending = 0;
    let failed = relevantContributions.filter(
      (contribution) => contribution.contractVersion < USAGE_THREAD_BREAKDOWN_SINCE,
    ).length;
    for (const contribution of relevantContributions) {
      if (contribution.contractVersion < USAGE_THREAD_BREAKDOWN_SINCE) continue;
      const { environmentId } = contribution;
      const environmentInput =
        input.projectKey === undefined
          ? input
          : {
              ...input,
              projectKey: projectFilterForEnvironment(input.projectKey, environmentId),
            };
      const result = get(
        serverEnvironment.usageThreadBreakdown({
          environmentId,
          input: withOwnedProviders(environmentInput, contribution.providers),
        }),
      );
      if (result.waiting) pending += 1;
      if (result._tag === "Failure") failed += 1;
      const breakdown = Option.getOrNull(AsyncResult.value(result));
      if (breakdown === null) continue;
      breakdowns.push({ environmentId, breakdown });
    }
    const merged = mergeUsageThreadBreakdowns(breakdowns, relevantContributions);

    return { ...merged, isPending: pending > 0, failedEnvironments: failed };
  }).pipe(Atom.withLabel(`web-usage:threads:${requestKey}`)),
);

/**
 * Thread drill-down across the environments that contributed to the summary.
 * Mount the consuming component only while the thread view is open; fetching
 * starts on first read.
 */
export function useUsageThreads(
  input: UsageThreadBreakdownInput,
  providerContributions: readonly EnvironmentProviderContribution[],
): UsageThreadsView {
  const requestKey = useMemo(
    () => JSON.stringify({ input, providerContributions }),
    [input, providerContributions],
  );
  return useAtomValue(usageThreadsAtom(requestKey));
}
