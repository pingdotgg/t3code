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
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import {
  makeUsageRefreshToken,
  mergeUsage,
  retainUsageStatuses,
  type EnvironmentUsage,
  type MergedUsage,
  type SettledUsageStatuses,
} from "@t3tools/shared/usageMerge";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useMemo, useRef, useState } from "react";

import { appAtomRegistry } from "./atom-registry";
import { environmentPresentations } from "./presentation";
import { serverEnvironment } from "./server";

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
    () =>
      JSON.stringify({
        sinceDay: input.sinceDay,
        untilDay: input.untilDay,
        timeZone: input.timeZone,
        resolution: input.resolution,
        sinceTime: input.sinceTime,
        untilTime: input.untilTime,
        refreshToken,
      }),
    [
      input.sinceDay,
      input.untilDay,
      input.timeZone,
      input.resolution,
      input.sinceTime,
      input.untilTime,
      refreshToken,
    ],
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

  // Refreshing only the derived atom would re-read the per-environment SWR
  // queries within their stale window and change nothing. Refresh each
  // environment's query so pull-to-refresh always rescans.
  //
  // Each environment refetches model pricing first, so a model released since
  // its last daily fetch gets priced by the rescan. The rescan runs whether or
  // not the refetch succeeds: an offline environment still recounts tokens.
  const refresh = useCallback(
    (requestedInput?: UsageSummaryInput) => {
      const nextToken = makeUsageRefreshToken(answered);
      const currentInput =
        requestedInput === undefined
          ? (JSON.parse(windowKey) as UsageSummaryInput)
          : { ...requestedInput, refreshToken };
      const rateRefreshes = environments.map(({ environmentId }) =>
        runAtomCommand(
          appAtomRegistry,
          serverEnvironment.refreshUsageRates,
          { environmentId, input: {} },
          { reportFailure: false },
        ),
      );
      void Promise.allSettled(rateRefreshes).then(() => {
        if (nextToken !== undefined && nextToken !== refreshToken) {
          setRefreshToken(nextToken);
          return;
        }
        for (const { environmentId } of environments) {
          appAtomRegistry.refresh(
            serverEnvironment.usageSummary({ environmentId, input: currentInput }),
          );
        }
      });
    },
    [answered, environments, refreshToken, windowKey],
  );

  const merged = useMemo(() => mergeUsage(answered, USAGE_CONTRACT_VERSION), [answered]);

  const answeredCount = environments.filter((environment) => environment.summary !== null).length;
  const stillReporting = environments.filter(
    (environment) => environment.summary === null && environment.error === null,
  ).length;

  return {
    merged,
    environments,
    isPending: answeredCount === 0 && stillReporting > 0,
    isPartial: answeredCount > 0 && stillReporting > 0,
    refresh,
  };
}
