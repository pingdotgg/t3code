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
  USAGE_EXPLICIT_REFRESH_SINCE,
  type EnvironmentId,
  type UsageSummary,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import {
  makeUsageRefreshToken,
  mergeUsage,
  retainUsageStatuses,
  usageRefreshTargets,
  type EnvironmentUsage,
  type MergedUsage,
  type SettledUsageStatuses,
} from "@t3tools/shared/usageMerge";
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
import { appAtomRegistry } from "./atom-registry";
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
  }).pipe(Atom.withLabel(`mobile-usage:window:${windowKey}`)),
);

export interface UsageView {
  readonly merged: MergedUsage;
  readonly environments: readonly EnvironmentUsageStatus[];
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
  readonly refresh: (requestedInput?: UsageSummaryInput) => void;
}

export function useUsage(input: UsageSummaryInput): UsageView {
  const [refreshToken, setRefreshToken] = useState<string>();
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
  const windowKey = useMemo(
    () => JSON.stringify({ ...JSON.parse(rangeKey), refreshToken }),
    [rangeKey, refreshToken],
  );
  const atom = usageByWindowAtom(windowKey);
  const currentEnvironments = useAtomValue(atom);
  const settledStatuses = useRef<SettledUsageStatuses<EnvironmentUsageStatus> | null>(null);
  const retained = retainUsageStatuses(rangeKey, currentEnvironments, settledStatuses.current);
  settledStatuses.current = retained.settled;
  const environments = retained.visible;
  const answered = useMemo<readonly EnvironmentUsage[]>(
    () =>
      environments.flatMap((environment) =>
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
    [environments],
  );
  const refreshUsageSummary = useAtomCommand(serverEnvironment.refreshUsageSummary, {
    reportFailure: false,
  });
  const refreshUsageRates = useAtomCommand(serverEnvironment.refreshUsageRates, {
    reportFailure: false,
  });
  const [manualRefreshState, setManualRefreshState] = useState<UsageRefreshState>({
    windowKey: rangeKey,
    requestId: 0,
    refreshing: false,
    error: null as string | null,
  });
  const currentWindowKey = useRef(rangeKey);
  const currentRefreshId = useRef(0);
  const pendingRefreshWindowKey = useRef(rangeKey);
  useEffect(() => {
    currentWindowKey.current = rangeKey;
  }, [rangeKey]);
  useEffect(() => {
    // A refresh started while selecting the next window already targets this
    // committed key. Keep its request id and state so the completion can settle
    // after React commits the selection.
    const nextState = refreshStateForWindowChange(
      manualRefreshState,
      rangeKey,
      pendingRefreshWindowKey.current,
    );
    if (nextState === manualRefreshState) return;
    // A refresh belongs to one window. Invalidate its completion and clear the
    // state so switching away and back cannot resurrect an old spinner/error.
    currentRefreshId.current = nextState.requestId;
    pendingRefreshWindowKey.current = rangeKey;
    setManualRefreshState(nextState);
  }, [manualRefreshState, rangeKey]);

  // Explicit refresh is a server command, so it really rescans and publishes
  // a new last-good snapshot. The normal query remains snapshot-only.
  const refresh = useCallback(
    (requestedInput?: UsageSummaryInput) => {
      const refreshEnvironments = usageRefreshTargets(environments);
      if (refreshEnvironments.length === 0) return;
      const input = requestedInput ?? (JSON.parse(rangeKey) as UsageSummaryInput);
      const requestWindowKey =
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
      const nextRefreshState = startUsageRefresh(currentRefreshId.current, requestWindowKey);
      const requestId = nextRefreshState.requestId;
      currentRefreshId.current = requestId;
      pendingRefreshWindowKey.current = requestWindowKey;
      setManualRefreshState(nextRefreshState);
      void Promise.allSettled(
        refreshEnvironments.map((environment) =>
          refreshUsageRates({ environmentId: environment.environmentId, input: {} }),
        ),
      )
        .then(() => {
          const explicitRefreshes = refreshEnvironments.flatMap((environment) =>
            (environment.summary?.contractVersion ?? 0) < USAGE_EXPLICIT_REFRESH_SINCE
              ? []
              : [refreshUsageSummary({ environmentId: environment.environmentId, input })],
          );
          const legacyOrUnknown = refreshEnvironments.filter(
            (environment) =>
              (environment.summary?.contractVersion ?? 0) < USAGE_EXPLICIT_REFRESH_SINCE,
          );
          const legacyAnswered = refreshEnvironments.flatMap((environment) =>
            environment.summary !== null &&
            environment.summary.contractVersion < USAGE_EXPLICIT_REFRESH_SINCE
              ? [
                  {
                    environmentId: environment.environmentId,
                    label: environment.label,
                    summary: environment.summary,
                  },
                ]
              : [],
          );
          const nextToken = makeUsageRefreshToken(legacyAnswered);
          if (legacyOrUnknown.length > 0) {
            if (nextToken !== undefined && nextToken !== refreshToken) {
              setRefreshToken(nextToken);
            } else {
              for (const environment of legacyOrUnknown) {
                appAtomRegistry.refresh(
                  serverEnvironment.usageSummary({
                    environmentId: environment.environmentId,
                    input: { ...input, refreshToken },
                  }),
                );
              }
            }
          }
          return Promise.all(explicitRefreshes);
        })
        .then((results) => {
          const nextState = completeUsageRefresh(
            currentWindowKey.current,
            currentRefreshId.current,
            requestWindowKey,
            requestId,
            results.some((result) => result._tag === "Failure")
              ? "Refresh failed. Showing the last successful usage snapshot."
              : null,
          );
          if (nextState !== null) setManualRefreshState(nextState);
        })
        .catch(() => {
          const nextState = completeUsageRefresh(
            currentWindowKey.current,
            currentRefreshId.current,
            requestWindowKey,
            requestId,
            "Refresh failed. Showing the last successful usage snapshot.",
          );
          if (nextState !== null) setManualRefreshState(nextState);
        });
    },
    [answered, environments, rangeKey, refreshToken, refreshUsageRates, refreshUsageSummary],
  );

  const merged = useMemo(() => mergeUsage(answered, USAGE_CONTRACT_VERSION), [answered]);

  const answeredCount = environments.filter((environment) => environment.summary !== null).length;
  const stillReporting = environments.filter(
    (environment) => environment.summary === null && environment.error === null,
  ).length;
  const isRefreshing =
    environments.some((environment) => environment.isPending && environment.summary !== null) ||
    (manualRefreshState.windowKey === rangeKey && manualRefreshState.refreshing);

  return {
    merged,
    environments,
    isPending: answeredCount === 0 && stillReporting > 0,
    isPartial: answeredCount > 0 && stillReporting > 0,
    isRefreshing,
    refreshError: manualRefreshState.windowKey === rangeKey ? manualRefreshState.error : null,
    refresh,
  };
}
