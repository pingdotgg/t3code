/**
 * Multi-environment usage state.
 *
 * Every connected environment answers the same typed query; the client merges
 * the results. Raw transcripts never leave the machine that produced them.
 *
 * Mirror of `apps/web/src/state/usage.ts` over mobile's atom wiring; the merge
 * rules themselves live in `@t3tools/shared/usageMerge`.
 *
 * @module state/usage
 */
import { useAtomValue } from "@effect/atom-react";
import {
  USAGE_CONTRACT_VERSION,
  type EnvironmentId,
  type UsageSummary,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import {
  mergeUsage,
  retainUsageStatuses,
  usageRefreshTargets,
  type EnvironmentUsage,
  type MergedUsage,
  type SettledUsageStatuses,
} from "@t3tools/shared/usageMerge";
import { refreshUsage } from "@t3tools/client-runtime/state/usage";
import {
  completeUsageRefresh,
  refreshStateForWindowChange,
  startUsageRefresh,
  type UsageRefreshState,
} from "@t3tools/shared/usageRefreshState";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { environmentPresentations } from "./presentation";
import { uuidv4 } from "../lib/uuid";
import { appAtomRegistry } from "./atom-registry";
import { serverEnvironment } from "./server";

export interface EnvironmentUsageStatus {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly isPending: boolean;
  readonly isConnected: boolean;
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
        isConnected: presentation.connection.phase === "connected",
        error: result._tag === "Failure" ? "This environment could not report usage." : null,
        summary: Option.getOrNull(AsyncResult.value(result)),
      });
    }
    return statuses;
  }).pipe(Atom.withLabel(`mobile-usage:window:${windowKey}`)),
);

export interface UsageView {
  readonly merged: MergedUsage;
  readonly environments: readonly EnvironmentUsageStatus[];
  readonly selectedEnvironments: readonly EnvironmentUsageStatus[];
  /** True until at least one environment has answered. */
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
  readonly refresh: (requestedInput?: UsageSummaryInput) => Promise<void>;
}

export function useUsage(
  input: UsageSummaryInput,
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
  const atom = usageByWindowAtom(windowKey);
  const currentEnvironments = useAtomValue(atom);
  const settledStatuses = useRef<SettledUsageStatuses<EnvironmentUsageStatus> | null>(null);
  const retained = retainUsageStatuses(rangeKey, currentEnvironments, settledStatuses.current);
  useEffect(() => {
    settledStatuses.current = retained.settled;
  }, [retained.settled]);
  const environments = retained.visible;
  const selectedEnvironments = useMemo(
    () =>
      selectedEnvironmentIds === null
        ? environments
        : environments.filter(({ environmentId }) => selectedEnvironmentIds.has(environmentId)),
    [environments, selectedEnvironmentIds],
  );
  const viewKey = JSON.stringify([
    rangeKey,
    selectedEnvironmentIds === null ? null : [...selectedEnvironmentIds].toSorted(),
  ]);
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
  const [manualRefreshState, setManualRefreshState] = useState<UsageRefreshState>({
    windowKey: viewKey,
    requestId: 0,
    refreshing: false,
    error: null as string | null,
  });
  const currentRefreshId = useRef(0);
  const pendingRefreshWindowKey = useRef(viewKey);
  useEffect(() => {
    // A refresh started while selecting the next window already targets this
    // committed key. Keep its request id and state so the completion can settle
    // after React commits the selection.
    const nextState = refreshStateForWindowChange(
      manualRefreshState,
      viewKey,
      pendingRefreshWindowKey.current,
    );
    if (nextState === manualRefreshState) return;
    // A refresh belongs to one window. Invalidate its completion and clear the
    // state so switching away and back cannot resurrect an old spinner/error.
    currentRefreshId.current = nextState.requestId;
    pendingRefreshWindowKey.current = viewKey;
    setManualRefreshState(nextState);
  }, [manualRefreshState, viewKey]);

  // Explicit refresh is a server command, so it really rescans and publishes
  // a new last-good snapshot. The normal query remains snapshot-only.
  const refresh = useCallback(
    async (requestedInput?: UsageSummaryInput) => {
      const refreshEnvironments = usageRefreshTargets(selectedEnvironments);
      if (refreshEnvironments.length === 0) return;
      const input = requestedInput ?? (JSON.parse(rangeKey) as UsageSummaryInput);
      const requestRangeKey =
        requestedInput === undefined
          ? rangeKey
          : JSON.stringify({
              sinceDay: input.sinceDay,
              untilDay: input.untilDay,
              timeZone: input.timeZone,
              resolution: input.resolution,
              sinceTime: input.sinceTime,
              untilTime: input.untilTime,
            });
      const requestWindowKey = JSON.stringify([
        requestRangeKey,
        selectedEnvironmentIds === null ? null : [...selectedEnvironmentIds].toSorted(),
      ]);
      const nextRefreshState = startUsageRefresh(currentRefreshId.current, requestWindowKey);
      const requestId = nextRefreshState.requestId;
      currentRefreshId.current = requestId;
      pendingRefreshWindowKey.current = requestWindowKey;
      setManualRefreshState(nextRefreshState);
      let error: string | null = null;
      try {
        await refreshUsage({
          registry: appAtomRegistry,
          server: serverEnvironment,
          presentations: environmentPresentations,
          environmentIds: refreshEnvironments.map(({ environmentId }) => environmentId),
          contractVersions: new Map(
            refreshEnvironments.map((e) => [e.environmentId, e.summary?.contractVersion ?? 0]),
          ),
          input,
          refreshToken: uuidv4(),
        });
      } catch {
        error = "Refresh failed. Showing the last successful usage snapshot.";
      }
      const nextState = completeUsageRefresh(
        pendingRefreshWindowKey.current,
        currentRefreshId.current,
        requestWindowKey,
        requestId,
        error,
      );
      if (nextState !== null) setManualRefreshState(nextState);
    },
    [selectedEnvironments, selectedEnvironmentIds, rangeKey],
  );

  const merged = useMemo(() => mergeUsage(answered, USAGE_CONTRACT_VERSION), [answered]);

  const answeredCount = selectedEnvironments.filter(
    (environment) => environment.summary !== null,
  ).length;
  const stillReporting = selectedEnvironments.filter(
    (environment) => environment.summary === null && environment.error === null,
  ).length;
  const isRefreshing =
    selectedEnvironments.some(
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
